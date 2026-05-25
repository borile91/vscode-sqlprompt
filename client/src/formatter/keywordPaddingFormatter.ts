/**
 * Re-pads keyword spacing after sql-formatter's tabularLeft output.
 *
 * sql-formatter uses a fixed keyword column width of 10 for T-SQL (sized to fit
 * ORDER BY + 2 spaces). SQL Prompt uses the minimum width needed for the keywords
 * that actually appear in each query block (max_keyword_length + 1 space).
 *
 * This post-processor detects the keywords present in each blank-line-separated
 * query block, computes the optimal width, and re-pads every keyword line and
 * continuation line within the block.
 *
 * Must run BEFORE applyLeadingCommaFormat so that continuation-line widths are
 * already correct when leading commas are placed.
 */

/**
 * sql-formatter (standard mode) splits `SET SOMETHING ON` to
 * `SET\n    SOMETHING ON` — treating SET as a clause keyword and the rest as
 * clause content.  This applies to both session-option statements
 * (`SET ANSI_NULLS ON`) and variable assignments (`SET @var = value`).
 *
 * This function rejoins them back onto a single line so that downstream
 * processors (applyKeywordRePadding, applyLeadingCommaFormat, …) see the
 * canonical `SET <content>` form.
 *
 * Must run BEFORE applyKeywordRePadding.
 */
export function applySetLineJoining(sql: string): string {
    // Match: optional leading whitespace, SET, optional trailing spaces/tabs,
    // a newline, then optional leading whitespace on the next line.
    // Replace with the leading indent + "SET " (the next-line indent is dropped
    // because sql-formatter adds an extra tabWidth indent for the "clause content").
    return sql
        .replace(/^([ \t]*SET)[ \t]*\n[ \t]*/gm, '$1 ')
        // sql-formatter tabularLeft pads sub-keywords inside SET statements to 10
        // chars (e.g. "NOCOUNT   ON" → 7 chars padded to 10).  After the join
        // above this becomes "SET NOCOUNT   ON;" — collapse excess spaces.
        .replace(/^([ \t]*SET\s+\w+)[ \t]{2,}(\w)/gm, '$1 $2');
}

/** Fixed keyword column width produced by sql-formatter tabularLeft for T-SQL. */
const SQL_FORMATTER_KW_WIDTH = 10;

/**
 * Keywords as they appear as the FIRST token on a line in sql-formatter tabularLeft
 * T-SQL output, ordered longest-first to avoid prefix shadowing.
 *
 * Notes:
 *  - "LEFT JOIN" (9) and "FULL JOIN" (9) are compound tokens recognised by
 *    sql-formatter; "INNER JOIN", "RIGHT JOIN", "CROSS JOIN" etc. are not — they
 *    appear as  "INNER     JOIN …", "RIGHT     JOIN …", "CROSS     JOIN …".
 *  - "ORDER BY" (8) and "GROUP BY" (8) are also compound tokens.
 */
const KEYWORD_TOKENS: string[] = [
    'OUTER APPLY', // 11 — must precede 'OUTER' / 'CROSS' singles
    'CROSS APPLY', // 11
    'INTERSECT',   // 9
    'LEFT JOIN',   // 9
    'FULL JOIN',   // 9
    'ORDER BY',    // 8
    'GROUP BY',    // 8
    'EXECUTE',     // 7
    'HAVING',      // 6
    'SELECT',      // 6
    'VALUES',      // 6
    'OUTPUT',      // 6
    'UPDATE',      // 6
    'DELETE',      // 6
    'INSERT',      // 6
    'EXCEPT',      // 6
    'INNER',       // 5  (appears before JOIN … as content)
    'RIGHT',       // 5  (appears before JOIN … or OUTER JOIN …)
    'CROSS',       // 5  (appears before JOIN …)
    'UNION',       // 5
    'WHERE',       // 5
    'MERGE',       // 5
    'PIVOT',       // 5
    'PRINT',       // 5
    'USING',       // 5
    'FETCH',       // 5
    'FROM',        // 4
    'LEFT',        // 4  (appears before OUTER JOIN …)
    'FULL',        // 4  (appears before OUTER JOIN …)
    'INTO',        // 4
    'EXEC',        // 4
    'WITH',        // 4
    'USE',         // 3
    'AND',         // 3
    'SET',         // 3
    'OR',          // 2
    'ON',          // 2
];

interface DetectedKeyword {
    /** Number of leading spaces before the keyword. */
    indent: number;
    /** The keyword token as found in the line (preserves case). */
    token: string;
    /** Length of the canonical keyword (from KEYWORD_TOKENS). */
    canonicalLength: number;
    /** Everything after the keyword + its trailing spaces (the "content"). */
    content: string;
}

/**
 * Keywords that should be treated as JOIN continuations (sub-clause of FROM).
 * They are moved to the FROM content column rather than kept at the clause
 * keyword column, so they never inflate the max keyword width for the block.
 */
const JOIN_CLAUSE_KEYWORDS = new Set(['LEFT JOIN', 'FULL JOIN', 'OUTER APPLY', 'CROSS APPLY']);

/**
 * Keywords that act as boolean operators inside WHERE / ON / HAVING conditions.
 * They are rendered at the content column of the parent clause rather than as
 * independent clause keywords, so they never inflate the max keyword width.
 */
const CONDITION_OPERATORS = new Set(['AND', 'OR']);
const kwRegexCache = new Map<string, RegExp>();

function getKwRegex(kw: string): RegExp {
    let re = kwRegexCache.get(kw);
    if (!re) {
        // Escape spaces: "ORDER BY" → "ORDER\s+BY" to handle any whitespace between words
        const pattern = kw.replace(/\s+/g, '\\s+');
        re = new RegExp(`^(\\s*)(${pattern})[ \\t]+(.+)$`, 'i');
        kwRegexCache.set(kw, re);
    }
    return re;
}

function detectKeyword(line: string): DetectedKeyword | null {
    for (const kw of KEYWORD_TOKENS) {
        const m = line.match(getKwRegex(kw));
        if (m) {
            return {
                indent: m[1].length,
                token: m[2],
                canonicalLength: kw.length,
                content: m[3],
            };
        }
    }
    return null;
}

/**
 * Re-pads all lines in `block` (a blank-line-free fragment) from the
 * sql-formatter fixed width to the minimal width needed.
 *
 * Groups keyword lines by indent level; computes one new width per indent level
 * (max canonical keyword length at that level + 1 space minimum).
 *
 * Continuation lines (lines whose leading whitespace = indent + OLD_WIDTH) are
 * re-padded to indent + new_width.
 */
function rePadBlock(block: string, oldWidth: number): string {
    const lines = block.split('\n');

    // Build indent → max keyword length map.
    // AND/OR and JOIN keywords are excluded — they are rendered relative to the
    // content column of their parent clause and must not inflate the width.
    const indentMaxLen = new Map<number, number>();
    for (const line of lines) {
        const kw = detectKeyword(line);
        if (kw) {
            const kwUpper = kw.token.replace(/\s+/g, ' ').toUpperCase();
            if (!JOIN_CLAUSE_KEYWORDS.has(kwUpper) && !CONDITION_OPERATORS.has(kwUpper)) {
                const prev = indentMaxLen.get(kw.indent) ?? 0;
                indentMaxLen.set(kw.indent, Math.max(prev, kw.canonicalLength));
            }
        }
    }

    if (indentMaxLen.size === 0) return block;

    // Normalize singleton-indent blocks at the tabularLeft absolute column.
    // sql-formatter places keywords inside an inline `AND … BEGIN` block at
    // SQL_FORMATTER_KW_WIDTH (10) from the outer base rather than at 0.
    // If every clause keyword in the block is at exactly that column, the block
    // is a nested BEGIN body — strip the column offset so that
    // applyControlFlowIndentation can add the correct extra indent without
    // double-counting the 10 leading spaces.
    // indentRemap maps the old indent (e.g. 10) to the new indent (0) so the
    // re-emit loop can strip leading spaces from the affected keyword lines.
    const indentRemap = new Map<number, number>();
    if (indentMaxLen.size === 1) {
        const soleIndent = [...indentMaxLen.keys()][0];
        if (soleIndent === SQL_FORMATTER_KW_WIDTH) {
            const soleLen = indentMaxLen.get(soleIndent)!;
            indentMaxLen.clear();
            indentMaxLen.set(0, soleLen);
            indentRemap.set(soleIndent, 0);
        }
    }

    // New width for each indent level
    const indentNewWidth = new Map<number, number>();
    for (const [indent, maxLen] of indentMaxLen) {
        const newWidth = maxLen + 1; // at least 1 space after keyword
        indentNewWidth.set(indent, newWidth);
    }

    const newLines = lines.map(line => {
        // 1. Keyword line — adjust spacing after the keyword token
        const kw = detectKeyword(line);
        if (kw) {
            // Apply indent normalization (e.g. 10 → 0 for AND…BEGIN nested blocks)
            const effectiveIndent = indentRemap.get(kw.indent) ?? kw.indent;
            const newWidth = indentNewWidth.get(effectiveIndent);
            const kwUpper = kw.token.replace(/\s+/g, ' ').toUpperCase();

            // AND/OR and JOIN keywords render at the content column (indent + newWidth)
            // rather than at the keyword column (indent + 0) with extra padding.
            // Normalise internal whitespace in compound tokens (e.g. OUTER     APPLY → OUTER APPLY).
            if (CONDITION_OPERATORS.has(kwUpper) || JOIN_CLAUSE_KEYWORDS.has(kwUpper)) {
                if (newWidth === undefined) return line; // no clause keywords in block
                const normToken = kw.token.replace(/\s+/g, ' ');
                return ' '.repeat(effectiveIndent + newWidth) + normToken + ' ' + kw.content;
            }

            if (newWidth === undefined || (newWidth === oldWidth && effectiveIndent === kw.indent)) return line;
            const padding = ' '.repeat(newWidth - kw.token.replace(/\s+/g, ' ').length);
            return ' '.repeat(effectiveIndent) + kw.token + padding + kw.content;
        }

        // 2. Continuation line — its leading spaces = indent + oldWidth
        for (const [indent, newWidth] of indentNewWidth) {
            if (newWidth === oldWidth) continue;
            const oldLeading = indent + oldWidth;
            if (
                line.length > oldLeading &&
                line.slice(0, oldLeading) === ' '.repeat(oldLeading) &&
                line[oldLeading] !== ' '
            ) {
                return ' '.repeat(indent + newWidth) + line.slice(oldLeading);
            }
        }

        return line;
    });

    return newLines.join('\n');
}

/**
 * Applies minimal keyword padding to sql-formatter tabularLeft output.
 * Processes each blank-line-separated query block independently so that
 * two-clause queries (SELECT/FROM only) get width 7, while queries with
 * ORDER BY get width 9, etc.
 *
 * @param useTabular - When false, skip re-padding (only strip trailing spaces).
 *   Pass false for styles that do not use sql-formatter tabularLeft output.
 */
export function applyKeywordRePadding(sql: string, useTabular = true): string {
    if (!useTabular) {
        return sql.replace(/[ \t]+(?=\n|$)/gm, '');
    }
    // Split on blank lines, preserving the separators
    const parts = sql.split(/(\n{2,})/);
    const repaded = parts
        .map(part => (/^\n+$/.test(part) ? part : rePadBlock(part, SQL_FORMATTER_KW_WIDTH)))
        .join('');
    // Strip trailing whitespace from every line (sql-formatter tabularLeft pads
    // lone keywords like GO to SQL_FORMATTER_KW_WIDTH which leaves trailing spaces).
    return repaded.replace(/[ \t]+(?=\n|$)/gm, '');
}
