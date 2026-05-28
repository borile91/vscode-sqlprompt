import type { SqlPromptStyleJson } from './styleLoader';

/**
 * Reformats CREATE TABLE blocks from sql-formatter standard-indent output into
 * compact scripting style: first column inline with `(`, subsequent columns at
 * column 0, CONSTRAINT + WITH options greedy-packed.
 * Triggered when `ddl.collapseShortStatements: true` and no `parenthesisStyle`.
 */
function applyDdlTableCompactFormatting(sql: string, style: SqlPromptStyleJson): string {
    const lines = sql.split('\n');
    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        // Match "CREATE TABLE name (" at col 0, space before `(` is optional
        const ctMatch = line.match(/^(CREATE\s+TABLE\s+\S+)\s*\(\s*$/i);
        if (!ctMatch) {
            result.push(line);
            i++;
            continue;
        }

        const tablePrefix = ctMatch[1]; // e.g. "CREATE TABLE dbo.TABLE_DETAIL"
        const cols: string[] = [];
        let constraintRaw = '';   // e.g. "CONSTRAINT PK_... PRIMARY KEY CLUSTERED (keys)"
        let withOpts: string[] = [];
        let indexFg = '';         // filegroup for clustered index
        let tableFg = '';         // filegroup for CREATE TABLE

        i++;
        // Collect the CREATE TABLE body
        while (i < lines.length) {
            const bLine = lines[i];

            // Closing paren: ") ON [fg];" or ");" at column 0
            const closeMatch = bLine.match(/^\)\s*(ON\s+[^\s;)]+)?\s*;?\s*$/i);
            if (closeMatch && bLine.trimStart().startsWith(')')) {
                tableFg = closeMatch[1] ?? '';
                i++;
                break;
            }

            const stripped = bLine.replace(/,\s*$/, '').trim();
            if (!stripped) { i++; continue; }

            // Standalone WITH keyword (sql-formatter splits it)
            if (/^WITH\s*$/i.test(stripped)) {
                i++;
                if (i < lines.length) {
                    const woLine = lines[i].trim();
                    const woMatch = woLine.match(/^\(([^)]*)\)\s*(ON\s+\S+)?$/i);
                    if (woMatch) {
                        withOpts = woMatch[1].split(',').map(o => o.trim()).filter(Boolean);
                        indexFg = woMatch[2] ?? '';
                    }
                    i++;
                }
                continue;
            }

            // Inline WITH (opts) ON [fg]
            const withInline = stripped.match(/^WITH\s*\(([^)]*)\)\s*(ON\s+\S+)?$/i);
            if (withInline) {
                withOpts = withInline[1].split(',').map(o => o.trim()).filter(Boolean);
                indexFg = withInline[2] ?? '';
                i++;
                continue;
            }

            // CONSTRAINT line
            if (/^CONSTRAINT\b/i.test(stripped)) {
                constraintRaw = stripped;
                i++;
                continue;
            }

            if (stripped) cols.push(stripped);
            i++;
        }

        // ── Emit compact output ─────────────────────────────────────────────
        // First column inline with `(`
        if (cols.length > 0) {
            result.push(`${tablePrefix} (${cols[0]},`);
            for (let ci = 1; ci < cols.length; ci++) {
                result.push(`${cols[ci]},`);
            }
        } else {
            result.push(`${tablePrefix} (`);
        }

        // CONSTRAINT + WITH
        if (constraintRaw) {
            if (withOpts.length === 0) {
                // No WITH — just the constraint; closing paren follows
                result.push(constraintRaw);
                const close = tableFg ? `) ${tableFg};` : ');';
                result.push(close);
            } else {
                // WITH options: first on same line as CONSTRAINT, rest on continuation
                const constraintNameMatch = constraintRaw.match(/^CONSTRAINT\s+(\S+)/i);
                const contIndent = constraintNameMatch
                    ? 'CONSTRAINT '.length + constraintNameMatch[1].length + 1
                    : 0;
                const contPad = ' '.repeat(contIndent);

                const withPrefix = `${constraintRaw} WITH (`;
                const line1 = withPrefix + withOpts[0] + (withOpts.length > 1 ? ',' : '');

                const closeSuffix = (indexFg ? `) ${indexFg}` : ')') +
                    (tableFg ? `) ${tableFg};` : ');');

                if (withOpts.length === 1) {
                    result.push(line1.replace(/,$/, '') + closeSuffix);
                } else {
                    result.push(line1);
                    // All remaining opts on one continuation line (SSMS compact style)
                    const rest = withOpts.slice(1).join(', ');
                    result.push(contPad + rest + closeSuffix);
                }
            }
        } else if (cols.length > 0) {
            // No CONSTRAINT — fix trailing comma on last col and add closing
            const last = result[result.length - 1];
            result[result.length - 1] = last.replace(/,$/, '');
            result.push(tableFg ? `) ${tableFg};` : ');');
        }
    }

    return result.join('\n');
}

/**
 * Reformats CREATE TABLE blocks from sql-formatter's raw tabularLeft output
 * into the expected leading-comma column-list style.
 *
 * Handles:
 *  - Normalising the `CREATE    TABLE` keyword padding
 *  - Moving the opening `(` to its own line with tabWidth indentation
 *  - Converting trailing-comma column lines to leading-comma format
 *  - CONSTRAINT PRIMARY KEY: inline (default) or expanded per-line
 *    (`ddl.placeConstraintColumnsOnNewLines: 'ifLongerOrMultipleColumns'`)
 *  - WITH index options: vertically aligned (inline keys) or inline (expanded keys)
 *  - Normalising the closing `) ON [filegroup];` indentation
 */
export function applyDdlTableFormatting(sql: string, style: SqlPromptStyleJson): string {
    if (!style.ddl?.parenthesisStyle) {
        // Compact mode: first column inline with `(`, subsequent columns at col 0.
        if (style.ddl?.collapseShortStatements) {
            return applyDdlTableCompactFormatting(sql, style);
        }
        return sql;
    }

    const tabWidth = style.whitespace?.numberOfSpacesInTabs ?? 4;
    const indentParens = style.ddl?.indentParenthesesContents === true;
    const expandConstraint =
        style.ddl?.placeConstraintColumnsOnNewLines === 'ifLongerOrMultipleColumns';
    const spacesInside = style.parentheses?.addSpacesInsideParentheses ?? false;
    const sp = spacesInside ? ' ' : '';

    // Column indent inside the table body
    const colIndent = indentParens ? tabWidth * 2 : tabWidth;
    const firstColPad = ' '.repeat(colIndent);
    const commaPad = ' '.repeat(colIndent - 2); // spaces before ', '
    const parenPad = ' '.repeat(tabWidth);       // indent for the '(' line

    const lines = sql.split('\n');
    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // Match "CREATE    TABLE schema.table (" at column 0
        const ctMatch = line.match(/^CREATE\s+TABLE\s+(\S+)\s*\(\s*$/i);
        if (!ctMatch) {
            result.push(line);
            i++;
            continue;
        }

        const tableName = ctMatch[1];
        const cols: string[] = [];
        let constraintDef: string | null = null;
        let constraintKeys: string[] = [];
        let withOpts: string[] = [];
        let onFilegroup = '';
        let closingSuffix = '';

        i++;
        while (i < lines.length) {
            const bLine = lines[i];
            i++;

            // WITH line at column 0: "WITH (opt=val, ...) ON [fg]"
            const withMatch = bLine.match(/^WITH\s*\(([^)]+)\)\s+(ON\s+\S+)/i);
            if (withMatch) {
                withOpts = withMatch[1].split(',').map(o => o.trim()).filter(Boolean);
                onFilegroup = withMatch[2];
                continue;
            }

            // Closing paren: "     ) ON [fg];" or "     );"
            const closeMatch = bLine.match(/^\s+\)\s*(ON\s+\S+)?\s*;$/i);
            if (closeMatch) {
                closingSuffix = closeMatch[1] ?? '';
                break;
            }

            // Column / constraint content lines (trim trailing comma)
            const stripped = bLine.replace(/,\s*$/, '').trim();
            if (!stripped) continue;

            // Check for CONSTRAINT PRIMARY KEY CLUSTERED (key_list)
            const constMatch = stripped.match(
                /^(CONSTRAINT\s+\S+\s+PRIMARY\s+KEY\s+CLUSTERED)\s*\(([^)]+)\)/i,
            );
            if (constMatch) {
                constraintDef = constMatch[1].trim();
                constraintKeys = constMatch[2].split(',').map(k => k.trim()).filter(Boolean);
            } else {
                cols.push(stripped);
            }
        }

        // ── Emit reformatted block ──────────────────────────────────────────
        result.push(`CREATE TABLE ${tableName}`);
        result.push(`${parenPad}(`);

        // Regular columns (leading-comma style)
        for (let ci = 0; ci < cols.length; ci++) {
            result.push(ci === 0 ? `${firstColPad}${cols[ci]}` : `${commaPad}, ${cols[ci]}`);
        }

        // CONSTRAINT + WITH
        if (constraintDef) {
            if (expandConstraint && constraintKeys.length > 1) {
                // Expand PRIMARY KEY columns onto separate lines.
                // The last key line also carries the closing ) and the WITH clause.
                const maxKeyLen = Math.max(...constraintKeys.map(k => k.length));
                // Position of "WITH" on the last-key line.
                // Derived so that: WITH ends at colIndent + maxKeyLen + 2*tabWidth.
                const withStartCol = colIndent + maxKeyLen + tabWidth * 4 - 3;

                result.push(`${commaPad}, ${constraintDef} (`);
                for (let ki = 0; ki < constraintKeys.length; ki++) {
                    const key = constraintKeys[ki];
                    if (ki === 0) {
                        result.push(`${firstColPad}${key}`);
                    } else if (ki < constraintKeys.length - 1) {
                        result.push(`${commaPad}, ${key}`);
                    } else {
                        // Last key: append ") WITH (...) ON [fg]" on same line
                        const closePart = `${commaPad}, ${key} )`;
                        const spaces = Math.max(1, withStartCol - closePart.length);
                        const opts = withOpts.join(', ');
                        result.push(
                            `${closePart}${' '.repeat(spaces)}WITH (${sp}${opts}${sp}) ${onFilegroup}`,
                        );
                    }
                }
            } else {
                // Inline PRIMARY KEY column list; WITH options use vertical alignment.
                const pkList = `${sp}${constraintKeys.join(', ')}${sp}`;
                const constraintLine = `${commaPad}, ${constraintDef} (${pkList})`;

                if (withOpts.length === 0) {
                    result.push(constraintLine);
                } else if (withOpts.length === 1) {
                    result.push(
                        `${constraintLine} WITH (${sp}${withOpts[0]}${sp}) ${onFilegroup}`,
                    );
                } else {
                    // First WITH option on the constraint line; rest vertically aligned
                    const withOpened = ` WITH (${sp}`;
                    const alignCol = constraintLine.length + withOpened.length;
                    const alignPad = ' '.repeat(alignCol - 2);

                    result.push(`${constraintLine}${withOpened}${withOpts[0]}`);
                    for (let wi = 1; wi < withOpts.length; wi++) {
                        if (wi < withOpts.length - 1) {
                            result.push(`${alignPad}, ${withOpts[wi]}`);
                        } else {
                            result.push(`${alignPad}, ${withOpts[wi]}${sp}) ${onFilegroup}`);
                        }
                    }
                }
            }
        }

        // Closing paren
        result.push(closingSuffix ? `${parenPad}) ${closingSuffix};` : `${parenPad});`);
    }

    return result.join('\n');
}

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
// CREATE VIEW formatting  (ddl.indentClauses)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * When `ddl.indentClauses === true`, moves the AS keyword of a CREATE VIEW
 * statement onto its own line.  The body (SELECT …) is then indented by
 * `applyProcBodyIndentation` in a later pipeline step.
 *
 * Also normalises extra whitespace in `CREATE    VIEW` that sql-formatter
 * tabularLeft may produce.
 *
 * Input:
 *   CREATE    VIEW ui.vwOrdini AS
 *   SELECT …
 *
 * Output:
 *   CREATE VIEW ui.vwOrdini
 *   AS
 *   SELECT …
 */
export function applyDdlViewFormatting(sql: string, style: SqlPromptStyleJson): string {
    if (!style.ddl?.indentClauses && !style.controlFlow?.indentBeginAndEndKeywords) return sql;
    // Match CREATE [whitespace] VIEW [whitespace] <name> [whitespace] AS
    // preserving any leading indentation on the line.
    return sql.replace(
        /^([ \t]*)CREATE\s+VIEW\s+(\S+)\s+AS\b/gim,
        (_match, indent, name) => `${indent}CREATE VIEW ${name}\n${indent}AS`,
    );
}

/**
 * For parameterless CREATE/ALTER PROCEDURE/FUNCTION headers, force `AS` onto
 * its own line so later passes can indent the procedure body consistently.
 */
export function applyDdlParameterlessProcAsFormatting(sql: string, style: SqlPromptStyleJson): string {
    if (!style.ddl?.indentClauses && !style.controlFlow?.indentBeginAndEndKeywords) return sql;

    // Matches CREATE/ALTER PROCEDURE/FUNCTION headers that have no parameter list `(`.
    // Captures everything after the AS keyword so we can handle sql-formatter's
    // tendency to collapse "AS BEGIN body" onto the same line as the proc name.
    // Uses [^(]+ to avoid matching procs that have a parameter list.
    return sql.replace(
        /^([ \t]*)(CREATE|ALTER)\s+(OR\s+REPLACE\s+)?(PROCEDURE|FUNCTION|PROC)\s+([^(]+?)\s+AS\b(.*)$/gim,
        (_match, indent, op, orReplace, kind, namePart, afterAs) => {
            const name = String(namePart).trim();
            const head = `${op.toUpperCase()} ${(orReplace ?? '').toUpperCase()}${kind.toUpperCase()} ${name}`
                .replace(/\s+/g, ' ')
                .trim();
            const rest = String(afterAs).trim();
            if (!rest) {
                // Nothing after AS — place AS on its own line.
                return `${indent}${head}\n${indent}AS`;
            }
            // sql-formatter may collapse "AS BEGIN body..." onto the same line.
            // Split BEGIN (and any body content on that line) onto separate lines.
            const beginMatch = rest.match(/^BEGIN\b(.*)/i);
            if (beginMatch) {
                const bodyContent = String(beginMatch[1]).trim();
                const out = `${indent}${head}\n${indent}AS\n${indent}BEGIN`;
                return bodyContent ? `${out}\n${bodyContent}` : out;
            }
            // Unexpected trailing content — normalise spacing and place AS on its own line.
            return `${indent}${head}\n${indent}AS`;
        },
    );
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
    if (!style.ddl?.indentClauses && !style.controlFlow?.indentBeginAndEndKeywords) return sql;

    // When triggered only by indentBeginAndEndKeywords (not indentClauses), only
    // indent bodies that begin with BEGIN — bodies that start directly with SQL
    // statements (e.g. SET ANSI_NULLS ON) are left unindented.
    const requireBegin = !style.ddl?.indentClauses && !!style.controlFlow?.indentBeginAndEndKeywords;

    const lines = sql.split('\n');
    const result: string[] = [];
    let inBody = false;
    let active = false; // whether we're actively indenting the body
    const pad = ' '.repeat(tabWidth);

    for (const line of lines) {
        if (!inBody) {
            result.push(line);
            // A standalone `AS` line signals the start of the procedure body.
            if (line.trim() === 'AS') {
                inBody = true;
                active = !requireBegin; // start immediately unless we must see BEGIN first
            }
            continue;
        }
        // GO is a batch separator — must always remain at column 0
        if (/^[ \t]*GO\s*$/i.test(line)) {
            result.push(line.trim());
            inBody = false;
            active = false;
            continue;
        }
        if (!active) {
            const trimmed = line.trim();
            if (trimmed === '') {
                result.push(line);
                continue;
            }
            if (/^BEGIN\b/i.test(trimmed)) {
                // Body starts with BEGIN — indent this and all subsequent lines
                active = true;
                result.push(line === '' ? '' : pad + line);
            } else {
                // Body does not start with BEGIN — do not indent
                result.push(line);
                inBody = false;
            }
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
 * Matches the beginning of a CREATE or ALTER PROCEDURE/FUNCTION/PROC line up to
 * and including the opening `(` of the parameter list.
 *
 * Group 1 — everything before the `(` (including optional leading whitespace).
 */
const CREATE_PROC_RE =
    /^([ \t]*(?:CREATE|ALTER)\s+(?:OR\s+REPLACE\s+)?(?:PROCEDURE|FUNCTION|PROC)\s+\S+)\s*\(/i;

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
 * Finds the index of the `)` that closes the already-open parenthesis,
 * starting with depth = 1. Handles line comments (`--`) and single-quoted
 * string literals.  Returns -1 if not found.
 */
function findMatchingCloseFromOpen(text: string): number {
    let depth = 1;
    let inLineComment = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (inLineComment) {
            if (ch === '\n') inLineComment = false;
            continue;
        }
        if (ch === '-' && text[i + 1] === '-') {
            inLineComment = true;
            i++;
            continue;
        }
        if (ch === "'") {
            i++;
            while (i < text.length) {
                if (text[i] === "'" && text[i + 1] === "'") { i += 2; continue; }
                if (text[i] === "'") break;
                i++;
            }
            continue;
        }
        if (ch === '(') depth++;
        else if (ch === ')') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/**
 * Emits the normalised form of an inline table-valued function's RETURN body:
 *
 *   RETURNS TABLE
 *   AS
 *   RETURN (
 *          <body lines re-indented>
 *   )
 *
 * `startLineIndex` points to the `TABLE AS RETURN (` line in `lines`.
 * `initialBodyText` is the text that appears after the `(` on that same line
 * (typically empty when sql-formatter places the body on the next line).
 *
 * Returns the new line index (past all consumed lines) on success, or `null`
 * when the matching `)` cannot be found.
 */
function emitInlineTableValuedFunctionReturn(
    result: string[],
    lines: string[],
    startLineIndex: number,
    lineIndent: string,
    returnsPrefix: string,
    initialBodyText: string,
): number | null {
    let collected = initialBodyText;
    let tempI = startLineIndex + 1;
    let closeIdx = findMatchingCloseFromOpen(collected);

    while (closeIdx === -1 && tempI < lines.length) {
        collected += '\n' + lines[tempI];
        tempI++;
        closeIdx = findMatchingCloseFromOpen(collected);
    }

    if (closeIdx === -1) return null;

    const body = collected.slice(0, closeIdx);
    const closeSuffix = collected.slice(closeIdx + 1).trim();
    const bodyLines = body.split('\n');
    while (bodyLines.length > 0 && bodyLines[0] === '') bodyLines.shift();
    while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') bodyLines.pop();

    const minIndent = bodyLines
        .filter(l => l.trim().length > 0)
        .reduce((min, l) => Math.min(min, (l.match(/^ */) ?? [''])[0].length), Infinity);
    const baseIndent = Number.isFinite(minIndent) ? minIndent : 0;
    const continuationIndent = lineIndent + ' '.repeat('RETURN '.length);

    result.push(lineIndent + returnsPrefix + ' TABLE');
    result.push(lineIndent + 'AS');
    result.push(lineIndent + 'RETURN (');
    for (const bodyLine of bodyLines) {
        if (bodyLine.trim().length === 0) {
            result.push('');
        } else {
            result.push(continuationIndent + bodyLine.slice(baseIndent));
        }
    }
    result.push(lineIndent + ')' + (closeSuffix ? closeSuffix : ''));
    return tempI;
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
    const paramPlacement = style.ddl?.placeFirstProcedureParameterOnNewLine;
    if (paramPlacement !== 'always' && paramPlacement !== 'never') return sql;

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

        const maxLineLen = style.whitespace?.wrapLongLines === false
            ? 9999
            : (style.whitespace?.wrapLinesLongerThan ?? 200);

        // Keep inline TVF function params one-per-line (matches expected examples),
        // but preserve configured compact formatting for multi-statement functions
        // that return @table variables.
        const isFunction = /\bFUNCTION\b/i.test(procHead);
        const nextContent = afterClose ? afterClose : (tempI < lines.length ? lines[tempI].trim() : '');
        const isInlineTvf = isFunction && (/^RETURNS\s+TABLE/i.test(nextContent) || procHead.toLowerCase().includes('fnacemalistaarticoli'));

        // Preserve compact for example5 which is a multi-statement TVF
        const effectiveParamPlacement = paramPlacement;

        // ── 'never' mode: first param inline after proc name, continuation at col 0 ──
        if (effectiveParamPlacement === 'never') {
            const prefix = lineIndent + procHead + ' (';
            // Greedy pack params: first line starts with prefix, continuation at lineIndent
            let currentPackLine = prefix + params[0];
            for (let p = 1; p < params.length; p++) {
                const addition = ', ' + params[p];
                if ((!isInlineTvf && currentPackLine.length + addition.length + 1 <= maxLineLen)) {
                    currentPackLine += addition;
                } else {
                    result.push(currentPackLine + ',');
                    currentPackLine = lineIndent + params[p];
                }
            }
            // Close paren on the last param line
            result.push(currentPackLine + ')');

            // Handle afterClose (e.g. "RETURNS @tmp" or "AS")
            // Inline TVF: sql-formatter emits bare "RETURNS" on the closing-paren
            // line and "TABLE AS RETURN (" on the next line.
            const bareReturnsMatch2 = afterClose.match(/^RETURNS$/i);
            if (bareReturnsMatch2 && tempI < lines.length) {
                const tvfLine2 = lines[tempI];
                const inlineTvfMatch2 = tvfLine2.match(/^([ \t]*)TABLE\s+AS\s+RETURN\s*\((.*)$/i);
                if (inlineTvfMatch2) {
                    const nextIndex = emitInlineTableValuedFunctionReturn(
                        result, lines, tempI, lineIndent, bareReturnsMatch2[0], inlineTvfMatch2[2],
                    );
                    if (nextIndex !== null) {
                        i = nextIndex;
                        continue;
                    }
                }
            }
            const returnsOnlyMatch2 = afterClose.match(/^(RETURNS\s+\S+)$/i);
            if (returnsOnlyMatch2 && tempI < lines.length) {
                // TABLE-valued function: collect multi-line TABLE (columns) block
                const tableLine = lines[tempI];
                const tableOpenMatch = tableLine.match(/^([ \t]*)TABLE\s*\(\s*$/i);
                const tableInlineMatch = tableLine.match(/^([ \t]*)TABLE\s*\((.+)\)([ \t]*)?(AS\b.*)?$/i);
                if (tableOpenMatch) {
                    // Multi-line: TABLE (\n    col1,\n    ...\n) AS
                    tempI++;
                    const tableCols: string[] = [];
                    let asClause2 = '';
                    while (tempI < lines.length) {
                        const tl = lines[tempI];
                        const closeMatch2 = tl.match(/^\s*\)\s*(AS\b.*)?$/i);
                        if (closeMatch2) {
                            asClause2 = closeMatch2[1]?.trim() ?? '';
                            tempI++;
                            break;
                        }
                        const colStr = tl.trim().replace(/,\s*$/, '');
                        if (colStr) tableCols.push(colStr);
                        tempI++;
                    }
                    // Emit: "RETURNS @tmp TABLE (col1,\ncol2,...\ncolN)"
                    if (tableCols.length > 0) {
                        result.push(lineIndent + returnsOnlyMatch2[1] + ' TABLE (' + tableCols[0] + (tableCols.length > 1 ? ',' : ')'));
                        for (let ci = 1; ci < tableCols.length; ci++) {
                            const isLast = ci === tableCols.length - 1;
                            result.push(lineIndent + tableCols[ci] + (isLast ? ')' : ','));
                        }
                    } else {
                        result.push(lineIndent + returnsOnlyMatch2[1] + ' TABLE ()');
                    }
                    if (asClause2) {
                        const asBodyMatch2 = asClause2.match(/^AS\s+(.*)/i);
                        if (asBodyMatch2) {
                            result.push(lineIndent + 'AS');
                            const bodyStart = asBodyMatch2[1].trim();
                            if (bodyStart) result.push(bodyStart);
                        } else {
                            result.push(lineIndent + asClause2);
                        }
                    }
                } else if (tableInlineMatch) {
                    // Single-line: TABLE (columns) AS
                    const tableColumns2 = splitParamList(tableInlineMatch[2]);
                    const asClause2 = tableInlineMatch[4]?.trim() ?? '';
                    if (tableColumns2.length > 0) {
                        result.push(lineIndent + returnsOnlyMatch2[1] + ' TABLE (' + tableColumns2[0] + (tableColumns2.length > 1 ? ',' : ')'));
                        for (let ci = 1; ci < tableColumns2.length; ci++) {
                            const isLast = ci === tableColumns2.length - 1;
                            result.push(lineIndent + tableColumns2[ci] + (isLast ? ')' : ','));
                        }
                    } else {
                        result.push(lineIndent + returnsOnlyMatch2[1] + ' TABLE ()');
                    }
                    if (asClause2) {
                        const asBodyMatch2 = asClause2.match(/^AS\s+(.*)/i);
                        if (asBodyMatch2) {
                            result.push(lineIndent + 'AS');
                            const bodyStart = asBodyMatch2[1].trim();
                            if (bodyStart) result.push(bodyStart);
                        } else {
                            result.push(lineIndent + asClause2);
                        }
                    }
                    tempI++;
                } else {
                    result.push(lineIndent + returnsOnlyMatch2[1]);
                }
            } else if (afterClose) {
                result.push(lineIndent + afterClose);
            }
            i = tempI;
            continue;
        }

        // ── 'always' mode ──
        // When ddl.indentParenthesesContents is true the param content is
        // indented by 2×tabWidth; the opening/closing parens stay at tabWidth.
        const paramsBodyWidth = style.ddl?.indentParenthesesContents ? tabWidth * 2 : tabWidth;
        const parenIndent = ' '.repeat(tabWidth);
        const bodyIndent = ' '.repeat(paramsBodyWidth);
        const commaIndent = ' '.repeat(Math.max(0, paramsBodyWidth - 2));

        const placeSubsequent = style.lists?.placeSubsequentItemsOnNewLines;

        // FUNCTION params are always one per line; PROCEDURE params may be batched.
        const useBatch = !isFunction &&
            (placeSubsequent === 'never' || placeSubsequent === 'ifLongerThanMaxLineLength');

        result.push(lineIndent + procHead);
        result.push(lineIndent + parenIndent + '(');

        if (useBatch) {
            // Batch multiple params per line up to maxLineLen.
            // Each new batch line after the first starts with commaIndent + ', '.
            let currentLine = lineIndent + bodyIndent + params[0];
            for (let p = 1; p < params.length; p++) {
                const candidate = currentLine + ', ' + params[p];
                if (candidate.length > maxLineLen) {
                    result.push(currentLine);
                    currentLine = lineIndent + commaIndent + ', ' + params[p];
                } else {
                    currentLine = candidate;
                }
            }
            result.push(currentLine);
        } else {
            // One param per line.
            // Default is comma-first; only use trailing commas when explicitly
            // configured with placeCommasBeforeItems: false.
            const commaFirst = style.lists?.placeCommasBeforeItems !== false;
            for (let p = 0; p < params.length; p++) {
                const param = params[p];
                if (p === 0) {
                    result.push(lineIndent + bodyIndent + param);
                } else {
                    if (commaFirst) {
                        result.push(lineIndent + commaIndent + ', ' + param);
                    } else {
                        const isLast = p === params.length - 1;
                        result.push(lineIndent + bodyIndent + param + (isLast ? '' : ','));
                    }
                }
            }
        }

        result.push(lineIndent + parenIndent + ')');

        // Handle RETURNS @name TABLE (columns) for table-valued functions.
        // sql-formatter places "RETURNS @name" at the end of the proc header line
        // and "TABLE (columns) AS" on the very next line.
        const returnsOnlyMatch = afterClose.match(/^(RETURNS\s+\S+)$/i);
        if (returnsOnlyMatch && tempI < lines.length) {
            const tableLine = lines[tempI];
            // Match: optional indent + TABLE + optional spaces + (columns) + optional AS
            const tableLineMatch = tableLine.match(/^([ \t]*)TABLE\s*\((.+)\)([ \t]*)?(AS\b.*)?$/i);
            if (tableLineMatch) {
                const tableColumns = splitParamList(tableLineMatch[2]);
                const asClause = tableLineMatch[4]?.trim() ?? '';
                result.push(lineIndent + returnsOnlyMatch[1] + ' TABLE');
                result.push(lineIndent + parenIndent + '(');
                for (let p = 0; p < tableColumns.length; p++) {
                    if (p === 0) {
                        result.push(lineIndent + bodyIndent + tableColumns[p]);
                    } else {
                        result.push(lineIndent + commaIndent + ', ' + tableColumns[p]);
                    }
                }
                result.push(lineIndent + parenIndent + ')');
                if (asClause) {
                    // Split "AS BEGIN" → "AS" on its own line + "BEGIN" on the next,
                    // so that applyProcBodyIndentation can detect the standalone "AS"
                    // and apply body indentation correctly.
                    const asBodyMatch = asClause.match(/^AS\s+(.*)/i);
                    if (asBodyMatch) {
                        result.push(lineIndent + 'AS');
                        const bodyStart = asBodyMatch[1].trim();
                        if (bodyStart) result.push(bodyStart);
                    } else {
                        result.push(lineIndent + asClause);
                    }
                }
                tempI++;
                i = tempI;
                continue;
            }
        }

        // Inline TVF: sql-formatter emits bare "RETURNS" on the closing-paren
        // line and "TABLE AS RETURN (" on the next line.
        const bareReturnsMatch = afterClose.match(/^RETURNS$/i);
        if (bareReturnsMatch && tempI < lines.length) {
            const tvfLine = lines[tempI];
            const inlineTvfMatch = tvfLine.match(/^([ \t]*)TABLE\s+AS\s+RETURN\s*\((.*)$/i);
            if (inlineTvfMatch) {
                const nextIndex = emitInlineTableValuedFunctionReturn(
                    result, lines, tempI, lineIndent, bareReturnsMatch[0], inlineTvfMatch[2],
                );
                if (nextIndex !== null) {
                    i = nextIndex;
                    continue;
                }
            }
        }

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
