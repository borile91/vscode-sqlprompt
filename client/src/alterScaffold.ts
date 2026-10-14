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

// Parti di un nome T-SQL: [delimitato], "delimitato" o regolare.
const BRACKET_PART = String.raw`\[(?:[^\]]|\]\])*\]`;
const QUOTED_PART = String.raw`"(?:[^"]|"")*"`;
const REGULAR_PART = String.raw`[\p{L}\p{N}_@#$]+`;
const NAME_PART = `(?:${BRACKET_PART}|${QUOTED_PART}|${REGULAR_PART})`;

// Nome parziale in digitazione: fino a due parti complete, poi l'ultima anche
// incompleta (`[My Pr` con spazio, `"My Pr`, `spX` o vuota).
const PARTIAL_LAST_PART = String.raw`(?:\[(?:[^\]]|\]\])*\]?|"(?:[^"]|"")*"?|[\p{L}\p{N}_@#$]*)`;
const PARTIAL_NAME = String.raw`(?:${NAME_PART}\.){0,2}${PARTIAL_LAST_PART}`;

// `ALTER PROC[EDURE] | VIEW | FUNCTION`, then an optional partial (qualified) name.
// Also matches the tail of `CREATE OR ALTER ...`. It runs on the masked line, so
// comments between the keywords are allowed and a header inside a comment or a
// string is not.
const ALTER_HEADER = new RegExp(
    String.raw`\bALTER\s+(PROC(?:EDURE)?|VIEW|FUNCTION)\s+(${PARTIAL_NAME})$`,
    'iu',
);

/**
 * Detects an `ALTER <kind> <partial name>` header that ends at the cursor.
 * `textBeforeCursor` is the text of the current line up to the cursor: an
 * `ALTER` in a line comment, in a block comment opened on the line or in a
 * string is ignored.
 */
export function parseAlterHeader(textBeforeCursor: string): AlterHeader | undefined {
    // Filtro rapido sul testo grezzo prima di mascherare commenti e stringhe.
    if (!/alter/i.test(textBeforeCursor)) {
        return undefined;
    }
    const match = ALTER_HEADER.exec(maskCommentsAndStrings(textBeforeCursor));
    if (!match) {
        return undefined;
    }
    const keyword = match[1].toUpperCase();
    const kind: AlterObjectKind =
        keyword === 'VIEW' ? 'view' : keyword === 'FUNCTION' ? 'function' : 'procedure';
    const nameStart = textBeforeCursor.length - match[2].length;
    return {
        kind,
        alterStart: match.index,
        nameStart,
        typed: textBeforeCursor.slice(nameStart),
    };
}

/** `[name]`, with `]` escaped. */
export function bracketIdentifier(name: string): string {
    return `[${name.replace(/]/g, ']]')}]`;
}

/** `[schema].[name]`: valid whatever the characters of the two names. */
export function bracketQualifiedName(schema: string, name: string): string {
    return `${bracketIdentifier(schema)}.${bracketIdentifier(name)}`;
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

/**
 * Copia del testo con commenti e stringhe sostituiti da spazi, a parità di
 * posizioni (gli a capo restano). I nomi delimitati da [] o "" restano intatti,
 * così un `--` o un apice al loro interno non apre nulla. I commenti a blocco
 * possono essere annidati come in T-SQL; quelli non chiusi arrivano a fine testo.
 */
export function maskCommentsAndStrings(sql: string): string {
    const out = sql.split('');
    const blank = (from: number, to: number) => {
        for (let k = from; k < to; k++) {
            if (out[k] !== '\n' && out[k] !== '\r') {
                out[k] = ' ';
            }
        }
    };
    let i = 0;
    while (i < sql.length) {
        const ch = sql[i];
        const next = sql[i + 1];
        if (ch === '-' && next === '-') {
            const newline = sql.indexOf('\n', i);
            const end = newline < 0 ? sql.length : newline;
            blank(i, end);
            i = end;
        } else if (ch === '/' && next === '*') {
            let depth = 1;
            let j = i + 2;
            while (j < sql.length && depth > 0) {
                if (sql[j] === '/' && sql[j + 1] === '*') {
                    depth++;
                    j += 2;
                } else if (sql[j] === '*' && sql[j + 1] === '/') {
                    depth--;
                    j += 2;
                } else {
                    j++;
                }
            }
            blank(i, j);
            i = j;
        } else if (ch === "'" || ch === '[' || ch === '"') {
            // Delimitatore raddoppiato = carattere letterale ('' , ]] , "").
            const close = ch === '[' ? ']' : ch;
            let j = i + 1;
            while (j < sql.length) {
                if (sql[j] === close) {
                    if (sql[j + 1] === close) {
                        j += 2;
                        continue;
                    }
                    j++;
                    break;
                }
                j++;
            }
            if (ch === "'") {
                blank(i, j);
            }
            i = j;
        } else {
            i++;
        }
    }
    return out.join('');
}

const CREATE_KEYWORD = /\bCREATE\b/gi;
const OR_ALTER = /^\s+OR\s+ALTER\b/i;
const KIND_KEYWORD = /^\s+(?:PROC(?:EDURE)?|VIEW|FUNCTION)\b/i;
const FULL_NAME = new RegExp(String.raw`^(\s*)(${NAME_PART}(?:\s*\.\s*${NAME_PART}){0,2})`, 'u');

/**
 * Rewrites the first `CREATE [OR ALTER] PROC|VIEW|FUNCTION` of a stored
 * definition into `ALTER ...`. Leading comments are kept untouched, a `CREATE`
 * inside a comment or a string is not taken for the header, and comments
 * between the keywords are allowed.
 *
 * When `target` is given, the object name in the header (one to three parts,
 * plain or delimited) is replaced by `[schema].[name]`, as SSMS "Script as
 * ALTER" does: the stored text keeps the name used at creation, which is stale
 * after `sp_rename` or `ALTER SCHEMA ... TRANSFER` and may lack the schema.
 *
 * Returns `undefined` when the text has no such header.
 */
export function toAlterScript(
    definition: string,
    target?: { schema: string; name: string },
): string | undefined {
    const masked = maskCommentsAndStrings(definition);
    CREATE_KEYWORD.lastIndex = 0;
    let create: RegExpExecArray | null;
    while ((create = CREATE_KEYWORD.exec(masked))) {
        const createStart = create.index;
        let pos = createStart + create[0].length;
        // Con `OR ALTER` si toglie tutto fino al secondo ALTER; altrimenti solo
        // la keyword CREATE, e i commenti che seguono restano.
        const orAlter = OR_ALTER.exec(masked.slice(pos));
        const keepFrom = orAlter ? pos + orAlter[0].length : pos;
        const kind = KIND_KEYWORD.exec(masked.slice(keepFrom));
        if (!kind) {
            continue;
        }
        pos = keepFrom + kind[0].length;

        let header = definition.slice(keepFrom, pos);
        let rest = definition.slice(pos);
        const name = target ? FULL_NAME.exec(masked.slice(pos)) : null;
        if (name && target) {
            header += definition.slice(pos, pos + name[1].length) +
                bracketQualifiedName(target.schema, target.name);
            rest = definition.slice(pos + name[0].length);
        }

        const rewritten = definition.slice(0, createStart) + 'ALTER' + header + rest;
        return rewritten.replace(/\r\n/g, '\n');
    }
    return undefined;
}
