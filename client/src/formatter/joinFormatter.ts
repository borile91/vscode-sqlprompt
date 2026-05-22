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
    const lines = sql.split('\n');

    // For "toTable" alignment, infer the keyword column width from the SQL so
    // that JOIN lines can be indented to match the clause table column.
    const kwColWidth = shouldTransformJoinIndent ? inferKeywordColumnWidth(lines) : 0;

    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const joinMatch = matchJoinLine(line);

        if (joinMatch) {
            const { indent, joinKeyword, tableAndRest } = joinMatch;

            // When toTable is active, the JOIN keyword moves to the table column.
            const effectiveIndent = shouldTransformJoinIndent ? kwColWidth : indent;

            // Check if ON is inline on the same line as the JOIN/table
            const inlineOnMatch = tableAndRest.match(/^(.*?)\s+ON\s+(.+)$/i);
            if (inlineOnMatch) {
                // ON is inline — split it out
                const tableOnly = inlineOnMatch[1].trimEnd();
                const condition = inlineOnMatch[2];
                result.push(' '.repeat(effectiveIndent) + joinKeyword + ' ' + tableOnly);
                if (placeOnNewLine) {
                    const onIndent = computeOnIndent(effectiveIndent, joinKeyword, keywordAlignment, tabWidth);
                    result.push(' '.repeat(onIndent) + 'ON ' + condition);
                } else {
                    result[result.length - 1] += ' ON ' + condition;
                }
                i++;
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
            if (placeOnNewLine && i < lines.length) {
                const nextLine = lines[i];
                const onLineMatch = nextLine.match(/^(\s*)(ON)\s+(.*)/i);
                if (onLineMatch) {
                    const condition = onLineMatch[3];
                    const onIndent = computeOnIndent(effectiveIndent, joinKeyword, keywordAlignment, tabWidth);
                    result.push(' '.repeat(onIndent) + 'ON ' + condition);
                    i++;
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
    const clauseKeywords = ['SELECT', 'FROM', 'WHERE', 'HAVING', 'UPDATE', 'DELETE', 'INSERT'];
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

interface JoinMatch {
    indent: number;
    joinKeyword: string;
    tableAndRest: string;
}

/**
 * Matches a JOIN line: optional leading spaces + JOIN keyword(s) + space + rest.
 * Recognises INNER JOIN, LEFT JOIN, RIGHT JOIN, FULL JOIN, CROSS JOIN, JOIN.
 */
function matchJoinLine(line: string): JoinMatch | null {
    const m = line.match(/^(\s*)((?:INNER|LEFT|RIGHT|FULL|CROSS)\s+(?:OUTER\s+)?JOIN|JOIN)\s+(.+)$/i);
    if (!m) return null;
    return {
        indent: m[1].length,
        joinKeyword: m[2].replace(/\s+/g, ' '),
        tableAndRest: m[3],
    };
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
