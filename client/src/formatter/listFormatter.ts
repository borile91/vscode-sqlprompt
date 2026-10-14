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

// ── Disposizione della virgola iniziale ──────────────────────────────────────

/** Opzioni della virgola iniziale lette dallo stile. */
interface CommaLayout {
    alignment: 'beforeItem' | 'toList' | 'toStatement';
    /** Separatore: ", " oppure "," (addSpaceBeforeComma). */
    sep: string;
}

function readCommaLayout(style: SqlPromptStyleJson): CommaLayout {
    const a = style.lists?.commaAlignment;
    return {
        alignment: a === 'toList' || a === 'toStatement' ? a : 'beforeItem',
        // Default storico: spazio dopo la virgola
        sep: style.lists?.addSpaceBeforeComma === false ? ',' : ', ',
    };
}

/**
 * Prefisso degli elementi successivi al primo e colonna in cui inizia l'elemento.
 *   beforeItem:  virgola subito prima dell'elemento, allineato al primo
 *   toList:      virgola sulla colonna del primo elemento
 *   toStatement: virgola sulla colonna della keyword, elemento allineato al primo
 */
function leadingCommaPrefix(
    stmtCol: number,
    listCol: number,
    layout: CommaLayout,
): { prefix: string; itemCol: number } {
    const { sep } = layout;
    if (layout.alignment === 'toList') {
        return { prefix: ' '.repeat(listCol) + sep, itemCol: listCol + sep.length };
    }
    if (layout.alignment === 'toStatement') {
        const itemCol = Math.max(listCol, stmtCol + sep.length);
        return { prefix: ' '.repeat(stmtCol) + ',' + ' '.repeat(itemCol - stmtCol - 1), itemCol };
    }
    const commaCol = Math.max(0, listCol - sep.length);
    return { prefix: ' '.repeat(commaCol) + sep, itemCol: commaCol + sep.length };
}

/** Sposta una riga di `delta` colonne (rimuove solo spazi iniziali se negativo). */
function shiftLine(line: string, delta: number): string {
    if (delta > 0) return line.trim() ? ' '.repeat(delta) + line : line;
    if (delta < 0) {
        const lead = line.length - line.trimStart().length;
        return line.slice(Math.min(lead, -delta));
    }
    return line;
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
    layout: CommaLayout,
): string[] {
    const stmtCol = kwPrefix.length - kwPrefix.trimStart().length;
    const { prefix: commaPrefix, itemCol } = leadingCommaPrefix(stmtCol, kwWidth, layout);
    const delta = itemCol - kwWidth;

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
            // Le righe di continuazione seguono lo spostamento dell'elemento
            const [head, ...rest] = (exprPart + commentPart).split('\n');
            formatted.push([commaPrefix + head, ...rest.map(l => shiftLine(l, delta))].join('\n'));
        }
    }
    return formatted;
}

// ── Liste con keyword su riga propria (indentazione standard) ───────────────
//
// Senza tabularLeft sql-formatter produce:
//     SELECT
//         foo,
//         min(bat)
// Qui la lista diventa a virgola iniziale. Un nuovo elemento inizia solo dopo
// una virgola separatrice (fuori da parentesi, stringhe e commenti); le righe
// più indentate o non precedute da virgola (CASE, subquery, OVER) restano
// continuazione dell'elemento.

// Keyword che aprono una lista quando stanno da sole sulla riga.
const STANDALONE_LIST_KW_RE =
    /^([ ]*)(?:SELECT(?:[ \t]+(?:DISTINCT|ALL))?|GROUP[ \t]+BY|ORDER[ \t]+BY|PARTITION[ \t]+BY|SET|VALUES)[ \t]*$/i;

interface StandaloneListOptions {
    layout: CommaLayout;
    alignComments: boolean;
    alignAliases: boolean;
}

/** Esito della scansione di una riga T-SQL. */
interface LineScan {
    /** Variazione netta delle parentesi (fuori da stringhe e commenti). */
    depth: number;
    /** Indice dell'ultimo carattere di codice, -1 se la riga non ne ha. */
    lastCode: number;
    /** Inizio del commento `--`, -1 se assente. */
    commentStart: number;
    /** Stringa, identificatore o commento a blocco aperti a fine riga. */
    unterminated: boolean;
}

function scanLine(line: string): LineScan {
    let depth = 0;
    let lastCode = -1;
    let i = 0;
    const open = (): LineScan => ({ depth, lastCode, commentStart: -1, unterminated: true });
    while (i < line.length) {
        const ch = line[i];
        if (ch === '-' && line[i + 1] === '-') {
            return { depth, lastCode, commentStart: i, unterminated: false };
        }
        if (ch === '/' && line[i + 1] === '*') {
            const end = line.indexOf('*/', i + 2);
            if (end === -1) return open();
            i = end + 2;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '[') {
            const close = ch === '[' ? ']' : ch;
            let j = i + 1;
            for (;;) {
                if (j >= line.length) return open();
                if (line[j] === close) {
                    if (line[j + 1] === close) { j += 2; continue; } // carattere raddoppiato = escape
                    break;
                }
                j++;
            }
            lastCode = j;
            i = j + 1;
            continue;
        }
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        if (!/\s/.test(ch)) lastCode = i;
        i++;
    }
    return { depth, lastCode, commentStart: -1, unterminated: false };
}

function indentOf(line: string): number {
    return line.length - line.trimStart().length;
}

/** Elemento di una lista con keyword su riga propria. */
interface StandaloneItem {
    /** Commenti su righe proprie che precedono l'elemento. */
    leading: string[];
    /** Righe dell'elemento (la prima a colonna listCol), senza virgola separatrice. */
    lines: string[];
}

/** Rimuove il carattere in `idx` (la virgola) ricucendo gli spazi attorno. */
function removeCharAt(line: string, idx: number): string {
    const before = line.slice(0, idx).trimEnd();
    const after = line.slice(idx + 1).trim();
    return after ? `${before} ${after}` : before;
}

/** Applica formatStandaloneList a tutte le liste contenute in `lines`. */
function formatNestedStandaloneLists(lines: string[], opts: StandaloneListOptions): string[] {
    const out: string[] = [];
    let j = 0;
    while (j < lines.length) {
        const r = formatStandaloneList(lines, j, opts);
        if (r) {
            out.push(...r.lines);
            j = r.nextIndex;
        } else {
            out.push(lines[j]);
            j++;
        }
    }
    return out;
}

/**
 * Se `lines[start]` è una keyword di lista da sola sulla riga, riscrive la
 * lista che segue a virgola iniziale. Restituisce null se non è una lista o se
 * la struttura non è sicura (stringhe/commenti su più righe, virgole orfane):
 * in quel caso il testo resta invariato.
 */
function formatStandaloneList(
    lines: string[],
    start: number,
    opts: StandaloneListOptions,
): { lines: string[]; nextIndex: number } | null {
    const kwMatch = lines[start].match(STANDALONE_LIST_KW_RE);
    if (!kwMatch) return null;
    const stmtCol = kwMatch[1].length;
    const firstLine = lines[start + 1];
    if (firstLine === undefined || !firstLine.trim() || /^[ ]*\t/.test(firstLine)) return null;
    const listCol = indentOf(firstLine);
    if (listCol <= stmtCol) return null;

    const items: StandaloneItem[] = [];
    let pending: string[] = [];
    let current: StandaloneItem | undefined;
    let depth = 0;
    let ended = true; // true = il prossimo elemento può iniziare (dopo una virgola)
    let i = start + 1;
    for (; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) break;
        // Virgola su riga propria: sql-formatter la mette dopo un elemento con commento
        if (STANDALONE_COMMA_RE.test(line)) {
            if (!current || ended || depth !== 0) return null;
            ended = true;
            continue;
        }
        if (indentOf(line) < listCol) break;
        const scan = scanLine(line);
        if (scan.unterminated) return null;
        if (ended) {
            if (scan.lastCode === -1) {
                pending.push(line); // commento su riga propria prima dell'elemento
                continue;
            }
            if (indentOf(line) !== listCol) return null;
            current = { leading: pending, lines: [line] };
            pending = [];
            items.push(current);
            ended = false;
            depth = 0;
        } else {
            current!.lines.push(line);
        }
        depth += scan.depth;
        if (depth < 0) return null;
        if (depth === 0 && scan.lastCode >= 0 && line[scan.lastCode] === ',') {
            current!.lines[current!.lines.length - 1] = removeCharAt(line, scan.lastCode);
            ended = true;
        }
    }
    // Lista vuota, parentesi non chiuse o virgola finale senza elemento: non tocca
    if (!current || ended || depth !== 0 || pending.length > 0) return null;

    const { prefix, itemCol } = leadingCommaPrefix(stmtCol, listCol, opts.layout);
    const delta = itemCol - listCol;

    // Allineamento di alias e commenti sugli elementi su una sola riga
    const heads = items.map(item => {
        const text = item.lines[0].slice(listCol);
        if (item.lines.length > 1) return { text, single: false, base: '', alias: '', comment: '' };
        const scan = scanLine(text);
        const code = scan.commentStart >= 0 ? text.slice(0, scan.commentStart).trimEnd() : text;
        const comment = scan.commentStart >= 0 ? text.slice(scan.commentStart) : '';
        let [base, alias] = opts.alignAliases ? splitAlias(code) : [code, ''];
        if (alias && computeNetParens(base) !== 0) [base, alias] = [code, ''];
        return { text, single: true, base, alias, comment };
    });
    const maxBase = Math.max(0, ...heads.filter(h => h.single && h.alias).map(h => h.base.length));
    const codeOf = (h: typeof heads[number]): string =>
        h.alias ? `${h.base.padEnd(maxBase)} ${h.alias}` : h.base;
    const maxCode = Math.max(0, ...heads.filter(h => h.single && h.comment).map(h => codeOf(h).length));

    const out = [lines[start]];
    items.forEach((item, idx) => {
        const h = heads[idx];
        let head = h.text;
        if (h.single && (opts.alignAliases || opts.alignComments)) {
            const code = codeOf(h);
            head = h.comment
                ? `${opts.alignComments ? code.padEnd(maxCode) : code} ${h.comment}`
                : code;
        }
        const body = formatNestedStandaloneLists([' '.repeat(listCol) + head, ...item.lines.slice(1)], opts);
        if (idx === 0) {
            out.push(...item.leading, ...body);
        } else {
            out.push(
                ...item.leading.map(l => shiftLine(l, delta)),
                prefix + body[0].slice(listCol),
                ...body.slice(1).map(l => shiftLine(l, delta)),
            );
        }
    });
    return { lines: out, nextIndex: i };
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
    const layout = readCommaLayout(style);
    const standaloneOpts: StandaloneListOptions = { layout, alignComments, alignAliases };
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
                            result.push(...formatItems(kwPrefix, kwWidthBase, items, alignComments, alignAliases, layout));
                        } else {
                            result.push(oneLine);
                        }
                    } else {
                        // 'never': pack items greedily onto lines ≤ maxLineLen.
                        if (!isFinite(maxLineLen) || oneLine.length <= maxLineLen) {
                            result.push(oneLine);
                        } else {
                            const stmtCol = kwPrefix.length - kwPrefix.trimStart().length;
                            const { prefix: commaPrefix } = leadingCommaPrefix(stmtCol, kwWidthBase, layout);
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
                                        currentLine = commaPrefix + expr;
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

        // Layout standard: keyword da sola sulla riga, elementi indentati sotto
        const standalone = formatStandaloneList(lines, i, standaloneOpts);
        if (standalone) {
            result.push(...standalone.lines);
            i = standalone.nextIndex;
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

        result.push(...formatItems(kwPrefix, effectiveKwWidth, items, alignComments, alignAliases, layout));
    }

    return result.join('\n');
}

