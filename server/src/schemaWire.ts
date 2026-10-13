/**
 * Unpacking of the staged schema payloads sent by the extension host.
 *
 * The client deliberately does not build one object per column: columns,
 * foreign key mappings and routine parameters arrive as a single packed string
 * per parent object, aggregated by `STRING_AGG` on the database server. This
 * module is the only place that turns them into the objects the completion
 * engine works with, so a column is materialised exactly once for the whole
 * pipeline instead of four times.
 *
 * The mirror image of this file is `client/src/schema/wireFormat.ts`, which also
 * documents the format. The two must agree on the separators and on the field
 * order — change one, change both.
 */

import {
    ColumnInfo,
    ForeignKeyInfo,
    ForeignKeyMapping,
    RoutineParameterInfo,
    RoutineSnapshot,
    TableInfo,
} from './schemaLoader';

/** Separator between records. ASCII 30. */
const RECORD_SEPARATOR = '\u001e';
/** Separator between the fields of a record. ASCII 31. */
const FIELD_SEPARATOR = '\u001f';

const COLUMN_FLAG_NULLABLE = 1;
const COLUMN_FLAG_PRIMARY_KEY = 2;
const COLUMN_FLAG_IDENTITY = 4;
const COLUMN_FLAG_COMPUTED = 8;
const COLUMN_FLAG_HAS_DEFAULT = 16;

const PARAM_FLAG_OUTPUT = 1;
const PARAM_FLAG_HAS_DEFAULT = 2;

// ── Payload shapes (mirrors of the client's wire types) ───────────────────────

export interface WireObject {
    s: string;
    n: string;
    t: string;
}

export interface WireColumns {
    s: string;
    n: string;
    c: string;
}

export interface WireForeignKey {
    k: string;
    ps: string;
    pt: string;
    rs: string;
    rt: string;
    m: string;
}

export interface WireRoutine {
    s: string;
    n: string;
    t: string;
    p: string;
}

// ── Field readers ─────────────────────────────────────────────────────────────

/** Parses a packed numeric field; an empty field means "not applicable". */
function toNumber(field: string | undefined): number | null {
    if (!field) return null;
    const parsed = Number(field);
    return Number.isFinite(parsed) ? parsed : null;
}

function toFlags(field: string | undefined): number {
    const parsed = Number(field);
    return Number.isFinite(parsed) ? parsed : 0;
}

/** Splits a packed string into records, dropping the empty "no records" case. */
function records(packed: string | undefined): string[] {
    if (!packed) return [];
    return packed.split(RECORD_SEPARATOR).filter((record) => record.length > 0);
}

/** Case-insensitive `schema.name` key, used for every lookup in this module. */
function objectKey(schema: string, name: string): string {
    return `${schema.toLowerCase()}.${name.toLowerCase()}`;
}

/**
 * True when `table` belongs to the database a merge payload describes.
 *
 * The table list also holds demand-loaded schemas from other databases on the
 * same server, and `dbo.Orders` is not a rare name. Without this check the
 * columns of the connected database's `dbo.Orders` would overwrite those of
 * every other database's table of the same name.
 */
function belongsToDatabase(table: TableInfo, database: string | undefined): boolean {
    if (database === undefined) {
        return table.database === undefined;
    }
    return (table.database ?? '').toLowerCase() === database.toLowerCase();
}

// ── Stage 0: objects ──────────────────────────────────────────────────────────

/**
 * Splits the stage 0 object list into the tables and routines the completion
 * engine keeps separately.
 *
 * Tables come back with empty `columns` and `foreignKeys`, and routines with
 * empty `parameters`: that is the point of the stage. Table completion after
 * `FROM` / `JOIN` works from names alone, so it becomes available immediately,
 * and the later stages fill in the detail without replacing these objects.
 */
export function splitWireObjects(
    objects: WireObject[],
    database?: string,
): { tables: TableInfo[]; routines: RoutineSnapshot } {
    const tables: TableInfo[] = [];
    const routines: RoutineSnapshot = {
        scalarFunctions: [],
        tableValuedFunctions: [],
        storedProcedures: [],
    };

    for (const object of objects) {
        const schema = typeof object?.s === 'string' ? object.s.trim() : '';
        const name = typeof object?.n === 'string' ? object.n.trim() : '';
        if (!schema || !name) continue;

        const type = (typeof object.t === 'string' ? object.t : '').trim().toUpperCase();

        switch (type) {
            case 'U':
            case 'V':
                tables.push({
                    database,
                    schema,
                    name,
                    columns: [],
                    foreignKeys: [],
                    isView: type === 'V',
                });
                break;
            case 'FN':
            case 'FS':
            case 'FT':
                routines.scalarFunctions.push({ schema, name, parameters: [] });
                break;
            case 'IF':
            case 'TF':
                routines.tableValuedFunctions.push({ schema, name, parameters: [] });
                break;
            case 'P':
            case 'PC':
                routines.storedProcedures.push({ schema, name, parameters: [] });
                break;
            default:
                // An object type we do not complete on; the query should not
                // return one, but a snapshot from a newer client might.
                break;
        }
    }

    return { tables, routines };
}

// ── Stage 1: columns ──────────────────────────────────────────────────────────

/** Unpacks one table's column list. Order is the column order from the server. */
function unpackColumns(packed: string): ColumnInfo[] {
    const columns: ColumnInfo[] = [];

    for (const record of records(packed)) {
        const fields = record.split(FIELD_SEPARATOR);
        const name = fields[0];
        if (!name) continue;

        const flags = toFlags(fields[3]);
        columns.push({
            name,
            dataType: fields[1] || 'unknown',
            maxLength: toNumber(fields[2]),
            isNullable: (flags & COLUMN_FLAG_NULLABLE) !== 0,
            isPrimaryKey: (flags & COLUMN_FLAG_PRIMARY_KEY) !== 0,
            isIdentity: (flags & COLUMN_FLAG_IDENTITY) !== 0,
            isComputed: (flags & COLUMN_FLAG_COMPUTED) !== 0,
            hasDefault: (flags & COLUMN_FLAG_HAS_DEFAULT) !== 0,
        });
    }

    return columns;
}

/**
 * Attaches columns to the tables already known from stage 0.
 *
 * Tables are mutated in place so that any array or index built over them stays
 * valid. A payload entry for an unknown table is ignored rather than added:
 * stage 0 is the authority on which objects exist, and inventing a table here
 * would resurrect one that was dropped between the two queries.
 *
 * `database` scopes the merge to one database's tables — see
 * `belongsToDatabase`.
 *
 * Returns the number of columns attached.
 */
export function mergeColumns(
    tables: TableInfo[],
    payload: WireColumns[],
    database?: string,
): number {
    const byKey = new Map<string, TableInfo>();
    for (const table of tables) {
        if (!belongsToDatabase(table, database)) continue;
        byKey.set(objectKey(table.schema, table.name), table);
    }

    let attached = 0;
    for (const entry of payload) {
        const schema = typeof entry?.s === 'string' ? entry.s.trim() : '';
        const name = typeof entry?.n === 'string' ? entry.n.trim() : '';
        if (!schema || !name) continue;

        const table = byKey.get(objectKey(schema, name));
        if (!table) continue;

        table.columns = unpackColumns(typeof entry.c === 'string' ? entry.c : '');
        attached += table.columns.length;
    }

    return attached;
}

// ── Stage 2: foreign keys ─────────────────────────────────────────────────────

function unpackMappings(packed: string): ForeignKeyMapping[] {
    const mappings: ForeignKeyMapping[] = [];

    for (const record of records(packed)) {
        const [column, referencedColumn] = record.split(FIELD_SEPARATOR);
        if (!column || !referencedColumn) continue;
        mappings.push({ column, referencedColumn });
    }

    return mappings;
}

/**
 * Attaches foreign keys to their parent tables, replacing whatever was there.
 *
 * Replacing rather than appending keeps a re-published stage 2 idempotent: the
 * same constraint arriving twice must not show up as two JOIN suggestions.
 * Only the tables of `database` are touched, so a demand-loaded schema keeps
 * whatever it was given.
 *
 * Returns the number of constraints attached.
 */
export function mergeForeignKeys(
    tables: TableInfo[],
    payload: WireForeignKey[],
    database?: string,
): number {
    const byKey = new Map<string, TableInfo>();
    for (const table of tables) {
        if (!belongsToDatabase(table, database)) continue;
        byKey.set(objectKey(table.schema, table.name), table);
        table.foreignKeys = [];
    }

    let attached = 0;
    for (const entry of payload) {
        const name = typeof entry?.k === 'string' ? entry.k.trim() : '';
        const parentSchema = typeof entry?.ps === 'string' ? entry.ps.trim() : '';
        const parentTable = typeof entry?.pt === 'string' ? entry.pt.trim() : '';
        const referencedSchema = typeof entry?.rs === 'string' ? entry.rs.trim() : '';
        const referencedTable = typeof entry?.rt === 'string' ? entry.rt.trim() : '';
        if (!name || !parentSchema || !parentTable || !referencedSchema || !referencedTable) {
            continue;
        }

        const table = byKey.get(objectKey(parentSchema, parentTable));
        if (!table) continue;

        const foreignKey: ForeignKeyInfo = {
            name,
            parentSchema,
            parentTable,
            referencedSchema,
            referencedTable,
            mappings: unpackMappings(typeof entry.m === 'string' ? entry.m : ''),
        };

        table.foreignKeys.push(foreignKey);
        attached++;
    }

    return attached;
}

// ── Stage 3: routine parameters ───────────────────────────────────────────────

function unpackParameters(packed: string): RoutineParameterInfo[] {
    const parameters: RoutineParameterInfo[] = [];

    for (const record of records(packed)) {
        const fields = record.split(FIELD_SEPARATOR);
        const name = fields[0];
        if (!name) continue;

        const flags = toFlags(fields[5]);
        parameters.push({
            name,
            dataType: fields[1] || 'unknown',
            maxLength: toNumber(fields[2]),
            precision: toNumber(fields[3]),
            scale: toNumber(fields[4]),
            isOutput: (flags & PARAM_FLAG_OUTPUT) !== 0,
            hasDefaultValue: (flags & PARAM_FLAG_HAS_DEFAULT) !== 0,
        });
    }

    return parameters;
}

/**
 * Fills in the parameter lists of the routines known from stage 0.
 *
 * The same `schema.name` can be both a function and a procedure, so the
 * `sys.objects.type` from the payload decides which list to look in.
 *
 * Returns the number of routines whose parameters were filled in.
 */
export function mergeRoutineParameters(
    routines: RoutineSnapshot,
    payload: WireRoutine[],
): number {
    const scalar = new Map<string, { parameters: RoutineParameterInfo[] }>();
    const tableValued = new Map<string, { parameters: RoutineParameterInfo[] }>();
    const procedures = new Map<string, { parameters: RoutineParameterInfo[] }>();

    for (const fn of routines.scalarFunctions) scalar.set(objectKey(fn.schema, fn.name), fn);
    for (const fn of routines.tableValuedFunctions) {
        tableValued.set(objectKey(fn.schema, fn.name), fn);
    }
    for (const proc of routines.storedProcedures) {
        procedures.set(objectKey(proc.schema, proc.name), proc);
    }

    let filled = 0;
    for (const entry of payload) {
        const schema = typeof entry?.s === 'string' ? entry.s.trim() : '';
        const name = typeof entry?.n === 'string' ? entry.n.trim() : '';
        if (!schema || !name) continue;

        const type = (typeof entry.t === 'string' ? entry.t : '').trim().toUpperCase();
        let target: { parameters: RoutineParameterInfo[] } | undefined;

        switch (type) {
            case 'FN':
            case 'FS':
            case 'FT':
                target = scalar.get(objectKey(schema, name));
                break;
            case 'IF':
            case 'TF':
                target = tableValued.get(objectKey(schema, name));
                break;
            case 'P':
            case 'PC':
                target = procedures.get(objectKey(schema, name));
                break;
            default:
                target = undefined;
        }

        if (!target) continue;

        target.parameters = unpackParameters(typeof entry.p === 'string' ? entry.p : '');
        filled++;
    }

    return filled;
}
