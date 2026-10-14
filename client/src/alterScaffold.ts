/**
 * Alter scaffolding
 *
 * After `ALTER PROCEDURE|VIEW|FUNCTION ` the editor offers the existing objects
 * of that kind; accepting one replaces the `ALTER ...` header with the current
 * definition of the object (CREATE rewritten to ALTER), ready to be edited.
 *
 * Everything in this file is pure (no VS Code API) so it can be unit tested.
 */

export type AlterObjectKind = 'procedure' | 'view' | 'function';

export interface AlterHeader {
    kind: AlterObjectKind;
    /** Column where the `ALTER` keyword starts. */
    alterStart: number;
    /** Column where the object name being typed starts. */
    nameStart: number;
    /** What has been typed so far for the object name (may be empty). */
    typed: string;
}

// `ALTER PROC[EDURE] | VIEW | FUNCTION`, then an optional partial (qualified) name.
// Also matches the tail of `CREATE OR ALTER ...`.
const ALTER_HEADER =
    /\bALTER\s+(PROC(?:EDURE)?|VIEW|FUNCTION)\s+([\w.\[\]]*)$/i;

/**
 * Detects an `ALTER <kind> <partial name>` header that ends at the cursor.
 * `textBeforeCursor` is the text of the current line up to the cursor.
 */
export function parseAlterHeader(textBeforeCursor: string): AlterHeader | undefined {
    const match = ALTER_HEADER.exec(textBeforeCursor);
    if (!match) {
        return undefined;
    }
    const keyword = match[1].toUpperCase();
    const kind: AlterObjectKind =
        keyword === 'VIEW' ? 'view' : keyword === 'FUNCTION' ? 'function' : 'procedure';
    const typed = match[2];
    return {
        kind,
        alterStart: match.index,
        nameStart: textBeforeCursor.length - typed.length,
        typed,
    };
}

/** `sys.objects.type` codes covered by each kind. */
const OBJECT_TYPES: Record<AlterObjectKind, string[]> = {
    procedure: ['P', 'PC'],
    view: ['V'],
    function: ['FN', 'IF', 'TF', 'FS', 'FT'],
};

/** Query listing the user objects of a kind (columns: schema_name, object_name). */
export function buildObjectListQuery(kind: AlterObjectKind): string {
    const types = OBJECT_TYPES[kind].map((t) => `'${t}'`).join(', ');
    return `
        SELECT s.name AS schema_name, o.name AS object_name
        FROM sys.objects o
        INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
        WHERE o.type IN (${types}) AND o.is_ms_shipped = 0
        ORDER BY s.name, o.name
    `;
}

/** Query returning the module definition of one object (column: definition). */
export function buildDefinitionQuery(schema: string, name: string): string {
    const esc = (value: string) => value.replace(/'/g, "''");
    return `
        SELECT sm.definition
        FROM sys.sql_modules sm
        INNER JOIN sys.objects o ON sm.object_id = o.object_id
        INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
        WHERE s.name = N'${esc(schema)}' AND o.name = N'${esc(name)}'
    `;
}

const CREATE_HEADER = /\bCREATE\s+(?:OR\s+ALTER\s+)?(PROC(?:EDURE)?|VIEW|FUNCTION)\b/i;

/** Copia del testo con commenti e stringhe sostituiti da spazi, a parità di posizioni. */
function maskCommentsAndStrings(sql: string): string {
    return sql.replace(/--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:[^']|'')*'?/g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Rewrites the first `CREATE [OR ALTER] PROC|VIEW|FUNCTION` of a stored
 * definition into `ALTER ...`. Leading comments are kept untouched, and a
 * `CREATE` inside a comment or a string is not taken for the header.
 * Returns `undefined` when the text has no such header.
 */
export function toAlterScript(definition: string): string | undefined {
    const match = CREATE_HEADER.exec(maskCommentsAndStrings(definition));
    if (!match) {
        return undefined;
    }
    const rewritten =
        definition.slice(0, match.index) +
        `ALTER ${match[1]}` +
        definition.slice(match.index + match[0].length);
    return rewritten.replace(/\r\n/g, '\n');
}
