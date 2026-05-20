import type { SqlPromptStyleJson } from './styleLoader';

/** Splits a content string into [expression, inline_comment]. */
function splitComment(text: string): [string, string] {
    const idx = text.indexOf('--');
    if (idx === -1) return [text.trimEnd(), ''];
    return [text.slice(0, idx).trimEnd(), text.slice(idx).trimStart()];
}

interface ColumnItem {
    expression: string;
    comment: string;
}

// SQL clause keywords that end a column list
const CLAUSE_RE =
    /^\s*(FROM|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|UNION(\s+ALL)?|INTERSECT|EXCEPT|INTO|ON|SET)\b/i;

// A line that is just a comma (possibly with trailing whitespace/comment)
const STANDALONE_COMMA_RE = /^\s*,\s*$/;

/**
 * Transforms SELECT column lists from trailing-comma style (sql-formatter default)
 * to leading-comma style, and optionally aligns inline `--` comments.
 *
 * Handles the two patterns sql-formatter produces:
 *   trailing comma:  "SELECT    col1,\n          col2,"
 *   comment + comma: "          col1 -- cmt\n,\n          col2"
 *
 * The comma is placed at column (keywordWidth - 2) so that the content after
 * ", " aligns with the first column (at keywordWidth).
 */
export function applyLeadingCommaFormat(
    sql: string,
    style: SqlPromptStyleJson,
): string {
    if (!style.lists?.placeCommasBeforeItems) return sql;

    const alignComments = style.lists.alignComments ?? false;
    const lines = sql.split('\n');
    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // Detect SELECT line: optional leading whitespace + SELECT + spaces + content
        const selectMatch = line.match(/^(\s*SELECT\s+)(.*?)$/i);
        if (!selectMatch) {
            result.push(line);
            i++;
            continue;
        }

        const kwPrefix = selectMatch[1]; // e.g. "SELECT    " or "        SELECT    "
        const kwWidth = kwPrefix.length; // column where list content starts
        const continuationPrefix = ' '.repeat(kwWidth);

        // --- collect items ---
        const items: ColumnItem[] = [];

        // First item is on the SELECT line itself
        // Split comment first so a trailing comma before an inline comment
        // (e.g. "col,   -- note") is correctly detected and removed.
        const [fRawExpr, fComment] = splitComment(selectMatch[2].trim());
        const firstHasTrailing = fRawExpr.trimEnd().endsWith(',');
        const fExpr = firstHasTrailing ? fRawExpr.trimEnd().slice(0, -1).trimEnd() : fRawExpr.trimEnd();
        items.push({ expression: fExpr, comment: fComment });

        i++;

        // A comment-bearing first item may have its comma on the very next line
        if (!firstHasTrailing && i < lines.length && STANDALONE_COMMA_RE.test(lines[i])) {
            i++;
        }

        // Collect continuation lines until a clause keyword or wrong indentation
        while (i < lines.length) {
            const contLine = lines[i];

            if (CLAUSE_RE.test(contLine)) break;

            // Standalone comma: belongs to the previous item, skip
            if (STANDALONE_COMMA_RE.test(contLine)) {
                i++;
                continue;
            }

            // Must be a continuation line (exactly kwWidth leading spaces)
            if (!contLine.startsWith(continuationPrefix)) break;
            // Guard: an extra space beyond kwWidth means this is a deeper-indented
            // line (e.g. a sub-expression) — stop collecting to avoid corruption
            const afterPrefix = contLine.charAt(kwWidth);
            if (afterPrefix === ' ') break;

            // Split comment first so a trailing comma before an inline comment
            // (e.g. "col,   -- note") is correctly detected and removed.
            const [rawExpr, comment] = splitComment(contLine.slice(kwWidth).trim());
            const hasTrailing = rawExpr.trimEnd().endsWith(',');
            const expr = hasTrailing ? rawExpr.trimEnd().slice(0, -1).trimEnd() : rawExpr.trimEnd();
            items.push({ expression: expr, comment });
            i++;

            // Consume a standalone comma line that follows this item
            if (!hasTrailing && i < lines.length && STANDALONE_COMMA_RE.test(lines[i])) {
                i++;
            }
        }

        // --- format items ---
        // Comma sits at (kwWidth - 2) so that ", content" aligns at kwWidth.
        const commaIndent = Math.max(0, kwWidth - 2);
        const commaPad = ' '.repeat(commaIndent);

        // Comment alignment: pad all commented items to the max expression length
        let maxExprLen = 0;
        if (alignComments) {
            for (const item of items) {
                if (item.comment) maxExprLen = Math.max(maxExprLen, item.expression.length);
            }
        }

        for (let j = 0; j < items.length; j++) {
            const { expression, comment } = items[j];
            let exprPart = expression;
            if (alignComments && comment && maxExprLen > 0) {
                exprPart = expression.padEnd(maxExprLen);
            }
            const commentPart = comment ? ' ' + comment : '';

            if (j === 0) {
                // First item stays on the SELECT line
                result.push(kwPrefix + exprPart + commentPart);
            } else {
                result.push(commaPad + ', ' + exprPart + commentPart);
            }
        }
    }

    return result.join('\n');
}
