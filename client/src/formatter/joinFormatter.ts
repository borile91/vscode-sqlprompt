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
    const maxLen = style.whitespace?.wrapLinesLongerThan ?? 9999;

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
                if (placeOnNewLine) {
                    result.push(' '.repeat(effectiveIndent) + joinKeyword + ' ' + tableOnly);
                    const onIndent = computeOnIndent(effectiveIndent, joinKeyword, keywordAlignment, tabWidth);
                    result.push(' '.repeat(onIndent) + 'ON ' + condition);
                    i++;
                    // Re-indent AND/OR condition continuations after ON
                    i = reindentConditions(lines, i, onIndent, conditionAlignment, result);
                } else {
                    const joinOnLine = ' '.repeat(effectiveIndent) + joinKeyword + ' ' + tableOnly + ' ON ' + condition;
                    i++;
                    // For toInner alignment, collect AND/OR conditions and either join or re-indent.
                    if (conditionAlignment === 'toInner') {
                        const andConds: string[] = [];
                        while (i < lines.length) {
                            const am = lines[i].match(/^\s*((?:AND|OR)\b.*)/i);
                            if (!am) break;
                            andConds.push(am[1].trimStart());
                            i++;
                        }
                        if (andConds.length === 0) {
                            result.push(joinOnLine);
                        } else {
                            const fullLine = joinOnLine + ' ' + andConds.join(' ');
                            if (fullLine.length <= maxLen) {
                                result.push(fullLine);
                            } else {
                                result.push(joinOnLine);
                                // condCol: column where the first condition starts (after "ON ")
                                const condCol = joinOnLine.lastIndexOf(' ON ') + ' ON '.length;
                                for (const cond of andConds) {
                                    result.push(' '.repeat(condCol) + cond);
                                }
                            }
                        }
                    } else {
                        result.push(joinOnLine);
                    }
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
        const m = lines[i].match(/^(\s*)(FROM|SELECT)(\s+)\S/i);
        if (m) return m[1].length + m[2].length + m[3].length;
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

/**
 * Collapses OUTER APPLY (or CROSS APPLY) subqueries into an inline format where
 * SELECT follows the opening parenthesis on the same line, body lines are
 * re-indented to align with SELECT, AND ( … ) condition groups are collapsed,
 * and the closing ) AS alias is merged onto the last body line.
 *
 * This runs after applyProcBodyIndentation so indentation levels are final.
 */
export function applyOuterApplyInlineFormat(
    sql: string,
    spacesInside = true,
    commaFirst = false,
): string {
    const lines = sql.split('\n');
    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // Match: whitespace + "OUTER APPLY" or "CROSS APPLY" + optional whitespace + "(" + EOL
        const applyMatch = line.match(/^(\s+)((?:OUTER|CROSS)\s+APPLY)\s*\(\s*$/i);
        if (!applyMatch) {
            result.push(line);
            i++;
            continue;
        }

        const outerIndent = applyMatch[1];          // e.g. "     " (5 spaces after applyJoinOnFormatting)
        const keyword = applyMatch[2];              // "OUTER APPLY"
        const sp = spacesInside ? ' ' : '';
        const prefix = outerIndent + keyword + ' (' + sp; // "     OUTER APPLY ( " or "     OUTER APPLY ("
        const contentIndentLen = prefix.length;
        i++;

        // Next line should be the first body line (SELECT)
        if (i >= lines.length) {
            result.push(line);
            continue;
        }

        const selectLine = lines[i];
        const origIndentMatch = selectLine.match(/^(\s+)/);
        if (!origIndentMatch) {
            // No leading indent — give up on this APPLY block
            result.push(line);
            continue;
        }
        const origIndentLen = origIndentMatch[1].length;
        i++; // consume SELECT line; it will be inlined

        // Collect body lines until closing ) which is at indent <= outerIndent.length.
        // NOTE: applyJoinOnFormatting may re-indent OUTER APPLY (e.g. 4→5 spaces) while the
        // closing ")" stays at the original sql-formatter indent (4 spaces). Use actualIndent
        // to detect the closing paren correctly.
        const bodyLines: string[] = [];
        let aliasSuffix = '';
        while (i < lines.length) {
            const bl = lines[i];
            const blActualIndent = bl.length - bl.trimStart().length;
            // Closing: a line whose first non-space char is ")" at indent <= outerIndent
            if (bl.trimStart().charAt(0) === ')' && blActualIndent <= outerIndent.length) {
                aliasSuffix = bl.slice(blActualIndent + 1); // everything after ")"
                i++;
                break;
            }
            bodyLines.push(bl);
            i++;
        }

        // Re-indent body lines: add (contentIndentLen - origIndentLen) spaces
        const delta = contentIndentLen - origIndentLen;
        let reindented = bodyLines.map(bl => {
            const blIndentLen = (bl.match(/^(\s*)/)?.[1] ?? '').length;
            if (blIndentLen >= origIndentLen) {
                return ' '.repeat(blIndentLen + delta) + bl.trimStart();
            }
            return bl;
        });

        // If SELECT contains an inline comment and trailing comma-items on the same line,
        // split those items out so non-inline styles can keep leading-comma lines.
        let normalizedSelectLine = selectLine;
        const selectHasComment = /--/.test(selectLine);
        if (selectHasComment) {
            const commaAfterCommentIdx = selectLine.indexOf(',', selectLine.indexOf('--'));
            if (commaAfterCommentIdx >= 0) {
                const trailing = selectLine.slice(commaAfterCommentIdx + 1).trim();
                normalizedSelectLine = selectLine.slice(0, commaAfterCommentIdx).trimEnd();
                // Determine whether it's leading comma or scripting continuation
                const isCommaFirst = commaFirst;
                const trailingItems = trailing
                    .split(',')
                    .map((p) => p.trim())
                    .filter(Boolean)
                    .map((item) => {
                        if (isCommaFirst) {
                            return ' '.repeat(contentIndentLen + 5) + ', ' + item;
                        } else {
                            // Scripting continuation align with l.IdLotto
                            return ' '.repeat(contentIndentLen + 8) + item + ',';
                        }
                    });

                // For scripting, remove the last trailing comma added
                if (!isCommaFirst && trailingItems.length > 0) {
                    trailingItems[trailingItems.length - 1] = trailingItems[trailingItems.length - 1].slice(0, -1);
                }

                reindented = [...trailingItems, ...reindented];
            }
        }

        // Inline SELECT items, FROM clause items, and WHERE with conditions.
        const canInlineSelectExtras = !selectHasComment;
        const inlined = inlineBodyClauses(reindented, contentIndentLen, spacesInside, canInlineSelectExtras);

        // Build first (inline) line: SELECT keyword + any SELECT items
        let firstLine = prefix + normalizedSelectLine.trimStart();
        if (inlined.selectExtras.length > 0) {
            firstLine += ' ' + inlined.selectExtras.join(', ');
        }

        // Append outer closing ")" and alias to last line
        const body = inlined.rest;
        if (body.length > 0) {
            const lastTrimmed = body[body.length - 1].trimEnd();
            const closeOuter = spacesInside && !lastTrimmed.endsWith(')') ? ' )' : ')';
            body[body.length - 1] += closeOuter + aliasSuffix;
        } else {
            result.push(firstLine + ')' + aliasSuffix);
            continue;
        }

        result.push(firstLine, ...body);
    }

    return result.join('\n');
}

/**
 * After re-indenting the OUTER APPLY body, inline SELECT items onto the firstLine,
 * collapse FROM/WHERE keywords with their items, and re-align AND conditions for WHERE
 * using "toInner" alignment (AND at WHERE_indent + 'WHERE '.length).
 * AND ( … ) paren groups are collapsed to one line when spacesInside=false.
 */
function inlineBodyClauses(
    body: string[],
    baseIndentLen: number,
    spacesInside: boolean,
    canInlineSelectExtras = true,
): { selectExtras: string[]; rest: string[] } {
    const tabWidth = 4; // body items are at baseIndentLen + tabWidth
    const itemIndentLen = baseIndentLen + tabWidth;

    // Collect SELECT item lines at the top (at baseIndentLen + tabWidth or deeper)
    const selectExtras: string[] = [];
    let i = 0;
    while (i < body.length && canInlineSelectExtras) {
        const bl = body[i];
        const blInd = (bl.match(/^(\s*)/)?.[1] ?? '').length;
        if (blInd < itemIndentLen) break;
        const trimmed = bl.trimStart();
        // Stop if this is a clause keyword (FROM/WHERE/GROUP BY etc.)
        if (/^(FROM|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY)\b/i.test(trimmed)) break;
        selectExtras.push(trimmed.replace(/,\s*$/, ''));
        i++;
    }

    // Process FROM / WHERE clauses
    const rest: string[] = [];
    while (i < body.length) {
        const bl = body[i];
        const blInd = (bl.match(/^(\s*)/)?.[1] ?? '').length;

        const fromMatch = blInd === baseIndentLen ? bl.trimStart().match(/^(FROM)\s*$/i) : null;
        const whereMatch = blInd === baseIndentLen ? bl.trimStart().match(/^(WHERE)\s*$/i) : null;

        if (fromMatch || whereMatch) {
            i++;

            // Collect items at baseIndentLen + tabWidth (and deeper for paren groups)
            const items: string[] = [];
            while (i < body.length) {
                const item = body[i];
                const itemInd = (item.match(/^(\s*)/)?.[1] ?? '').length;
                if (itemInd < itemIndentLen) break;
                items.push(item.trimStart().replace(/,\s*$/, ''));
                i++;
            }

            if (items.length === 0) {
                rest.push(bl.trimEnd()); // emit keyword-only line without trailing spaces
                continue;
            }

            // Use the original keyword line (bl) as the prefix to preserve padding.
            // If bl ends with a space (padded keyword), append item directly.
            // Otherwise append with an extra space.
            const kwPrefix = bl.endsWith(' ') ? bl : bl + ' ';
            const condCol = kwPrefix.length; // AND conditions align at this column

            if (fromMatch) {
                rest.push(kwPrefix + items.join(' '));
            } else {
                // WHERE: first condition inline, AND/OR conditions at condCol
                rest.push(kwPrefix + items[0]);
                for (let k = 1; k < items.length; k++) {
                    const item = items[k];
                    // Collapse AND ( … ) paren groups
                    if (item.match(/^AND\s*\(\s*$/i)) {
                        // Collect group content until closing ")"
                        const groupContent: string[] = [];
                        k++;
                        while (k < items.length && !items[k].match(/^\)\s*$/)) {
                            groupContent.push(items[k]);
                            k++;
                        }
                        if (!spacesInside) {
                            // Collapse to one line: AND (content)
                            rest.push(' '.repeat(condCol) + 'AND (' + groupContent.join(' ') + ')');
                        } else {
                            // Multi-line with spaces inside: AND ( firstContent\n  OR ... )
                            const andPrefix = ' '.repeat(condCol) + 'AND ( ';
                            const innerIndent = ' '.repeat(andPrefix.length);
                            rest.push(andPrefix + groupContent[0]);
                            for (let g = 1; g < groupContent.length; g++) {
                                rest.push(innerIndent + groupContent[g]);
                            }
                            if (rest.length > 0) {
                                rest[rest.length - 1] += ' )';
                            }
                        }
                    } else {
                        rest.push(' '.repeat(condCol) + item);
                    }
                }
            }
            continue;
        }

        rest.push(bl);
        i++;
    }

    return { selectExtras, rest: collapseAndParenGroups(rest, spacesInside) };
}

/**
 * Within a block of re-indented lines, collapses patterns like:
 *   <indent>AND (
 *   <indent><content>
 *   <indent>OR <content>
 *   <indent>)
 * into:
 *   <indent>AND ( <content>
 *   <indent+6>OR <content> )
 */
function collapseAndParenGroups(lines: string[], spacesInside = true): string[] {
    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // Match: indent + "AND" + whitespace + "(" + EOL
        const andMatch = line.match(/^(\s+)(AND\s*)\(\s*$/i);
        if (andMatch) {
            const andIndent = andMatch[1];  // spaces before AND
            const andKey = andMatch[2];     // "AND " or "AND  "
            const sp = spacesInside ? ' ' : '';
            const andPrefix = andIndent + andKey + '(' + sp; // "                                AND ( "
            const innerIndentLen = andPrefix.length;
            i++;

            const innerLines: string[] = [];
            let hasClosing = false;
            while (i < lines.length) {
                const inner = lines[i];
                // Closing: same indent as AND + ")" + EOL
                if (inner.startsWith(andIndent) && inner.slice(andIndent.length).match(/^\)\s*$/)) {
                    hasClosing = true;
                    i++;
                    break;
                }
                innerLines.push(inner);
                i++;
            }

            if (innerLines.length === 0) {
                result.push(line);
                continue;
            }

            // First inner line goes inline with "AND ("
            result.push(andPrefix + innerLines[0].trimStart());

            // Subsequent inner lines align at innerIndentLen
            for (let j = 1; j < innerLines.length; j++) {
                result.push(' '.repeat(innerIndentLen) + innerLines[j].trimStart());
            }

            // Append closing ")" to last pushed line
            if (hasClosing && result.length > 0) {
                result[result.length - 1] += spacesInside ? ' )' : ')';
            }
            continue;
        }

        result.push(line);
        i++;
    }

    return result;
}
