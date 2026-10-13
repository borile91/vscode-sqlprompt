/**
 * Wire format between the extension host and the language server.
 *
 * The whole point of this module is to avoid materialising one JavaScript
 * object per database column in the extension host. On a large database the
 * schema query returns tens of thousands of column rows, and the old pipeline
 * built an object for each of them **four** times over (SQL Tools Service
 * JSON, row objects, `ColumnInfo` objects, then again when the language server
 * sanitized the snapshot). That work — not the query itself — is what made the
 * first sync take tens of seconds on a slow CPU.
 *
 * So columns, foreign key mappings and routine parameters travel as a single
 * packed string per parent object, produced directly by `STRING_AGG` on the
 * server. The extension host passes those strings through untouched; the
 * language server unpacks them once, into the objects it actually needs.
 *
 * The mirror image of this file is `server/src/schemaWire.ts`. The two must
 * agree on the separators and on the field order — change one, change both.
 */

/**
 * Separator between records (one column, one FK mapping, one parameter).
 * ASCII 30. Control characters are not legal in a SQL Server identifier or
 * type name, so a separator can never collide with packed content.
 */
export const RECORD_SEPARATOR = '\u001e';
/** Separator between the fields of a single record. ASCII 31. */
export const FIELD_SEPARATOR = '\u001f';

/** Column flag bits, packed into the last field of a column record. */
export const COLUMN_FLAG_NULLABLE = 1;
export const COLUMN_FLAG_PRIMARY_KEY = 2;
export const COLUMN_FLAG_IDENTITY = 4;
export const COLUMN_FLAG_COMPUTED = 8;
export const COLUMN_FLAG_HAS_DEFAULT = 16;

/** Routine parameter flag bits. */
export const PARAM_FLAG_OUTPUT = 1;
export const PARAM_FLAG_HAS_DEFAULT = 2;

// ── Payload shapes ────────────────────────────────────────────────────────────
//
// Property names are deliberately one or two characters: these arrays hold one
// entry per schema object, and the key names are repeated in the JSON for every
// single one of them.

/** Stage 0: a table, view, function or procedure, by name only. */
export interface WireObject {
    /** Schema name. */
    s: string;
    /** Object name. */
    n: string;
    /** `sys.objects.type`, right-trimmed (`U`, `V`, `P`, `FN`, `IF`, …). */
    t: string;
}

/** Stage 1: the packed column list of one table or view. */
export interface WireColumns {
    s: string;
    n: string;
    /** `name US type US maxLength US flags` per column, joined by RS. */
    c: string;
}

/** Stage 2: one foreign key with its column mappings packed. */
export interface WireForeignKey {
    /** Constraint name. */
    k: string;
    /** Parent schema. */
    ps: string;
    /** Parent table. */
    pt: string;
    /** Referenced schema. */
    rs: string;
    /** Referenced table. */
    rt: string;
    /** `column US referencedColumn` per mapping, joined by RS. */
    m: string;
}

/** Stage 3: the packed parameter list of one routine. */
export interface WireRoutine {
    s: string;
    n: string;
    /** `sys.objects.type`, right-trimmed. */
    t: string;
    /** `name US type US maxLength US precision US scale US flags` per parameter. */
    p: string;
}

/** Everything the language server needs to serve completions. */
export interface WireSnapshot {
    objects: WireObject[];
    columns: WireColumns[];
    foreignKeys: WireForeignKey[];
    routines: WireRoutine[];
    databases: string[];
    /** Name of the connected database, used to key demand-loaded schemas. */
    database?: string;
}

// ── Client-side packing (fallback path only) ──────────────────────────────────
//
// `STRING_AGG` needs SQL Server 2017. On an older server the loader falls back
// to the classic one-row-per-column queries, and these helpers rebuild the same
// packed strings locally so the language server only ever sees one format.

/** Packs one column record. `maxLength` is the raw `sys.columns.max_length`. */
export function packColumn(
    name: string,
    dataType: string,
    maxLength: number | null,
    flags: number,
): string {
    return [name, dataType, maxLength ?? '', flags].join(FIELD_SEPARATOR);
}

/** Packs one foreign key mapping record. */
export function packMapping(column: string, referencedColumn: string): string {
    return [column, referencedColumn].join(FIELD_SEPARATOR);
}

/** Packs one routine parameter record. */
export function packParameter(
    name: string,
    dataType: string,
    maxLength: number | null,
    precision: number | null,
    scale: number | null,
    flags: number,
): string {
    return [name, dataType, maxLength ?? '', precision ?? '', scale ?? '', flags].join(
        FIELD_SEPARATOR,
    );
}

/** Joins already-packed records into the single string that travels the wire. */
export function joinRecords(records: string[]): string {
    return records.join(RECORD_SEPARATOR);
}
