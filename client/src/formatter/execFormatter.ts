import type { SqlPromptStyleJson } from './styleLoader';

/**
 * Matches an EXEC/EXECUTE line whose first parameter is followed by a comma,
 * indicating a multi-parameter call that needs comma-first reformatting.
 *
 * Group 1 — leading whitespace
 * Group 2 — EXEC keyword (EXEC or EXECUTE)
 * Group 3 — procedure/function name (schema.name or name)
 * Group 4 — everything after the procedure name until the trailing comma
 */
const EXEC_MULTI_RE =
    /^([ \t]*)(EXEC(?:UTE)?)\s+(\S+)\s+(.*),\s*$/i;

/**
 * Post-processes sql-formatter output to reformat multi-parameter EXEC/EXECUTE
 * calls with comma-first style, aligning continuation parameters to the column
 * where the first parameter starts.
 *
 * Input (sql-formatter):
 *   EXEC ui.Aggiorna @Stab = @stab,
 *   @Maga = @maga,
 *   @Prog = @prog;
 *
 * Output:
 *   EXEC ui.Aggiorna @Stab = @stab
 *                  , @Maga = @maga
 *                  , @Prog = @prog;
 *
 * Continuation parameters are identified as lines whose trimmed content starts
 * with `@` (SQL Server variable / named parameter syntax), matching the zero-
 * indent lines sql-formatter emits for EXEC continuations.
 *
 * When `lists.placeCommasBeforeItems !== true` the reformat is skipped.
 */
export function applyExecParamFormatting(sql: string, style: SqlPromptStyleJson): string {
    if (!style.lists?.placeCommasBeforeItems) return sql;

    const lines = sql.split('\n');
    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const execMatch = line.match(EXEC_MULTI_RE);

        if (!execMatch) {
            result.push(line);
            i++;
            continue;
        }

        const lineIndent = execMatch[1];    // leading whitespace
        const execKw = execMatch[2];        // "EXEC" or "EXECUTE"
        const procName = execMatch[3];      // "schema.procedure"
        const firstParamSpec = execMatch[4].trim(); // "@param = val" (without trailing comma)

        // Column where the first parameter starts:
        //   indent + "EXEC " + procName + " " = indent + 5 + procName + 1
        const paramCol = lineIndent.length + execKw.length + 1 + procName.length + 1;
        const commaIndent = paramCol - 2; // comma sits 2 chars before param

        // Collect continuation parameter lines (trimmed, starting with @)
        const params: string[] = [firstParamSpec];
        let j = i + 1;
        while (j < lines.length) {
            const contLine = lines[j];
            const trimmed = contLine.trim();
            if (!trimmed.startsWith('@')) break;
            // Strip trailing comma (continuation marker)
            params.push(trimmed.replace(/,\s*$/, '').trimEnd());
            j++;
        }

        // Only reformat if there are continuation parameters
        if (params.length === 1) {
            result.push(line);
            i++;
            continue;
        }

        // The last continuation line from sql-formatter may end with `;`
        const lastContLine = lines[j - 1] ?? '';
        const hasSemicolon = lastContLine.trimEnd().endsWith(';');

        // Strip semicolon from the last collected param (it'll be re-added)
        if (hasSemicolon && params.length > 0) {
            params[params.length - 1] = params[params.length - 1].replace(/;\s*$/, '').trimEnd();
        }

        // For 'ifLongerThanMaxLineLength': collapse all params to one line.
        // For 'never': greedy-pack params onto lines <= wrapLinesLongerThan.
        const listBreakMode = style.lists?.placeSubsequentItemsOnNewLines;
        if (listBreakMode === 'ifLongerThanMaxLineLength') {
            const singleLine =
                lineIndent + execKw + ' ' + procName + ' ' + params.join(', ') +
                (hasSemicolon ? ';' : '');
            result.push(singleLine);
            i = j;
            continue;
        }

        if (listBreakMode === 'never') {
            const maxLen = style.whitespace?.wrapLinesLongerThan;
            const prefix0 = lineIndent + execKw + ' ' + procName + ' ';
            const contPrefix = ' '.repeat(commaIndent) + ', ';
            const singleLine = prefix0 + params.join(', ') + (hasSemicolon ? ';' : '');
            if (maxLen === undefined || !isFinite(maxLen) || singleLine.length <= maxLen) {
                result.push(singleLine);
            } else {
                // Greedy-pack params onto lines up to maxLen.
                const packedLines: string[] = [];
                let currentLine = prefix0 + params[0];
                for (let pi = 1; pi < params.length; pi++) {
                    const addition = ', ' + params[pi];
                    if (currentLine.length + addition.length <= maxLen) {
                        currentLine += addition;
                    } else {
                        packedLines.push(currentLine);
                        currentLine = contPrefix + params[pi];
                    }
                }
                packedLines.push(currentLine + (hasSemicolon ? ';' : ''));
                result.push(...packedLines);
            }
            i = j;
            continue;
        }

        const emittedLines = params.map((p, idx) => {
            if (idx === 0) {
                return lineIndent + execKw + ' ' + procName + ' ' + p;
            }
            return ' '.repeat(commaIndent) + ', ' + p;
        });

        if (hasSemicolon) {
            emittedLines[emittedLines.length - 1] += ';';
        }

        result.push(...emittedLines);
        i = j;
    }

    return result.join('\n');
}
