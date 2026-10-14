/**
 * Staged schema loading over the mssql connection sharing API.
 *
 * The load is split so that the feature users wait for becomes available
 * first, and the expensive parts arrive afterwards without blocking it:
 *
 *   stage 0  object names        →  `FROM` / `JOIN` / `INSERT INTO` completion
 *   stage 1  columns             →  column completion, `INSERT` snippets, `*` expansion
 *   stage 2  foreign keys        →  `ON` predicates, FK-based ranking
 *   stage 3  routine parameters  →  procedure and function signatures
 *
 * Each stage is published to the language server as soon as it lands, so the
 * extension is progressively more useful rather than useless until the end.
 *
 * The stages run sequentially rather than in parallel: they all share one
 * connection URI, and SQL Tools Service serialises requests on it anyway.
 * Sequential also means an early stage is never delayed by a later one.
 */

import {
    COLUMN_FLAG_COMPUTED,
    COLUMN_FLAG_HAS_DEFAULT,
    COLUMN_FLAG_IDENTITY,
    COLUMN_FLAG_NULLABLE,
    COLUMN_FLAG_PRIMARY_KEY,
    PARAM_FLAG_HAS_DEFAULT,
    PARAM_FLAG_OUTPUT,
    WireColumns,
    WireForeignKey,
    WireObject,
    WireRoutine,
    joinRecords,
    packColumn,
    packMapping,
    packParameter,
} from './wireFormat';
import { SchemaToken } from './schemaCache';
import {
    COLUMNS_QUERY,
    COLUMNS_QUERY_LEGACY,
    DATABASES_QUERY,
    FOREIGN_KEYS_QUERY,
    FOREIGN_KEYS_QUERY_LEGACY,
    IDENTITY_TOKEN_QUERY,
    OBJECTS_QUERY,
    ROUTINES_QUERY,
    ROUTINES_QUERY_LEGACY,
} from './queries';

/** The slice of the mssql connection sharing API this module needs. */
export interface QueryRunner {
    executeSimpleQuery(connectionUri: string, queryString: string): Promise<any>;
    listDatabases?(connectionUri: string): Promise<string[]>;
}

/**
 * The separators as T-SQL literals, for the cross-database query built below.
 * `queries.ts` explains why they are literals rather than variables.
 */
const RS_LITERAL = "N'\u001e'";
const US_LITERAL = "N'\u001f'";

/** Rows are mapped in chunks of this size, yielding to the event loop between them. */
const MAPPING_CHUNK_SIZE = 2000;

/**
 * Hands control back to the event loop.
 *
 * Mapping tens of thousands of rows in one synchronous loop freezes the
 * extension host, which on a slow machine is the difference between "the
 * schema is loading" and "VS Code has hung".
 */
function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

// ── Result-set access ─────────────────────────────────────────────────────────

/**
 * Reads one cell as text.
 *
 * SQL Tools Service returns cells either as plain values or wrapped as
 * `{ displayValue, isNull, … }`, depending on the code path that produced them,
 * so both shapes have to be handled.
 */
function cellText(value: any): string {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value === 'object') {
        if (value.isNull === true) return '';
        const candidate = value.displayValue ?? value.value;
        if (typeof candidate === 'string') return candidate;
        if (typeof candidate === 'number' || typeof candidate === 'boolean') {
            return String(candidate);
        }
    }
    return '';
}

/** Reads one cell as a number, or null when it is absent or not numeric. */
function cellNumber(value: any): number | null {
    const text = cellText(value).trim();
    if (!text) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
}

/** True when the cell holds a SQL Server bit / int that means "yes". */
function cellFlag(value: any): boolean {
    const text = cellText(value).trim().toLowerCase();
    return text === '1' || text === 'true';
}

/**
 * A result set reduced to what the mappers need: positional rows plus a lookup
 * from column name to index.
 *
 * Working positionally is deliberate. Building a named-key object per row is
 * exactly the kind of per-row allocation this rewrite exists to remove.
 */
interface ResultSet {
    rows: any[][];
    index: (columnName: string) => number;
}

function toResultSet(result: any): ResultSet {
    const rawRows = Array.isArray(result?.rows) ? result.rows : [];
    const columnInfo = Array.isArray(result?.columnInfo) ? result.columnInfo : [];

    const byName = new Map<string, number>();
    columnInfo.forEach((info: any, i: number) => {
        const name = info?.columnName ?? info?.name;
        if (typeof name === 'string') {
            byName.set(name.toLowerCase(), i);
        }
    });

    // Some builds hand back objects keyed by column name instead of arrays.
    // Normalise those into positional rows once, up front.
    const rows: any[][] =
        rawRows.length > 0 && !Array.isArray(rawRows[0])
            ? rawRows.map((row: Record<string, any>) => {
                const ordered: any[] = [];
                byName.forEach((i, name) => {
                    ordered[i] = row[name] ?? row[name.toUpperCase()];
                });
                return ordered;
            })
            : rawRows;

    return {
        rows,
        index: (columnName: string) => byName.get(columnName.toLowerCase()) ?? -1,
    };
}

/** Runs a query and reduces it to a `ResultSet`. */
async function query(
    runner: QueryRunner,
    ownerUri: string,
    sql: string,
): Promise<ResultSet> {
    const result = await runner.executeSimpleQuery(ownerUri, sql);
    return toResultSet(result);
}

/** Errore SQL Server 195: "'X' is not a recognized built-in function name". */
const ERROR_UNKNOWN_BUILT_IN_FUNCTION = 195;

/**
 * True quando l'errore indica che il server non supporta la query aggregante
 * (`STRING_AGG` / `WITHIN GROUP` assenti o livello di compatibilità).
 *
 * Timeout, connessione persa, permessi e simili non rientrano: lì la query
 * per-riga fallirebbe allo stesso modo, solo dopo molto più lavoro.
 */
export function isAggregationUnsupportedError(err: unknown): boolean {
    const e = err as any;
    const numbers = [e?.number, e?.errorNumber, e?.code, e?.data?.number];
    if (numbers.some((n) => Number(n) === ERROR_UNKNOWN_BUILT_IN_FUNCTION)) {
        return true;
    }

    const message = String(e?.message ?? e ?? '').toLowerCase();
    return (
        message.includes('string_agg') ||
        message.includes('is not a recognized built-in function name') ||
        message.includes("near 'within'") ||
        message.includes('compatibility level')
    );
}

/**
 * Runs the aggregating form of a query, falling back to the legacy one-row-per-
 * record form when the server rejects it.
 *
 * `STRING_AGG` needs SQL Server 2017 or Azure SQL, and there is no reliable way
 * to detect that up front — Azure SQL still reports a 12.x product version — so
 * the aggregating query is simply attempted. It fails at compile time on an
 * older server, before any data is touched, which makes the probe cheap.
 *
 * Solo quel rifiuto attiva il fallback: ogni altro errore viene rilanciato.
 */
async function queryWithFallback(
    runner: QueryRunner,
    ownerUri: string,
    aggregating: string,
    legacy: string,
    label: string,
): Promise<{ result: ResultSet; usedLegacy: boolean }> {
    try {
        return { result: await query(runner, ownerUri, aggregating), usedLegacy: false };
    } catch (err: any) {
        if (!isAggregationUnsupportedError(err)) {
            throw err;
        }
        console.log(
            `[SQL Prompt] ${label}: aggregated query rejected (${err?.message ?? err}), ` +
            `falling back to the per-row query.`,
        );
        return { result: await query(runner, ownerUri, legacy), usedLegacy: true };
    }
}

/**
 * Runs `sql` and returns the first cell of the first row as text.
 *
 * For the one-value lookups that are not part of the staged load — currently
 * the `sys.sql_modules` definition behind Go to Definition.
 */
export async function queryFirstCellText(
    runner: QueryRunner,
    ownerUri: string,
    sql: string,
): Promise<string | undefined> {
    const { rows } = await query(runner, ownerUri, sql);
    const row = rows[0];
    if (!row) return undefined;
    const text = cellText(row[0]);
    return text || undefined;
}

/**
 * Esegue `sql` e restituisce, per ogni riga, le colonne richieste come testo.
 *
 * Per le piccole letture fuori dal caricamento a stadi: oggi l'elenco dei
 * moduli dell'ALTER scaffolding.
 */
export async function queryRowsText(
    runner: QueryRunner,
    ownerUri: string,
    sql: string,
    columns: string[],
): Promise<string[][]> {
    const { rows, index } = await query(runner, ownerUri, sql);
    const positions = columns.map(index);
    return rows.map((row) => positions.map((i) => (i < 0 ? '' : cellText(row[i]))));
}

// ── Identity and change detection ─────────────────────────────────────────────

/**
 * Reads the cache key and change-detection token for the connected database.
 *
 * This is the one query that always runs, so it is deliberately tiny: three
 * catalogue aggregates and two names, one row.
 */
export async function loadSchemaToken(
    runner: QueryRunner,
    ownerUri: string,
): Promise<SchemaToken | undefined> {
    const { rows, index } = await query(runner, ownerUri, IDENTITY_TOKEN_QUERY);
    const row = rows[0];
    if (!row) return undefined;

    const serverName = cellText(row[index('server_name')]);
    const databaseName = cellText(row[index('db_name')]);
    if (!serverName || !databaseName) return undefined;

    return {
        serverName,
        databaseName,
        objectCount: cellText(row[index('object_count')]),
        columnCount: cellText(row[index('column_count')]),
        maxModify: cellText(row[index('max_modify')]),
    };
}

// ── Stage 0: object names ─────────────────────────────────────────────────────

export async function loadObjects(
    runner: QueryRunner,
    ownerUri: string,
): Promise<WireObject[]> {
    const { rows, index } = await query(runner, ownerUri, OBJECTS_QUERY);
    const iSchema = index('schema_name');
    const iName = index('object_name');
    const iType = index('object_type');

    const objects: WireObject[] = [];
    for (const row of rows) {
        const s = cellText(row[iSchema]).trim();
        const n = cellText(row[iName]).trim();
        if (!s || !n) continue;
        objects.push({ s, n, t: cellText(row[iType]).trim() });
    }
    return objects;
}

/**
 * The databases on the server, for cross-database completion.
 *
 * Solo i database ONLINE: uno offline / in ripristino comparirebbe tra i
 * suggerimenti e il suo caricamento on-demand fallirebbe. Per questo la fonte
 * primaria è `sys.databases` con il filtro su `state_desc`; `listDatabases`
 * (API mssql in dismissione, senza filtro di stato) resta solo come ripiego
 * quando la query non è eseguibile, per non spegnere il cross-database.
 */
export async function loadDatabases(
    runner: QueryRunner,
    ownerUri: string,
): Promise<string[]> {
    try {
        const { rows, index } = await query(runner, ownerUri, DATABASES_QUERY);
        const iName = index('name');
        return rows
            .map((row) => cellText(row[iName]).trim())
            .filter((name) => name.length > 0);
    } catch (err: any) {
        console.log(`[SQL Prompt] database list query failed: ${err?.message ?? err}`);
    }

    try {
        if (runner.listDatabases) {
            const names = await runner.listDatabases(ownerUri);
            return Array.isArray(names)
                ? names.filter((n): n is string => typeof n === 'string' && n.length > 0)
                : [];
        }
    } catch (err: any) {
        console.error(`[SQL Prompt] database list unavailable: ${err?.message ?? err}`);
    }
    return [];
}

// ── Stage 1: columns ──────────────────────────────────────────────────────────

export async function loadColumns(
    runner: QueryRunner,
    ownerUri: string,
): Promise<WireColumns[]> {
    const { result, usedLegacy } = await queryWithFallback(
        runner,
        ownerUri,
        COLUMNS_QUERY,
        COLUMNS_QUERY_LEGACY,
        'columns',
    );

    return usedLegacy ? packLegacyColumns(result) : await mapAggregatedColumns(result);
}

async function mapAggregatedColumns(result: ResultSet): Promise<WireColumns[]> {
    const iSchema = result.index('schema_name');
    const iName = result.index('object_name');
    const iPacked = result.index('columns_packed');

    const columns: WireColumns[] = [];
    for (let i = 0; i < result.rows.length; i++) {
        if (i > 0 && i % MAPPING_CHUNK_SIZE === 0) await yieldToEventLoop();

        const row = result.rows[i];
        const s = cellText(row[iSchema]).trim();
        const n = cellText(row[iName]).trim();
        if (!s || !n) continue;
        columns.push({ s, n, c: cellText(row[iPacked]) });
    }
    return columns;
}

/** Rebuilds the packed form from the legacy one-row-per-column result. */
function packLegacyColumns(result: ResultSet): WireColumns[] {
    const iSchema = result.index('schema_name');
    const iName = result.index('object_name');
    const iColumn = result.index('column_name');
    const iType = result.index('data_type');
    const iMaxLength = result.index('max_length');
    const iNullable = result.index('is_nullable');
    const iIdentity = result.index('is_identity');
    const iComputed = result.index('is_computed');
    const iHasDefault = result.index('has_default');
    const iPrimaryKey = result.index('is_primary_key');

    const packedByTable = new Map<string, { s: string; n: string; records: string[] }>();

    for (const row of result.rows) {
        const s = cellText(row[iSchema]).trim();
        const n = cellText(row[iName]).trim();
        const columnName = cellText(row[iColumn]).trim();
        if (!s || !n || !columnName) continue;

        const key = `${s}.${n}`;
        let entry = packedByTable.get(key);
        if (!entry) {
            entry = { s, n, records: [] };
            packedByTable.set(key, entry);
        }

        let flags = 0;
        if (cellFlag(row[iNullable])) flags |= COLUMN_FLAG_NULLABLE;
        if (cellFlag(row[iPrimaryKey])) flags |= COLUMN_FLAG_PRIMARY_KEY;
        if (cellFlag(row[iIdentity])) flags |= COLUMN_FLAG_IDENTITY;
        if (cellFlag(row[iComputed])) flags |= COLUMN_FLAG_COMPUTED;
        if (cellFlag(row[iHasDefault])) flags |= COLUMN_FLAG_HAS_DEFAULT;

        entry.records.push(
            packColumn(
                columnName,
                cellText(row[iType]).trim() || 'unknown',
                cellNumber(row[iMaxLength]),
                flags,
            ),
        );
    }

    return Array.from(packedByTable.values(), (entry) => ({
        s: entry.s,
        n: entry.n,
        c: joinRecords(entry.records),
    }));
}

// ── Stage 2: foreign keys ─────────────────────────────────────────────────────

export async function loadForeignKeys(
    runner: QueryRunner,
    ownerUri: string,
): Promise<WireForeignKey[]> {
    const { result, usedLegacy } = await queryWithFallback(
        runner,
        ownerUri,
        FOREIGN_KEYS_QUERY,
        FOREIGN_KEYS_QUERY_LEGACY,
        'foreign keys',
    );

    const iName = result.index('fk_name');
    const iParentSchema = result.index('parent_schema');
    const iParentTable = result.index('parent_table');
    const iRefSchema = result.index('referenced_schema');
    const iRefTable = result.index('referenced_table');

    if (!usedLegacy) {
        const iPacked = result.index('mappings_packed');
        const foreignKeys: WireForeignKey[] = [];
        for (const row of result.rows) {
            const k = cellText(row[iName]).trim();
            const pt = cellText(row[iParentTable]).trim();
            if (!k || !pt) continue;
            foreignKeys.push({
                k,
                ps: cellText(row[iParentSchema]).trim(),
                pt,
                rs: cellText(row[iRefSchema]).trim(),
                rt: cellText(row[iRefTable]).trim(),
                m: cellText(row[iPacked]),
            });
        }
        return foreignKeys;
    }

    const iParentColumn = result.index('parent_column');
    const iRefColumn = result.index('referenced_column');
    const byKey = new Map<string, WireForeignKey & { records: string[] }>();

    for (const row of result.rows) {
        const k = cellText(row[iName]).trim();
        const ps = cellText(row[iParentSchema]).trim();
        const pt = cellText(row[iParentTable]).trim();
        if (!k || !ps || !pt) continue;

        const key = `${ps}.${pt}::${k}`;
        let entry = byKey.get(key);
        if (!entry) {
            entry = {
                k,
                ps,
                pt,
                rs: cellText(row[iRefSchema]).trim(),
                rt: cellText(row[iRefTable]).trim(),
                m: '',
                records: [],
            };
            byKey.set(key, entry);
        }

        const column = cellText(row[iParentColumn]).trim();
        const referencedColumn = cellText(row[iRefColumn]).trim();
        if (column && referencedColumn) {
            entry.records.push(packMapping(column, referencedColumn));
        }
    }

    return Array.from(byKey.values(), ({ records, ...fk }) => ({
        ...fk,
        m: joinRecords(records),
    }));
}

// ── Stage 3: routine parameters ───────────────────────────────────────────────

export async function loadRoutines(
    runner: QueryRunner,
    ownerUri: string,
): Promise<WireRoutine[]> {
    const { result, usedLegacy } = await queryWithFallback(
        runner,
        ownerUri,
        ROUTINES_QUERY,
        ROUTINES_QUERY_LEGACY,
        'routines',
    );

    const iSchema = result.index('schema_name');
    const iName = result.index('routine_name');
    const iType = result.index('object_type');

    if (!usedLegacy) {
        const iPacked = result.index('parameters_packed');
        const routines: WireRoutine[] = [];
        for (const row of result.rows) {
            const s = cellText(row[iSchema]).trim();
            const n = cellText(row[iName]).trim();
            if (!s || !n) continue;
            routines.push({
                s,
                n,
                t: cellText(row[iType]).trim(),
                p: cellText(row[iPacked]),
            });
        }
        return routines;
    }

    const iParamName = result.index('parameter_name');
    const iDataType = result.index('data_type');
    const iMaxLength = result.index('max_length');
    const iPrecision = result.index('precision');
    const iScale = result.index('scale');
    const iOutput = result.index('is_output');
    const iHasDefault = result.index('has_default_value');

    const byRoutine = new Map<string, WireRoutine & { records: string[] }>();

    for (const row of result.rows) {
        const s = cellText(row[iSchema]).trim();
        const n = cellText(row[iName]).trim();
        const t = cellText(row[iType]).trim();
        if (!s || !n) continue;

        const key = `${s}.${n}::${t}`;
        let entry = byRoutine.get(key);
        if (!entry) {
            entry = { s, n, t, p: '', records: [] };
            byRoutine.set(key, entry);
        }

        const paramName = cellText(row[iParamName]).trim();
        if (!paramName) continue;

        let flags = 0;
        if (cellFlag(row[iOutput])) flags |= PARAM_FLAG_OUTPUT;
        if (cellFlag(row[iHasDefault])) flags |= PARAM_FLAG_HAS_DEFAULT;

        entry.records.push(
            packParameter(
                paramName,
                cellText(row[iDataType]).trim() || 'unknown',
                cellNumber(row[iMaxLength]),
                cellNumber(row[iPrecision]),
                cellNumber(row[iScale]),
                flags,
            ),
        );
    }

    return Array.from(byRoutine.values(), ({ records, ...routine }) => ({
        ...routine,
        p: joinRecords(records),
    }));
}

// ── Cross-database schema (demand-loaded) ─────────────────────────────────────

/**
 * Loads objects and columns for another database on the same server.
 *
 * Cross-database access goes through three-part names against that database's
 * `sys` views, which rules out the shared queries above. Foreign keys and
 * routines are deliberately left out: a cross-database reference is almost
 * always a plain `SELECT`, and loading them would double the cost of a load
 * that happens while the user is mid-keystroke.
 */
export async function loadCrossDatabaseSchema(
    runner: QueryRunner,
    ownerUri: string,
    database: string,
): Promise<{ objects: WireObject[]; columns: WireColumns[] }> {
    // Escaping `]` keeps a database name with a bracket in it from breaking out
    // of the quoted identifier.
    const db = `[${database.replace(/]/g, ']]')}]`;

    const aggregating = `
        SELECT
            s.name AS schema_name,
            o.name AS object_name,
            RTRIM(o.type) AS object_type,
            STRING_AGG(
                CAST(
                    CONCAT(
                        c.name, ${US_LITERAL},
                        ISNULL(TYPE_NAME(c.user_type_id), 'unknown'), ${US_LITERAL},
                        c.max_length, ${US_LITERAL},
                        CAST(c.is_nullable AS int)
                            + CASE WHEN pk.column_id IS NOT NULL THEN 2 ELSE 0 END
                            + CASE WHEN c.is_identity = 1 THEN 4 ELSE 0 END
                            + CASE WHEN c.is_computed = 1 THEN 8 ELSE 0 END
                            + CASE WHEN c.default_object_id <> 0 THEN 16 ELSE 0 END
                    ) AS nvarchar(max)
                ),
                ${RS_LITERAL}
            ) WITHIN GROUP (ORDER BY c.column_id) AS columns_packed
        FROM ${db}.sys.objects o
        INNER JOIN ${db}.sys.schemas s ON o.schema_id = s.schema_id
        INNER JOIN ${db}.sys.columns c ON o.object_id = c.object_id
        LEFT JOIN (
            SELECT ic.object_id, ic.column_id
            FROM ${db}.sys.index_columns ic
            INNER JOIN ${db}.sys.indexes i
                ON ic.object_id = i.object_id AND ic.index_id = i.index_id
            WHERE i.is_primary_key = 1
        ) pk ON o.object_id = pk.object_id AND c.column_id = pk.column_id
        WHERE o.is_ms_shipped = 0 AND o.type IN ('U', 'V')
        GROUP BY s.name, o.name, o.type
        ORDER BY s.name, o.name
    `;

    const legacy = `
        SELECT
            s.name AS schema_name,
            o.name AS object_name,
            RTRIM(o.type) AS object_type,
            c.name AS column_name,
            ISNULL(TYPE_NAME(c.user_type_id), 'unknown') AS data_type,
            c.max_length,
            c.is_nullable,
            c.is_identity,
            c.is_computed,
            CASE WHEN c.default_object_id <> 0 THEN 1 ELSE 0 END AS has_default,
            CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS is_primary_key
        FROM ${db}.sys.objects o
        INNER JOIN ${db}.sys.schemas s ON o.schema_id = s.schema_id
        INNER JOIN ${db}.sys.columns c ON o.object_id = c.object_id
        LEFT JOIN (
            SELECT ic.object_id, ic.column_id
            FROM ${db}.sys.index_columns ic
            INNER JOIN ${db}.sys.indexes i
                ON ic.object_id = i.object_id AND ic.index_id = i.index_id
            WHERE i.is_primary_key = 1
        ) pk ON o.object_id = pk.object_id AND c.column_id = pk.column_id
        WHERE o.is_ms_shipped = 0 AND o.type IN ('U', 'V')
        ORDER BY s.name, o.name, c.column_id
    `;

    const { result, usedLegacy } = await queryWithFallback(
        runner,
        ownerUri,
        aggregating,
        legacy,
        `cross-database [${database}]`,
    );

    const columns = usedLegacy ? packLegacyColumns(result) : await mapAggregatedColumns(result);
    // Cross-database objects are only ever tables and views, so the object list
    // can be derived from the column result instead of costing another query.
    // Il tipo arriva da `object_type`: le viste devono restare `V`.
    const types = objectTypesByName(result);
    const objects: WireObject[] = columns.map(({ s, n }) => ({
        s,
        n,
        t: types.get(`${s}.${n}`) === 'V' ? 'V' : 'U',
    }));

    return { objects, columns };
}

/** `schema.nome` → tipo dell'oggetto (`U` / `V`), dalla colonna `object_type`. */
function objectTypesByName(result: ResultSet): Map<string, string> {
    const iSchema = result.index('schema_name');
    const iName = result.index('object_name');
    const iType = result.index('object_type');
    const types = new Map<string, string>();
    if (iType < 0) return types;

    for (const row of result.rows) {
        const key = `${cellText(row[iSchema]).trim()}.${cellText(row[iName]).trim()}`;
        if (!types.has(key)) {
            types.set(key, cellText(row[iType]).trim().toUpperCase());
        }
    }
    return types;
}
