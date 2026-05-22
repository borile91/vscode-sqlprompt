import type { SqlPromptStyleJson } from './styleLoader';

/**
 * Post-processes sql-formatter output to apply DDL column definition formatting:
 *
 * - `ddl.verticallyAlignDataTypes: true` — in CREATE TABLE / ALTER TABLE column
 *   definition lists, data type names are padded so they all start at the same
 *   column (the column after the longest column name + 1 space).
 *
 * This formatter detects CREATE TABLE / ALTER TABLE blocks and processes the
 * column definition lines inside their parentheses.
 */
export function applyDdlFormatting(sql: string, style: SqlPromptStyleJson): string {
    if (!style.ddl?.verticallyAlignDataTypes) return sql;
    return alignDdlDataTypes(sql);
}

// ─────────────────────────────────────────────────────────────────────────────
// Procedure body indentation  (ddl.indentClauses)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * When `ddl.indentClauses === true`, indents the entire body of a stored
 * procedure/function by `tabWidth` spaces.
 *
 * The body begins on the line after a standalone `AS` that was emitted by
 * `applyDdlProcFormatting` (i.e. `AS` alone on a line following the closing
 * `)` of the parameter list).
 *
 * Must run AFTER `applyControlFlowIndentation` so that BEGIN/END keywords are
 * already at their correct relative indentation; this pass simply prepends the
 * base `tabWidth` spaces to every content line in the body.
 */
export function applyProcBodyIndentation(
    sql: string,
    style: SqlPromptStyleJson,
    tabWidth: number,
): string {
    if (!style.ddl?.indentClauses) return sql;

    const lines = sql.split('\n');
    const result: string[] = [];
    let inBody = false;
    const pad = ' '.repeat(tabWidth);

    for (const line of lines) {
        if (!inBody) {
            result.push(line);
            // A standalone `AS` line signals the start of the procedure body.
            // This is only produced by applyDdlProcFormatting for PROC/FUNC headers.
            if (line.trim() === 'AS') {
                inBody = true;
            }
            continue;
        }
        // GO is a batch separator — must always remain at column 0
        if (/^[ \t]*GO\s*$/i.test(line)) {
            result.push(line.trim());
            inBody = false;
            continue;
        }
        // Indent every line in the procedure body (blank lines stay blank)
        result.push(line === '' ? '' : pad + line);
    }

    return result.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE PROCEDURE / FUNCTION parameter list formatting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Matches the beginning of a CREATE PROCEDURE/FUNCTION/PROC line up to and
 * including the opening `(` of the parameter list.
 *
 * Group 1 — everything before the `(` (including optional leading whitespace).
 */
const CREATE_PROC_RE =
    /^([ \t]*CREATE\s+(?:OR\s+REPLACE\s+)?(?:PROCEDURE|FUNCTION|PROC)\s+\S+)\s*\(/i;

/**
 * Splits a parameter-list string (the text between the outer `(` and `)`) at
 * top-level commas, respecting:
 *   - Nested parentheses  e.g. `NUMERIC(12, 3)`, `VARCHAR(50)`
 *   - Single-quoted string literals  e.g. `= 'XXXXX'`
 *   - Line comments  e.g. `@p BIT -- some comment`
 *     (the newline that terminates the comment resets the comment state; any
 *      comma that falls on a standalone comma line is still treated as a
 *      top-level separator)
 */
function splitParamList(s: string): string[] {
    const params: string[] = [];
    let depth = 0;
    let start = 0;
    let inLineComment = false;

    for (let i = 0; i < s.length; i++) {
        const ch = s[i];

        // Line-comment: ignore everything from "--" to the next newline
        if (!inLineComment && ch === '-' && s[i + 1] === '-') {
            inLineComment = true;
            i++; // skip second '-'
            continue;
        }
        if (inLineComment) {
            if (ch === '\n') inLineComment = false;
            continue;
        }

        // Single-quoted string literal
        if (ch === "'") {
            i++;
            while (i < s.length && s[i] !== "'") i++;
            // i now points at the closing quote (or past the end)
            continue;
        }

        if (ch === '(') {
            depth++;
        } else if (ch === ')') {
            depth--;
        } else if (ch === ',' && depth === 0) {
            const param = s.slice(start, i).trim();
            if (param.length > 0) params.push(param);
            start = i + 1;
        }
    }

    const last = s.slice(start).trim();
    if (last.length > 0) params.push(last);
    return params;
}

/**
 * Post-processes sql-formatter output to reformat CREATE PROCEDURE / FUNCTION
 * parameter lists when `ddl.placeFirstProcedureParameterOnNewLine === "always"`:
 *
 * Input (sql-formatter standard mode, single line or multi-line):
 *   CREATE PROCEDURE rf.spLoadItem (@stab VARCHAR(3), @maga VARCHAR(3)) AS
 *
 * Output:
 *   CREATE PROCEDURE rf.spLoadItem
 *       (
 *       @stab VARCHAR(3)
 *     , @maga VARCHAR(3)
 *       )
 *   AS
 *
 * The indentation uses `tabWidth`.  Commas are placed at `tabWidth - 2` spaces
 * so that the parameter name aligns with the first parameter (comma-first style).
 */
export function applyDdlProcFormatting(
    sql: string,
    style: SqlPromptStyleJson,
    tabWidth: number,
): string {
    if (style.ddl?.placeFirstProcedureParameterOnNewLine !== 'always') return sql;

    const lines = sql.split('\n');
    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const procMatch = line.match(CREATE_PROC_RE);

        if (!procMatch) {
            result.push(line);
            i++;
            continue;
        }

        // Leading whitespace of the CREATE PROCEDURE line (for nested contexts)
        const lineIndent = (procMatch[1].match(/^([ \t]*)/) ?? ['', ''])[1];
        // Normalise the proc head (collapse internal whitespace, drop leading indent)
        const procHead = procMatch[1].replace(/\s+/g, ' ').trimStart();

        // Collect all text starting from the `(` to the matching `)`.
        // sql-formatter may have split the params across multiple lines.
        const openParenIdx = procMatch[0].length - 1; // index of `(` in `line`
        let collected = line.slice(openParenIdx); // starts with `(`
        let tempI = i + 1;

        // Find the matching close paren (depth-tracking over the collected text)
        const findClose = (text: string): number => {
            let depth = 0;
            for (let k = 0; k < text.length; k++) {
                if (text[k] === '(') depth++;
                else if (text[k] === ')') { depth--; if (depth === 0) return k; }
            }
            return -1;
        };

        let closeIdx = findClose(collected);
        while (closeIdx === -1 && tempI < lines.length) {
            collected += '\n' + lines[tempI];
            tempI++;
            closeIdx = findClose(collected);
        }

        if (closeIdx === -1) {
            // Unbalanced — leave as-is
            result.push(line);
            i++;
            continue;
        }

        const paramContent = collected.slice(1, closeIdx); // between ( and )
        const afterClose = collected.slice(closeIdx + 1).trim(); // e.g. "AS"

        const params = splitParamList(paramContent);

        if (params.length === 0) {
            // Empty param list — leave as-is
            result.push(line);
            i++;
            continue;
        }

        const bodyIndent = ' '.repeat(tabWidth);
        const commaIndent = ' '.repeat(Math.max(0, tabWidth - 2));

        result.push(lineIndent + procHead);
        result.push(lineIndent + bodyIndent + '(');

        for (let p = 0; p < params.length; p++) {
            const param = params[p];
            if (p === 0) {
                result.push(lineIndent + bodyIndent + param);
            } else {
                result.push(lineIndent + commaIndent + ', ' + param);
            }
        }

        result.push(lineIndent + bodyIndent + ')');

        if (afterClose) {
            result.push(lineIndent + afterClose);
        }

        i = tempI;
    }

    return result.join('\n');
}


/**
 * Matches a CREATE or ALTER TABLE/PROCEDURE statement opening.
 * We only process CREATE TABLE / ALTER TABLE for column alignment.
 */
const CREATE_ALTER_RE = /^\s*(?:CREATE|ALTER)\s+TABLE\b/i;

/**
 * Matches a column definition line inside a CREATE TABLE block.
 * Captures: [indent, columnName, dataType, remainder]
 *
 * Handles both plain identifiers and bracket-quoted identifiers:
 *   OrderID         INT           NOT NULL
 *   [Order Date]    DATETIME      NOT NULL
 */
const COLUMN_DEF_RE = /^(\s+)(\[?[a-zA-Z_@#][a-zA-Z0-9_@#$]*\]?|\[[^\]]+\])\s+(\S+)(.*)/;

/**
 * Matches lines that are constraints (PRIMARY KEY, FOREIGN KEY, UNIQUE, CHECK,
 * INDEX) — these don't get data type alignment.
 */
const CONSTRAINT_RE = /^\s+(?:PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|INDEX|CONSTRAINT)\b/i;

/**
 * Matches a leading-comma column definition (default style):
 *   , OrderDate DATETIME NOT NULL
 */
const LEADING_COMMA_COL_RE = /^(\s+,\s+)(\[?[a-zA-Z_@#][a-zA-Z0-9_@#$]*\]?|\[[^\]]+\])\s+(\S+)(.*)/;

interface ColumnDef {
    /** Full original line */
    original: string;
    /** Leading whitespace/comma prefix */
    prefix: string;
    /** Column name */
    name: string;
    /** Data type */
    dataType: string;
    /** Everything after the data type */
    remainder: string;
    /** Whether this is a definition line (vs constraint/other) */
    isDefinition: boolean;
}

export function alignDdlDataTypes(sql: string): string {
    const lines = sql.split('\n');
    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // Detect start of a CREATE/ALTER TABLE block
        if (CREATE_ALTER_RE.test(line)) {
            result.push(line);
            i++;

            // Scan ahead to find the opening paren and collect column defs
            // The opening paren may be on the CREATE TABLE line itself or on the
            // next line (when ddl.openingParenthesisBreakType: "always").
            let blockLines: string[] = [];
            let openCount = 0;
            let blockStartIdx = i;

            // Count parens to find the matching close
            while (i < lines.length) {
                const blockLine = lines[i];
                for (const ch of blockLine) {
                    if (ch === '(') openCount++;
                    else if (ch === ')') openCount--;
                }
                blockLines.push(blockLine);
                i++;
                // Stop after we've closed all open parens (including the one from
                // the CREATE TABLE line if any)
                if (openCount <= 0 && blockLines.length > 0) break;
            }
            // If we never found a paren block, just emit the lines as-is
            if (openCount > 0) {
                result.push(...blockLines);
                continue;
            }

            result.push(...processCreateTableBlock(blockLines));
            continue;
        }

        result.push(line);
        i++;
    }

    return result.join('\n');
}

/**
 * Processes a block of lines that came after a CREATE/ALTER TABLE header
 * (i.e. from the opening `(` to the closing `)`).
 * Aligns data types in column definition lines.
 */
function processCreateTableBlock(lines: string[]): string[] {
    // Parse each line into a ColumnDef (or mark as non-definition)
    const defs: ColumnDef[] = lines.map(line => {
        if (CONSTRAINT_RE.test(line)) {
            return { original: line, prefix: '', name: '', dataType: '', remainder: '', isDefinition: false };
        }

        // Try leading-comma style first
        const lcMatch = line.match(LEADING_COMMA_COL_RE);
        if (lcMatch) {
            return {
                original: line,
                prefix: lcMatch[1],
                name: lcMatch[2],
                dataType: lcMatch[3],
                remainder: lcMatch[4],
                isDefinition: true,
            };
        }

        // Try standard indented definition
        const stdMatch = line.match(COLUMN_DEF_RE);
        if (stdMatch) {
            return {
                original: line,
                prefix: stdMatch[1],
                name: stdMatch[2],
                dataType: stdMatch[3],
                remainder: stdMatch[4],
                isDefinition: true,
            };
        }

        return { original: line, prefix: '', name: '', dataType: '', remainder: '', isDefinition: false };
    });

    // Compute max (prefix.length + name.length) across all definition lines so
    // that data types start at the same absolute column regardless of whether
    // the line uses a standard indent or a leading-comma prefix.
    let maxPrefixPlusNameLen = 0;
    for (const d of defs) {
        if (d.isDefinition) {
            maxPrefixPlusNameLen = Math.max(maxPrefixPlusNameLen, d.prefix.length + d.name.length);
        }
    }

    if (maxPrefixPlusNameLen === 0) return lines;

    // Re-emit lines with aligned data types
    return defs.map(d => {
        if (!d.isDefinition) return d.original;
        const targetNameLen = maxPrefixPlusNameLen - d.prefix.length;
        const paddedName = d.name.padEnd(targetNameLen);
        return d.prefix + paddedName + ' ' + d.dataType + d.remainder;
    });
}
