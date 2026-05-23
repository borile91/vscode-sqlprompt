import type { SqlPromptStyleJson } from './styleLoader';

/** Splits a content string into [expression, inline_comment]. */
function splitComment(text: string): [string, string] {
    const idx = text.indexOf('--');
    if (idx === -1) return [text.trimEnd(), ''];
    return [text.slice(0, idx).trimEnd(), text.slice(idx).trimStart()];
}

/**
 * Splits a column expression into [baseExpression, alias] where alias is the
 * " AS name" or " name" suffix, or empty string if there is no alias.
 * Only splits on an unquoted AS keyword or a bare trailing identifier.
 */
function splitAlias(expression: string): [string, string] {
    // Match "expr AS alias" (alias is a single identifier or quoted identifier)
    const asMatch = expression.match(/^(.*?)\s+(AS\s+\S+)$/i);
    if (asMatch) return [asMatch[1].trimEnd(), asMatch[2]];
    return [expression, ''];
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
// Matches: SELECT, ORDER BY, GROUP BY, and UPDATE SET (but not SET @variable).
const LIST_CLAUSE_RE =
    /^(\s*(?:SELECT|ORDER\s+BY|GROUP\s+BY|SET(?!\s*@))\s+)(.*?)$/i;

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
 * When alignAliases is true, AS alias parts are padded to the same column.
 * When alignComments is true, inline comments are padded to the same column.
 */
function formatItems(
    kwPrefix: string,
    kwWidth: number,
    items: ColumnItem[],
    alignComments: boolean,
    alignAliases: boolean,
): string[] {
    const commaIndent = Math.max(0, kwWidth - 2);
    const commaPad = ' '.repeat(commaIndent);

    // Split each expression into [base, alias]
    const split = items.map(item => {
        const [base, alias] = alignAliases ? splitAlias(item.expression) : [item.expression, ''];
        return { base, alias, comment: item.comment };
    });

    // Compute max base expression length (for alias alignment)
    let maxBaseLen = 0;
    if (alignAliases) {
        for (const { base, alias } of split) {
            if (alias) maxBaseLen = Math.max(maxBaseLen, base.length);
        }
    }

    // Compute max expression+alias length (for comment alignment)
    let maxExprLen = 0;
    if (alignComments) {
        for (const { base, alias } of split) {
            const expr = alignAliases && alias && maxBaseLen > 0
                ? base.padEnd(maxBaseLen) + ' ' + alias
                : base + (alias ? ' ' + alias : '');
            for (const item of items) {
                if (item.comment) maxExprLen = Math.max(maxExprLen, expr.length);
            }
        }
        // Simpler recalculation:
        maxExprLen = 0;
        for (let idx = 0; idx < split.length; idx++) {
            const { base, alias } = split[idx];
            if (items[idx].comment) {
                const expr = alignAliases && alias && maxBaseLen > 0
                    ? base.padEnd(maxBaseLen) + ' ' + alias
                    : base + (alias ? ' ' + alias : '');
                maxExprLen = Math.max(maxExprLen, expr.length);
            }
        }
    }

    const formatted: string[] = [];
    for (let j = 0; j < split.length; j++) {
        const { base, alias } = split[j];
        const { comment } = items[j];

        let exprPart: string;
        if (alignAliases && alias && maxBaseLen > 0) {
            exprPart = base.padEnd(maxBaseLen) + ' ' + alias;
        } else {
            exprPart = base + (alias ? ' ' + alias : '');
        }

        if (alignComments && comment && maxExprLen > 0) {
            exprPart = exprPart.padEnd(maxExprLen);
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
    const alignAliases = style.lists.alignAliases ?? false;
    const lines = sql.split('\n');
    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // ── INSERT column expansion ──────────────────────────────────────────
        // When `insertStatements.columns.parenthesisStyle` is set, expand the
        // INSERT column list: single column gets spaces-inside-parens inline,
        // multiple columns are expanded to leading-comma multi-line format.
        if (style.insertStatements?.columns?.parenthesisStyle) {
            const insertMatch = line.match(
                /^([ \t]*)INSERT\s+(INTO\s+)?(\S+)\s*\(([^)]*)\)\s*$/i,
            );
            if (insertMatch) {
                const [, lineIndent, intoClause, tableName, columnListStr] = insertMatch;
                const spacesInside = style.parentheses?.addSpacesInsideParentheses ?? false;
                const columns = columnListStr.split(',').map(c => c.trim()).filter(Boolean);

                if (columns.length <= 1) {
                    // Single column: keep inline, optionally add spaces inside parens
                    if (spacesInside && columns.length === 1) {
                        result.push(
                            `${lineIndent}INSERT ${intoClause ? 'INTO ' : ''}${tableName} ( ${columns[0]} )`,
                        );
                    } else {
                        result.push(line);
                    }
                } else {
                    // Multi-column: expand with leading-comma format.
                    // Use plain "INSERT " (1 space) as the keyword prefix regardless
                    // of whatever tabularLeft padding was applied by applyKeywordRePadding,
                    // so that the continuation alignment matches SQL Prompt conventions.
                    const intoStr = intoClause ? 'INTO ' : '';
                    const openParen = spacesInside ? '( ' : '(';
                    const closeSuffix = spacesInside ? ' )' : ')';
                    const firstLinePrefix = `${lineIndent}INSERT ${intoStr}${tableName} ${openParen}`;
                    // Continuation comma sits 2 chars before the first-column position
                    const contIndent = ' '.repeat(firstLinePrefix.length - lineIndent.length - 2);
                    result.push(`${firstLinePrefix}${columns[0]}`);
                    for (let c = 1; c < columns.length - 1; c++) {
                        result.push(`${lineIndent}${contIndent}, ${columns[c]}`);
                    }
                    result.push(
                        `${lineIndent}${contIndent}, ${columns[columns.length - 1]}${closeSuffix}`,
                    );
                }
                i++;
                continue;
            }
        }

        const clauseMatch = line.match(LIST_CLAUSE_RE);
        if (!clauseMatch) {
            result.push(line);
            i++;
            continue;
        }

        const kwPrefix = clauseMatch[1]; // e.g. "SELECT    " or "ORDER BY "
        const kwWidthBase = kwPrefix.length;
        const firstItemText = clauseMatch[2];

        // For SELECT statements, a TOP (n) or DISTINCT modifier shifts the first
        // column expression rightward.  Detect and account for it so that
        // continuation-line commas align under the first real column, not under
        // the keyword content start.
        let effectiveKwWidth = kwWidthBase;
        if (/^SELECT\s/i.test(kwPrefix.trimStart())) {
            const topMatch = firstItemText.match(/^((?:TOP|DISTINCT)\s*(?:\([^)]*\))?\s*)/i);
            if (topMatch) {
                effectiveKwWidth = kwWidthBase + topMatch[1].length;
            }
        }

        i++;

        const { items, nextIndex } = collectItems(lines, i, firstItemText, kwWidthBase);
        i = nextIndex;

        result.push(...formatItems(kwPrefix, effectiveKwWidth, items, alignComments, alignAliases));
    }

    return result.join('\n');
}

