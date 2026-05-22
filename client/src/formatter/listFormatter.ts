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

// Clause keyword lines that start a comma-separated list we want to reformat.
// Matches: SELECT, ORDER BY, GROUP BY — capturing the full keyword+trailing-space prefix.
const LIST_CLAUSE_RE = /^(\s*(?:SELECT|ORDER\s+BY|GROUP\s+BY)\s+)(.*?)$/i;

/**
 * Collects a comma-separated item list starting at line `start` in `lines`,
 * given that the first item is `firstItemText` at column `kwWidth`.
 *
 * Returns { items, nextIndex }.
 */
function collectItems(
    lines: string[],
    start: number,
    firstItemText: string,
    kwWidth: number,
): { items: ColumnItem[]; nextIndex: number } {
    const items: ColumnItem[] = [];
    const continuationPrefix = ' '.repeat(kwWidth);

    const [fRawExpr, fComment] = splitComment(firstItemText.trim());
    const firstHasTrailing = fRawExpr.trimEnd().endsWith(',');
    const fExpr = firstHasTrailing ? fRawExpr.trimEnd().slice(0, -1).trimEnd() : fRawExpr.trimEnd();
    items.push({ expression: fExpr, comment: fComment });

    let i = start;

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

    return { items, nextIndex: i };
}

/**
 * Formats a collected list of items with leading-comma style.
 * The comma sits at column (kwWidth - 2) so that ", content" aligns at kwWidth.
 */
function formatItems(
    kwPrefix: string,
    kwWidth: number,
    items: ColumnItem[],
    alignComments: boolean,
): string[] {
    const commaIndent = Math.max(0, kwWidth - 2);
    const commaPad = ' '.repeat(commaIndent);

    let maxExprLen = 0;
    if (alignComments) {
        for (const item of items) {
            if (item.comment) maxExprLen = Math.max(maxExprLen, item.expression.length);
        }
    }

    const formatted: string[] = [];
    for (let j = 0; j < items.length; j++) {
        const { expression, comment } = items[j];
        let exprPart = expression;
        if (alignComments && comment && maxExprLen > 0) {
            exprPart = expression.padEnd(maxExprLen);
        }
        const commentPart = comment ? ' ' + comment : '';

        if (j === 0) {
            formatted.push(kwPrefix + exprPart + commentPart);
        } else {
            formatted.push(commaPad + ', ' + exprPart + commentPart);
        }
    }
    return formatted;
}

/**
 * Transforms SELECT, ORDER BY, and GROUP BY column lists from trailing-comma
 * style (sql-formatter default) to leading-comma style, and optionally aligns
 * inline `--` comments.
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

        const clauseMatch = line.match(LIST_CLAUSE_RE);
        if (!clauseMatch) {
            result.push(line);
            i++;
            continue;
        }

        const kwPrefix = clauseMatch[1]; // e.g. "SELECT    " or "ORDER BY "
        const kwWidth = kwPrefix.length;
        const firstItemText = clauseMatch[2];

        i++;

        const { items, nextIndex } = collectItems(lines, i, firstItemText, kwWidth);
        i = nextIndex;

        result.push(...formatItems(kwPrefix, kwWidth, items, alignComments));
    }

    return result.join('\n');
}

