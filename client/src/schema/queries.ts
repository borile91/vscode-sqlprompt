/**
 * The catalogue queries behind the staged schema load.
 *
 * Two rules shape every query here:
 *
 *  1. **One row per schema object, never one row per column.** Column lists,
 *     foreign key mappings and routine parameters are aggregated server-side
 *     with `STRING_AGG`. SQL Tools Service wraps *every single cell* it returns
 *     in a JSON object, so the cost of a result set is driven by its cell count
 *     far more than by its byte size — collapsing 40k column rows into 2k table
 *     rows is the difference that matters.
 *
 *  2. **No `sys.types` join.** `TYPE_NAME(user_type_id)` does the same job
 *     without the join, and it is NULL-safe once wrapped in `CONCAT`.
 *
 * `STRING_AGG` needs SQL Server 2017 or Azure SQL. Older servers fall back to
 * the `*_LEGACY` queries, which return the classic one-row-per-column shape and
 * are packed in the extension host instead — see `schemaLoad.ts`.
 *
 * `STRING_AGG` accepts only a literal or a variable as its separator, never an
 * expression such as `NCHAR(30)`, so the separators are embedded as string
 * literals containing the control character itself. That keeps every query a
 * single `SELECT`: a `DECLARE` prologue would work in T-SQL, but it makes the
 * batch return more than one statement and `executeSimpleQuery` only surfaces
 * one result set.
 */

/** `N'<RS>'` — the record separator as a T-SQL literal. Mirrors `wireFormat.ts`. */
const RS = "N'\u001e'";
/** `N'<US>'` — the field separator as a T-SQL literal. */
const US = "N'\u001f'";

/** The `sys.objects.type` values we care about: tables, views, routines. */
const RELEVANT_OBJECT_TYPES = `'U', 'V', 'FN', 'FS', 'FT', 'IF', 'TF', 'P', 'PC'`;

/**
 * Identity and change-detection token for the connected database.
 *
 * `server_name` + `db_name` key the on-disk cache; the three counters decide
 * whether a cached snapshot is still valid. `modify_date` moves on any DDL that
 * alters an object, and the two counts catch pure additions and removals — a
 * combination that costs one cheap catalogue scan instead of a full reload.
 *
 * `sp_rename` on a column updates neither, so a renamed column is the one
 * change this token misses; `SQL Prompt: Reload Schema` forces a fresh load.
 */
export const IDENTITY_TOKEN_QUERY = `
    SELECT
        CONVERT(nvarchar(256), SERVERPROPERTY('ServerName')) AS server_name,
        DB_NAME() AS db_name,
        (SELECT COUNT_BIG(*) FROM sys.objects WHERE is_ms_shipped = 0) AS object_count,
        (SELECT COUNT_BIG(*) FROM sys.columns) AS column_count,
        (
            SELECT CONVERT(varchar(30), MAX(modify_date), 126)
            FROM sys.objects
            WHERE is_ms_shipped = 0
        ) AS max_modify
`;

/**
 * Stage 0 — every object by name, one row each.
 *
 * This is what unlocks the feature users actually wait for: table completion
 * after `FROM` / `JOIN` / `INSERT INTO`, with automatic aliasing. It costs a
 * couple of thousand rows even on a large database, so it can be published
 * within a few hundred milliseconds and the remaining stages can take their
 * time in the background.
 */
export const OBJECTS_QUERY = `
    SELECT
        s.name AS schema_name,
        o.name AS object_name,
        RTRIM(o.type) AS object_type
    FROM sys.objects o
    INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
    WHERE o.is_ms_shipped = 0
      AND o.type IN (${RELEVANT_OBJECT_TYPES})
    ORDER BY s.name, o.name
`;

/**
 * Stage 1 — the column list of every table and view, one row per object.
 *
 * The flag bitmask mirrors `COLUMN_FLAG_*` in `wireFormat.ts`. Identity,
 * computed and default columns matter because the `INSERT` snippets have to
 * leave server-generated columns out of the column list.
 */
export const COLUMNS_QUERY = `
    SELECT
        s.name AS schema_name,
        o.name AS object_name,
        STRING_AGG(
            CAST(
                CONCAT(
                    c.name, ${US},
                    ISNULL(TYPE_NAME(c.user_type_id), 'unknown'), ${US},
                    c.max_length, ${US},
                    CAST(c.is_nullable AS int)
                        + CASE WHEN pk.column_id IS NOT NULL THEN 2 ELSE 0 END
                        + CASE WHEN c.is_identity = 1 THEN 4 ELSE 0 END
                        + CASE WHEN c.is_computed = 1 THEN 8 ELSE 0 END
                        + CASE WHEN c.default_object_id <> 0 THEN 16 ELSE 0 END
                ) AS nvarchar(max)
            ),
            ${RS}
        ) WITHIN GROUP (ORDER BY c.column_id) AS columns_packed
    FROM sys.objects o
    INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
    INNER JOIN sys.columns c ON o.object_id = c.object_id
    LEFT JOIN (
        SELECT ic.object_id, ic.column_id
        FROM sys.index_columns ic
        INNER JOIN sys.indexes i
            ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        WHERE i.is_primary_key = 1
    ) pk ON o.object_id = pk.object_id AND c.column_id = pk.column_id
    WHERE o.is_ms_shipped = 0
      AND o.type IN ('U', 'V')
    GROUP BY s.name, o.name
    ORDER BY s.name, o.name
`;

/** Stage 2 — one row per foreign key, with its column pairs packed. */
export const FOREIGN_KEYS_QUERY = `
    SELECT
        fk.name AS fk_name,
        sch_parent.name AS parent_schema,
        t_parent.name AS parent_table,
        sch_ref.name AS referenced_schema,
        t_ref.name AS referenced_table,
        STRING_AGG(
            CAST(CONCAT(c_parent.name, ${US}, c_ref.name) AS nvarchar(max)),
            ${RS}
        ) WITHIN GROUP (ORDER BY fkc.constraint_column_id) AS mappings_packed
    FROM sys.foreign_keys fk
    INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
    INNER JOIN sys.tables t_parent ON fkc.parent_object_id = t_parent.object_id
    INNER JOIN sys.schemas sch_parent ON t_parent.schema_id = sch_parent.schema_id
    INNER JOIN sys.columns c_parent
        ON fkc.parent_object_id = c_parent.object_id
        AND fkc.parent_column_id = c_parent.column_id
    INNER JOIN sys.tables t_ref ON fkc.referenced_object_id = t_ref.object_id
    INNER JOIN sys.schemas sch_ref ON t_ref.schema_id = sch_ref.schema_id
    INNER JOIN sys.columns c_ref
        ON fkc.referenced_object_id = c_ref.object_id
        AND fkc.referenced_column_id = c_ref.column_id
    GROUP BY fk.name, sch_parent.name, t_parent.name, sch_ref.name, t_ref.name
    ORDER BY sch_parent.name, t_parent.name, fk.name
`;

/**
 * Stage 3 — one row per routine, with its parameter list packed.
 *
 * The `LEFT JOIN` keeps parameterless routines in the result: they still have
 * to appear in completions, they just carry an empty parameter list.
 */
export const ROUTINES_QUERY = `
    SELECT
        s.name AS schema_name,
        o.name AS routine_name,
        RTRIM(o.type) AS object_type,
        STRING_AGG(
            CAST(
                CONCAT(
                    p.name, ${US},
                    ISNULL(TYPE_NAME(p.user_type_id), 'unknown'), ${US},
                    p.max_length, ${US},
                    p.precision, ${US},
                    p.scale, ${US},
                    CAST(p.is_output AS int)
                        + CASE WHEN p.has_default_value = 1 THEN 2 ELSE 0 END
                ) AS nvarchar(max)
            ),
            ${RS}
        ) WITHIN GROUP (ORDER BY p.parameter_id) AS parameters_packed
    FROM sys.objects o
    INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
    LEFT JOIN sys.parameters p ON o.object_id = p.object_id AND p.parameter_id > 0
    WHERE o.is_ms_shipped = 0
      AND o.type IN ('FN', 'FS', 'FT', 'IF', 'TF', 'P', 'PC')
    GROUP BY s.name, o.name, o.type
    ORDER BY s.name, o.name
`;

/**
 * Elenco dei database per il cross-database: solo quelli ONLINE, perché uno
 * offline non è interrogabile. `listDatabases` dell'API mssql non filtra lo
 * stato, quindi è solo il ripiego quando questa query fallisce.
 */
export const DATABASES_QUERY = `
    SELECT name
    FROM sys.databases
    WHERE state_desc = 'ONLINE'
    ORDER BY name
`;

// ── Legacy fallbacks (SQL Server 2016 and earlier) ────────────────────────────

/** One row per column. Packed in the extension host instead of on the server. */
export const COLUMNS_QUERY_LEGACY = `
    SELECT
        s.name AS schema_name,
        o.name AS object_name,
        c.name AS column_name,
        ISNULL(TYPE_NAME(c.user_type_id), 'unknown') AS data_type,
        c.max_length,
        c.is_nullable,
        c.is_identity,
        c.is_computed,
        CASE WHEN c.default_object_id <> 0 THEN 1 ELSE 0 END AS has_default,
        CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS is_primary_key
    FROM sys.objects o
    INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
    INNER JOIN sys.columns c ON o.object_id = c.object_id
    LEFT JOIN (
        SELECT ic.object_id, ic.column_id
        FROM sys.index_columns ic
        INNER JOIN sys.indexes i
            ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        WHERE i.is_primary_key = 1
    ) pk ON o.object_id = pk.object_id AND c.column_id = pk.column_id
    WHERE o.is_ms_shipped = 0
      AND o.type IN ('U', 'V')
    ORDER BY s.name, o.name, c.column_id
`;

/** One row per foreign key column. */
export const FOREIGN_KEYS_QUERY_LEGACY = `
    SELECT
        fk.name AS fk_name,
        sch_parent.name AS parent_schema,
        t_parent.name AS parent_table,
        sch_ref.name AS referenced_schema,
        t_ref.name AS referenced_table,
        c_parent.name AS parent_column,
        c_ref.name AS referenced_column
    FROM sys.foreign_keys fk
    INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
    INNER JOIN sys.tables t_parent ON fkc.parent_object_id = t_parent.object_id
    INNER JOIN sys.schemas sch_parent ON t_parent.schema_id = sch_parent.schema_id
    INNER JOIN sys.columns c_parent
        ON fkc.parent_object_id = c_parent.object_id
        AND fkc.parent_column_id = c_parent.column_id
    INNER JOIN sys.tables t_ref ON fkc.referenced_object_id = t_ref.object_id
    INNER JOIN sys.schemas sch_ref ON t_ref.schema_id = sch_ref.schema_id
    INNER JOIN sys.columns c_ref
        ON fkc.referenced_object_id = c_ref.object_id
        AND fkc.referenced_column_id = c_ref.column_id
    ORDER BY sch_parent.name, t_parent.name, fk.name, fkc.constraint_column_id
`;

/** One row per routine parameter. */
export const ROUTINES_QUERY_LEGACY = `
    SELECT
        s.name AS schema_name,
        o.name AS routine_name,
        RTRIM(o.type) AS object_type,
        p.parameter_id,
        p.name AS parameter_name,
        ISNULL(TYPE_NAME(p.user_type_id), 'unknown') AS data_type,
        p.max_length,
        p.precision,
        p.scale,
        p.is_output,
        p.has_default_value
    FROM sys.objects o
    INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
    LEFT JOIN sys.parameters p ON o.object_id = p.object_id AND p.parameter_id > 0
    WHERE o.is_ms_shipped = 0
      AND o.type IN ('FN', 'FS', 'FT', 'IF', 'TF', 'P', 'PC')
    ORDER BY s.name, o.name, p.parameter_id
`;

// ── Letture puntuali ──────────────────────────────────────────────────────────

/** Letterale `N'...'` T-SQL con gli apici raddoppiati. */
function nLiteral(value: string): string {
    return `N'${value.replace(/'/g, "''")}'`;
}

/**
 * Colonne di una sola tabella o vista, una riga per colonna.
 *
 * Per Go to Definition quando lo stadio 1 non ha ancora caricato (o non è
 * riuscito a caricare) le colonne: è una lettura di poche righe.
 */
export function buildTableColumnsQuery(schema: string, name: string): string {
    return `
    SELECT
        c.name AS column_name,
        ISNULL(TYPE_NAME(c.user_type_id), 'unknown') AS data_type,
        c.max_length,
        c.is_nullable,
        CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS is_primary_key
    FROM sys.objects o
    INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
    INNER JOIN sys.columns c ON o.object_id = c.object_id
    LEFT JOIN (
        SELECT ic.object_id, ic.column_id
        FROM sys.index_columns ic
        INNER JOIN sys.indexes i
            ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        WHERE i.is_primary_key = 1
    ) pk ON o.object_id = pk.object_id AND c.column_id = pk.column_id
    WHERE s.name = ${nLiteral(schema)}
      AND o.name = ${nLiteral(name)}
      AND o.type IN ('U', 'V')
    ORDER BY c.column_id
`;
}
