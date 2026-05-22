import type { SqlPromptStyleJson } from './styleLoader';

/**
 * Matches a DECLARE line that starts a multi-variable declaration.
 * The first variable must end with a trailing comma (sql-formatter puts all
 * variables on one line or splits them at top-level commas).
 *
 * Group 1 — leading whitespace
 * Group 2 — first variable name (@identifier)
 * Group 3 — everything after the variable name (type, default, …) before the comma
 */
const DECLARE_MULTI_RE = /^([ \t]*)DECLARE\s+(@\S+)(.*),\s*$/i;

/**
 * Matches a continuation variable line in a multi-variable DECLARE.
 * sql-formatter puts continuation variables at column 0 (no indentation).
 *
 * Group 1 — variable name (@identifier)
 * Group 2 — everything after the name (type, default, …) possibly with trailing comma
 */
const DECLARE_CONT_RE = /^(@\S+)(.*?),?\s*$/;

/** Splits a variable specification into [name, typeAndDefault]. */
function splitVarSpec(spec: string): [string, string] {
    const m = spec.match(/^(@\S+)\s+(.*)/s);
    if (!m) return [spec.trim(), ''];
    return [m[1], m[2].trimEnd()];
}

/**
 * Post-processes sql-formatter output to reformat multi-variable DECLARE
 * statements with comma-first style and column-aligned type/default expressions.
 *
 * Input (sql-formatter):
 *   DECLARE @transazioneEsterna BIT = 0,
 *   @perditaLotto BIT,
 *   @unioneLotto BIT;
 *
 * Output:
 *   DECLARE @transazioneEsterna BIT = 0
 *         , @perditaLotto       BIT
 *         , @unioneLotto        BIT;
 *
 * The comma sits at column `len("DECLARE ") - 2` so that the variable name
 * starts at column `len("DECLARE ")`.  Type expressions are padded to align
 * across all variables.
 *
 * When `lists.placeCommasBeforeItems !== true` the comma-first reformat is
 * skipped and the declaration is left unchanged.
 */
export function applyDeclareFormatting(sql: string, style: SqlPromptStyleJson): string {
    if (!style.lists?.placeCommasBeforeItems) return sql;

    const lines = sql.split('\n');
    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const declMatch = line.match(DECLARE_MULTI_RE);

        if (!declMatch) {
            result.push(line);
            i++;
            continue;
        }

        const lineIndent = declMatch[1];          // leading whitespace
        const firstName = declMatch[2];           // @firstVar
        const firstRest = declMatch[3].trim();    // "TYPE = default" (without trailing comma)

        // Collect continuation variables (lines starting with @, no leading indent)
        const vars: Array<{ name: string; typeAndDefault: string }> = [];
        vars.push({ name: firstName, typeAndDefault: firstRest });

        let j = i + 1;
        while (j < lines.length) {
            const contLine = lines[j];
            // Continuation lines: start with @ at column 0 (or just whitespace+@
            // if sql-formatter indented them)
            const contMatch = contLine.trimStart().match(/^(@\S+)(.*)/);
            if (!contMatch) break;
            // Only collect if the line is a plain variable continuation (not a
            // new statement keyword)
            const trimmed = contLine.trim();
            if (!trimmed.startsWith('@')) break;

            const [varName, varRest] = splitVarSpec(trimmed);
            // Strip trailing comma or semicolon from the rest
            const rest = varRest.replace(/[,;]\s*$/, '').trimEnd();
            vars.push({ name: varName, typeAndDefault: rest });
            j++;
        }

        // Only reformat if we actually collected more than one variable
        if (vars.length === 1) {
            result.push(line);
            i++;
            continue;
        }

        // Column layout:
        //   DECLARE keyword = 7 chars + 1 space = 8 → variable name starts at 8
        //   commaIndent = 8 - 2 = 6  →  "      , @var" aligns @ at column 8
        const declareWidth = 'DECLARE '.length; // 8
        const commaIndent = declareWidth - 2;    // 6

        // Align types: pad each variable name to the longest
        const maxNameLen = Math.max(...vars.map(v => v.name.length));

        const emitVar = (v: { name: string; typeAndDefault: string }, isFirst: boolean): string => {
            const paddedName = v.name.padEnd(maxNameLen);
            const content = paddedName + (v.typeAndDefault ? ' ' + v.typeAndDefault : '');
            if (isFirst) {
                return lineIndent + 'DECLARE ' + content;
            }
            return lineIndent + ' '.repeat(commaIndent) + ', ' + content;
        };

        // Find which variable carries the semicolon (the last one from sql-formatter)
        // The last continuation line ends with `;` (possibly `BIT;`)
        const lastLine = lines[j - 1] ?? '';
        const hasSemicolon = lastLine.trimEnd().endsWith(';');

        const emittedLines = vars.map((v, idx) => emitVar(v, idx === 0));

        // Append semicolon to the last emitted variable line
        if (hasSemicolon) {
            emittedLines[emittedLines.length - 1] += ';';
        }

        result.push(...emittedLines);
        i = j;
    }

    return result.join('\n');
}
