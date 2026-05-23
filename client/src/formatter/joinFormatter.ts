import type { SqlPromptStyleJson } from './styleLoader';

/**
 * Post-processes sql-formatter output to apply JOIN formatting rules:
 *
 * JOIN keyword alignment (`joinStatements.join.keywordAlignment`):
 * - `"toFrom"` (default) — JOIN stays at indent 0 (keyword column).
 * - `"toTable"` — JOIN is indented to the table column (i.e. the keyword column
 *   width inferred from FROM/SELECT padding), so it visually aligns under the
 *   FROM table name.
 *
 * ON keyword placement:
 * - `joinStatements.on.placeOnNewLine: true` OR `on.keywordAlignment` being set
 *   — the ON keyword is placed on its own line below the joined table name.
 * - `"indented"` — ON is indented one tabWidth relative to the effective JOIN
 *   column.
 * - `"toJoin"` — ON aligns with the JOIN keyword column.
 * - `"toTable"` — ON aligns with the joined table column (JOIN + 1 space).
 *
 * This formatter operates on the text output after sql-formatter has already
 * placed JOIN and ON on separate lines (tabularLeft) or on the same line
 * (standard). It re-arranges accordingly.
 */
export function applyJoinOnFormatting(sql: string, style: SqlPromptStyleJson, tabWidth: number): string {
    const joinCfg = style.joinStatements?.join;
    const onCfg = style.joinStatements?.on;

    const joinAlignment = joinCfg?.keywordAlignment ?? 'toFrom';
    // Treat on.keywordAlignment being set as implying placeOnNewLine: true when
    // placeOnNewLine is not explicitly configured (SQL Prompt always places ON on
    // a new line whenever a keyword-alignment rule is present).
    const placeOnNewLine = onCfg?.placeOnNewLine ?? (onCfg?.keywordAlignment !== undefined);
    const shouldTransformJoinIndent = joinAlignment === 'toTable';

    // Nothing to do
    if (!shouldTransformJoinIndent && !placeOnNewLine) return sql;

    const keywordAlignment = onCfg?.keywordAlignment ?? 'indented';
    const conditionAlignment = onCfg?.conditionAlignment;
    const lines = sql.split('\n');

    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const joinMatch = matchJoinLine(line);

        if (joinMatch) {
            const { indent, joinKeyword, tableAndRest } = joinMatch;

            // When toTable is active, the JOIN keyword moves to the table column.
            // Compute kwColWidth locally by scanning backward to the nearest FROM/SELECT
            // so that each JOIN uses the width of its own SELECT block.
            const effectiveIndent = shouldTransformJoinIndent
                ? getLocalKwColWidth(lines, i)
                : indent;

            // Check if ON is inline on the same line as the JOIN/table.
            // OUTER APPLY / CROSS APPLY never have ON, so skip this check for them.
            const isApply = /^(?:OUTER|CROSS)\s+APPLY$/i.test(joinKeyword);
            const inlineOnMatch = !isApply ? tableAndRest.match(/^(.*?)\s+ON\s+(.+)$/i) : null;

            if (inlineOnMatch) {
                // ON is inline — split it out
                const tableOnly = inlineOnMatch[1].trimEnd();
                const condition = inlineOnMatch[2];
                result.push(' '.repeat(effectiveIndent) + joinKeyword + ' ' + tableOnly);
                if (placeOnNewLine) {
                    const onIndent = computeOnIndent(effectiveIndent, joinKeyword, keywordAlignment, tabWidth);
                    result.push(' '.repeat(onIndent) + 'ON ' + condition);
                    i++;
                    // Re-indent AND/OR condition continuations after ON
                    i = reindentConditions(lines, i, onIndent, conditionAlignment, result);
                } else {
                    result[result.length - 1] += ' ON ' + condition;
                    i++;
                }
                continue;
            }

            // ON is NOT inline — emit the JOIN line, then look ahead for ON
            if (shouldTransformJoinIndent) {
                result.push(' '.repeat(effectiveIndent) + joinKeyword + ' ' + tableAndRest);
            } else {
                result.push(line);
            }
            i++;

            // Peek ahead: next line might already be an ON line
            if (!isApply && placeOnNewLine && i < lines.length) {
                const nextLine = lines[i];
                const onLineMatch = nextLine.match(/^(\s*)(ON)\s+(.*)/i);
                if (onLineMatch) {
                    const condition = onLineMatch[3];
                    const onIndent = computeOnIndent(effectiveIndent, joinKeyword, keywordAlignment, tabWidth);
                    result.push(' '.repeat(onIndent) + 'ON ' + condition);
                    i++;
                    // Re-indent AND/OR condition continuations after ON
                    i = reindentConditions(lines, i, onIndent, conditionAlignment, result);
                    continue;
                }
            }
            continue;
        }

        result.push(line);
        i++;
    }

    return result.join('\n');
}

/**
 * Infers the keyword column width from the formatted SQL by scanning for clause
 * keyword lines (SELECT, FROM, WHERE …) that are followed by spaces + content.
 * The width is keyword length + trailing spaces (e.g. "FROM   " → 7).
 * Returns 0 if no recognisable clause line is found.
 */
function inferKeywordColumnWidth(lines: string[]): number {
    const clauseKeywords = ['SELECT', 'FROM', 'WHERE', 'HAVING', 'UPDATE', 'DELETE'];
    for (const line of lines) {
        for (const kw of clauseKeywords) {
            const m = line.match(new RegExp(`^(${kw})(\\s+)\\S`, 'i'));
            if (m) {
                return m[1].length + m[2].length;
            }
        }
    }
    return 0;
}

/**
 * Scans backward from `joinIdx` to find the nearest FROM or SELECT line and
 * returns its keyword column width (keyword length + trailing spaces).
 * This gives a per-JOIN column width rather than a single document-wide value,
 * which is important when different SELECT blocks have different keyword padding.
 */
function getLocalKwColWidth(lines: string[], joinIdx: number): number {
    for (let i = joinIdx - 1; i >= 0; i--) {
        const m = lines[i].match(/^(FROM|SELECT)(\s+)\S/i);
        if (m) return m[1].length + m[2].length;
    }
    return inferKeywordColumnWidth(lines);
}

interface JoinMatch {
    indent: number;
    joinKeyword: string;
    tableAndRest: string;
}

/**
 * Matches a JOIN line: optional leading spaces + JOIN keyword(s) + space + rest.
 * Recognises INNER JOIN, LEFT JOIN, RIGHT JOIN, FULL JOIN, CROSS JOIN, JOIN,
 * OUTER APPLY, CROSS APPLY.
 */
function matchJoinLine(line: string): JoinMatch | null {
    const m = line.match(
        /^(\s*)((?:INNER|LEFT|RIGHT|FULL|CROSS)\s+(?:OUTER\s+)?JOIN|OUTER\s+APPLY|CROSS\s+APPLY|JOIN)\s+(.+)$/i,
    );
    if (!m) return null;
    return {
        indent: m[1].length,
        joinKeyword: m[2].replace(/\s+/g, ' '),
        tableAndRest: m[3],
    };
}

/**
 * When `conditionAlignment === "toInner"`, re-indents AND/OR condition lines
 * that immediately follow an ON clause so they align with the first condition
 * (i.e. at column `onIndent + "ON ".length`).
 *
 * Consumes lines from `lines[startIdx]` while they look like condition
 * operators, appends them to `result`, and returns the next index.
 */
function reindentConditions(
    lines: string[],
    startIdx: number,
    onIndent: number,
    conditionAlignment: string | undefined,
    result: string[],
): number {
    if (conditionAlignment !== 'toInner') return startIdx;

    const condCol = onIndent + 'ON '.length; // align to first condition character
    let i = startIdx;
    while (i < lines.length) {
        const m = lines[i].match(/^\s*((?:AND|OR)\b.*)/i);
        if (!m) break;
        result.push(' '.repeat(condCol) + m[1].trimStart());
        i++;
    }
    return i;
}

/**
 * Computes the column where ON should be placed based on alignment setting.
 *
 * - "indented": JOIN indent + tabWidth
 * - "toJoin":   JOIN indent (same column as JOIN keyword)
 * - "toTable":  JOIN indent + JOIN keyword length + 1 space
 */
function computeOnIndent(
    joinIndent: number,
    joinKeyword: string,
    alignment: string,
    tabWidth: number,
): number {
    if (alignment === 'toJoin') return joinIndent;
    if (alignment === 'toTable') return joinIndent + joinKeyword.length + 1;
    // default: "indented"
    return joinIndent + tabWidth;
}
