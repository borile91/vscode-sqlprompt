import type { SqlPromptStyleJson } from './styleLoader';

/**
 * Post-processes sql-formatter output to apply JOIN ON formatting rules:
 *
 * - `joinStatements.on.placeOnNewLine: true`  — the ON keyword is placed on its
 *   own line below the joined table name.
 * - `joinStatements.on.keywordAlignment: "indented"` — ON is indented one
 *   tabWidth relative to the JOIN keyword it belongs to.
 * - `joinStatements.on.keywordAlignment: "toJoin"` — ON aligns with the JOIN.
 * - `joinStatements.on.keywordAlignment: "toTable"` — ON aligns with the joined
 *   table column (JOIN + tabWidth).
 * - `joinStatements.on.conditionAlignment: "toInner"` — the join condition
 *   starts immediately after ON + space (default).
 *
 * This formatter operates on the text output after sql-formatter has already
 * placed JOIN and ON on separate lines (tabularLeft) or on the same line
 * (standard). It re-arranges accordingly.
 */
export function applyJoinOnFormatting(sql: string, style: SqlPromptStyleJson, tabWidth: number): string {
    const onCfg = style.joinStatements?.on;
    if (!onCfg?.placeOnNewLine) return sql;

    const keywordAlignment = onCfg.keywordAlignment ?? 'indented';
    const lines = sql.split('\n');
    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const joinMatch = matchJoinLine(line);

        if (joinMatch) {
            const { indent, joinKeyword, tableAndRest } = joinMatch;

            // Check if ON is inline on the same line as the JOIN/table
            const inlineOnMatch = tableAndRest.match(/^(.*?)\s+ON\s+(.+)$/i);
            if (inlineOnMatch) {
                // ON is inline — split it out
                const tableOnly = inlineOnMatch[1].trimEnd();
                const condition = inlineOnMatch[2];
                result.push(' '.repeat(indent) + joinKeyword + ' ' + tableOnly);
                const onIndent = computeOnIndent(indent, joinKeyword, keywordAlignment, tabWidth);
                result.push(' '.repeat(onIndent) + 'ON ' + condition);
                i++;
                continue;
            }

            // ON is NOT inline yet — emit the JOIN line as-is, then look ahead
            // for any continuation that has ON (possibly already on next line)
            result.push(line);
            i++;

            // Peek ahead: next non-empty line might already be an ON line or
            // might not be (e.g. ON was never emitted by sql-formatter).
            // We look for a line starting with optional spaces + ON keyword.
            if (i < lines.length) {
                const nextLine = lines[i];
                const onLineMatch = nextLine.match(/^(\s*)(ON)\s+(.*)/i);
                if (onLineMatch) {
                    const condition = onLineMatch[3];
                    const onIndent = computeOnIndent(indent, joinKeyword, keywordAlignment, tabWidth);
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
