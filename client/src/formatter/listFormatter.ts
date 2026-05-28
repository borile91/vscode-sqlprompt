import type { SqlPromptStyleJson } from './styleLoader';

/**
 * Counts net open parentheses in a string, skipping paren characters inside
 * single-quoted string literals and after `--` line comments.
 */
function computeNetParens(s: string): number {
    let depth = 0;
    let inStr = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
            if (ch === "'") {
                // Escaped quote ''
                if (s[i + 1] === "'") { i++; continue; }
                inStr = false;
            }
            continue;
        }
        // Line comment: rest of this string segment is a comment
        if (ch === '-' && s[i + 1] === '-') break;
        if (ch === "'") { inStr = true; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
    }
    return depth;
}

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
 * Tracks parenthesis depth so that a function call whose arguments are spread
 * across multiple lines by sql-formatter (e.g. `STUFF(` on one line, `(` on
 * the next) is treated as a single multi-line item rather than separate items.
 * Subsequent SELECT items after the closing paren are collected normally.
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
    // Track net open parentheses from the last collected item.
    // When > 0, the next lines at kwWidth belong to that item (they are inside
    // the open function call) rather than being new SELECT list items.
    let openDepth = computeNetParens(fExpr);

    // A comment-bearing first item may have its comma on the very next line
    if (!firstHasTrailing && i < lines.length && STANDALONE_COMMA_RE.test(lines[i])) {
        i++;
    }

    // Collect continuation lines until a clause keyword or wrong indentation
    while (i < lines.length) {
        const contLine = lines[i];

        // Standalone comma: belongs to the previous item, skip (always, even
        // when openDepth > 0, e.g. comment-bearing items in a function call).
        if (STANDALONE_COMMA_RE.test(contLine)) {
            i++;
            continue;
        }

        if (openDepth > 0) {
            // We are inside an open parenthesis from the last item.
            // Consume this line as a continuation of that item regardless of
            // clause keywords and indentation level — sub-clauses like FROM,
            // WHERE inside a subquery argument are not top-level list
            // terminators.
            const lineDepth = computeNetParens(contLine);
            const newDepth = openDepth + lineDepth;
            const lastItem = items[items.length - 1];

            if (newDepth <= 0) {
                // This line closes the outermost paren — strip the trailing
                // SELECT-list comma (the item separator) but keep the rest.
                lastItem.expression += '\n' + contLine.replace(/,\s*$/, '');
                openDepth = 0;
            } else {
                lastItem.expression += '\n' + contLine;
                openDepth = newDepth;
            }
            i++;
            continue;
        }

        // openDepth === 0: normal new-item collection.
        if (CLAUSE_RE.test(contLine)) break;

        // Must start with at least kwWidth spaces
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
        openDepth = computeNetParens(expr);

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
/**
 * Collapses a multi-line SELECT item list (e.g. the values part of an
 * INSERT … SELECT) into a single line when it has no FROM/WHERE/etc. clauses.
 *
 * Returns the collapsed line and the index after the last consumed line, or
 * null if the SELECT has fewer than two items or contains clause keywords.
 */
function collapseSelectItems(
    lines: string[],
    selectIdx: number,
    selectIndent: string,
    firstItem: string,
): { line: string; nextIndex: number } | null {
    const kwWidth = 'SELECT '.length; // 7
    const contPrefix = selectIndent + ' '.repeat(kwWidth);

    const items: string[] = [firstItem.replace(/,\s*$/, '').trim()];
    let j = selectIdx + 1;
    let hasFinalSemi = false;

    while (j < lines.length) {
        const contLine = lines[j];
        // Stop if indentation doesn't match continuation prefix
        if (!contLine.startsWith(contPrefix)) break;
        // Guard: one extra space means a deeper-indented sub-expression — stop
        if (contLine.charAt(contPrefix.length) === ' ') break;
        // Stop at clause keywords (FROM, WHERE, GROUP BY, …)
        if (CLAUSE_RE.test(contLine)) break;

        const itemText = contLine.slice(contPrefix.length);
        const isFinalItem = itemText.trimEnd().endsWith(';');
        const item = itemText.replace(/[,;]\s*$/, '').trim();
        items.push(item);
        j++;
        if (isFinalItem) {
            hasFinalSemi = true;
            break;
        }
    }

    if (items.length <= 1) return null;

    return {
        line: `${selectIndent}SELECT ${items.join(', ')}${hasFinalSemi ? ';' : ''}`,
        nextIndex: j,
    };
}

export function applyLeadingCommaFormat(
    sql: string,
    style: SqlPromptStyleJson,
): string {
    if (!style.lists?.placeCommasBeforeItems) return sql;
    const listBreakMode = style.lists.placeSubsequentItemsOnNewLines;
    const forceLeadingCommaLayout =
        listBreakMode !== 'never' && listBreakMode !== 'ifLongerThanMaxLineLength';

    const hasInsertConfig = !!style.insertStatements?.columns?.parenthesisStyle;

    // Nothing to do: leading-comma layout is disabled and no INSERT config to apply
    if (!forceLeadingCommaLayout && !hasInsertConfig) return sql;

    const alignComments = style.lists.alignComments ?? false;
    const alignAliases = style.lists.alignAliases ?? false;
    const spacesInside = style.parentheses?.addSpacesInsideParentheses ?? false;
    const columnsBreakMode = style.insertStatements?.columns?.placeSubsequentColumnsOnNewLines;
    const tabWidth = style.whitespace?.numberOfSpacesInTabs ?? 4;
    const maxLineLen = style.whitespace?.wrapLinesLongerThan ?? Infinity;
    const lines = sql.split('\n');
    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // ── INSERT column formatting ─────────────────────────────────────────
        // Runs regardless of forceLeadingCommaLayout so that insertStatements
        // config is always honoured (e.g. placeSubsequentColumnsOnNewLines:
        // "never" with placeSubsequentItemsOnNewLines: "ifLongerThanMaxLineLength").
        if (hasInsertConfig) {
            // ── Single-line INSERT: INSERT [INTO] table(col1, col2, …) ────────
            const insertMatch = line.match(
                /^([ \t]*)INSERT\s+(INTO\s+)?(\S+)\s*\(([^)]*)\)\s*$/i,
            );
            if (insertMatch) {
                const [, lineIndent, intoClause, tableName, columnListStr] = insertMatch;
                const columns = columnListStr.split(',').map(c => c.trim()).filter(Boolean);

                if (columnsBreakMode === 'never') {
                    const intoStr = intoClause ? 'INTO ' : '';
                    const insertParenStyle = style.insertStatements?.columns?.parenthesisStyle;
                    if (
                        insertParenStyle === 'expandedSplit' ||
                        insertParenStyle === 'expandedSimple' ||
                        insertParenStyle === 'expandedIndented'
                    ) {
                        // ( on its own line; columns at openParenCol + tabWidth; ) at openParenCol
                        const openParenCol =
                            lineIndent.length + 'INSERT '.length + intoStr.length + tableName.length + 1;
                        const colIndent = ' '.repeat(openParenCol + tabWidth);
                        const parenClose = ' '.repeat(openParenCol) + ')';
                        result.push(`${lineIndent}INSERT ${intoStr}${tableName} (`);
                        result.push(`${colIndent}${columns.join(', ')}`);
                        result.push(parenClose);
                        i++;
                    } else {
                        const openParen = spacesInside ? '( ' : '(';
                        const closeSuffix = spacesInside ? ' )' : ')';
                        result.push(
                            `${lineIndent}INSERT ${intoStr}${tableName} ${openParen}${columns.join(', ')}${closeSuffix}`,
                        );
                        i++;
                        // For INSERT … SELECT: collapse the SELECT values to one line
                        if (i < lines.length) {
                            const nextLine = lines[i];
                            const selMatch = nextLine.match(/^([ \t]*)SELECT\s+(.*?),\s*$/i);
                            if (selMatch) {
                                const collapsed = collapseSelectItems(lines, i, selMatch[1], selMatch[2]);
                                if (collapsed) {
                                    result.push(collapsed.line);
                                    i = collapsed.nextIndex;
                                }
                            }
                        }
                    }
                    continue;
                }

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
                    const intoStr = intoClause ? 'INTO ' : '';
                    const openParen = spacesInside ? '( ' : '(';
                    const closeSuffix = spacesInside ? ' )' : ')';
                    const firstLinePrefix = `${lineIndent}INSERT ${intoStr}${tableName} ${openParen}`;
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

            // ── Multi-line INSERT: INSERT [INTO] table (\n  col,\n  …\n  ) ──
            // Handles the case where sql-formatter expanded the column list
            // across multiple lines (expressionWidth smaller than column list).
            const insertMultiMatch = line.match(
                /^([ \t]*)INSERT\s+(INTO\s+)?(\S+)\s*\(\s*$/i,
            );
            if (insertMultiMatch && columnsBreakMode === 'never') {
                const [, lineIndent, intoClause, tableName] = insertMultiMatch;
                const columns: string[] = [];
                let j = i + 1;
                while (j < lines.length) {
                    const trimmed = lines[j].trim();
                    if (/^\)\s*;?\s*$/.test(trimmed)) break;
                    if (trimmed) columns.push(trimmed.replace(/,\s*$/, ''));
                    j++;
                }
                const closingTrimmed = (lines[j] ?? '').trim();
                const hasSemicolon = closingTrimmed === ');';
                j++;

                const openParen = spacesInside ? '( ' : '(';
                const closeSuffix = spacesInside ? ' )' : ')';
                result.push(
                    `${lineIndent}INSERT ${intoClause ? 'INTO ' : ''}${tableName} ${openParen}${columns.join(', ')}${closeSuffix}${hasSemicolon ? ';' : ''}`,
                );

                // For INSERT … SELECT: collapse the SELECT values to one line
                if (!hasSemicolon && j < lines.length) {
                    const nextLine = lines[j];
                    const selMatch = nextLine.match(/^([ \t]*)SELECT\s+(.*?),\s*$/i);
                    if (selMatch) {
                        const collapsed = collapseSelectItems(lines, j, selMatch[1], selMatch[2]);
                        if (collapsed) {
                            result.push(collapsed.line);
                            j = collapsed.nextIndex;
                        }
                    }
                }

                i = j;
                continue;
            }
        }

        // ── Leading-comma layout for SELECT / ORDER BY / GROUP BY / SET ──────
        // Only applied when forceLeadingCommaLayout is true.
        if (!forceLeadingCommaLayout) {
            // For 'never' and 'ifLongerThanMaxLineLength', pack tabularLeft
            // continuation lines into wrapped lines with leading commas.
            if (listBreakMode === 'never' || listBreakMode === 'ifLongerThanMaxLineLength') {
                const clauseCollapseMatch = line.match(LIST_CLAUSE_RE);
                if (clauseCollapseMatch) {
                    const kwPrefix = clauseCollapseMatch[1];
                    const firstItemText = clauseCollapseMatch[2];
                    const kwWidthBase = kwPrefix.length;
                    i++;
                    const { items, nextIndex } = collectItems(lines, i, firstItemText, kwWidthBase);
                    i = nextIndex;
                    const allExprs = items.map(it =>
                        it.expression + (it.comment ? ' ' + it.comment : ''),
                    );
                    const oneLine = kwPrefix + allExprs.join(', ');

                    if (listBreakMode === 'ifLongerThanMaxLineLength') {
                        // Keep inline if fits; otherwise fall back to vertical.
                        if (isFinite(maxLineLen) && oneLine.length > maxLineLen) {
                            result.push(...formatItems(kwPrefix, kwWidthBase, items, alignComments, alignAliases));
                        } else {
                            result.push(oneLine);
                        }
                    } else {
                        // 'never': pack items greedily onto lines ≤ maxLineLen.
                        if (!isFinite(maxLineLen) || oneLine.length <= maxLineLen) {
                            result.push(oneLine);
                        } else {
                            const commaIndent = Math.max(0, kwWidthBase - 2);
                            const commaPad = ' '.repeat(commaIndent);
                            let currentLine = kwPrefix;
                            let first = true;
                            for (const expr of allExprs) {
                                if (first) {
                                    currentLine += expr;
                                    first = false;
                                } else {
                                    const candidate = currentLine + ', ' + expr;
                                    if (candidate.length >= maxLineLen - tabWidth) {
                                        result.push(currentLine);
                                        currentLine = commaPad + ', ' + expr;
                                    } else {
                                        currentLine = candidate;
                                    }
                                }
                            }
                            if (currentLine.trim()) result.push(currentLine);
                        }
                    }
                    continue;
                }
            }
            result.push(line);
            i++;
            continue;
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

