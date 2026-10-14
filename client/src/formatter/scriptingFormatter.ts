import type { SqlPromptStyleJson } from './styleLoader';

/**
 * Passaggi per gli stili "compatti" (`lists.placeSubsequentItemsOnNewLines: 'never'`)
 * e per `collapseShortStatements`: riportano su una riga ciò che sql-formatter
 * stende su più righe.
 *
 * Erano presenti solo nella copia della pipeline dentro i test degli esempi:
 * qui sono l'unica implementazione, usata da formatSqlText.
 */

/** Vero se lo stile usa il layout compatto (elementi delle liste mai a capo). */
export function isCompactListStyle(style: SqlPromptStyleJson): boolean {
    return style.lists?.placeSubsequentItemsOnNewLines === 'never';
}

/**
 * Vero se la riga contiene un commento `--` fuori da stringhe e identificatori
 * delimitati: unire la riga successiva in coda la renderebbe commento.
 */
export function hasLineComment(line: string): boolean {
    let closing: string | null = null;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (closing) {
            if (ch === closing) closing = null;
            continue;
        }
        if (ch === "'") closing = "'";
        else if (ch === '"') closing = '"';
        else if (ch === '[') closing = ']';
        else if (ch === '-' && line[i + 1] === '-') return true;
    }
    return false;
}

/** Vero se una delle righe, tranne l'ultima, ha un commento di riga. */
function commentBeforeLast(lines: string[]): boolean {
    return lines.slice(0, -1).some(hasLineComment);
}

/** Riga di continuazione di una clausola, senza l'eventuale virgola finale. */
interface ClauseLine {
    text: string;
    endsWithComma: boolean;
}

/**
 * Separatore tra due righe di una clausola: la virgola solo se la riga
 * precedente la aveva (elemento di lista). Le altre righe sono la stessa
 * espressione spezzata (AND/OR, parentesi, subquery): si uniscono con uno
 * spazio, senza spazio subito dopo "(" o prima di ")".
 */
function clauseSeparator(previous: ClauseLine, next: ClauseLine): string {
    if (previous.endsWithComma) return ', ';
    if (previous.text.endsWith('(') || next.text.startsWith(')')) return '';
    return ' ';
}

function joinClauseLines(items: ClauseLine[], from: number, to: number): string {
    let joined = items[from].text;
    for (let k = from + 1; k < to; k++) {
        joined += clauseSeparator(items[k - 1], items[k]) + items[k].text;
    }
    return joined;
}

/**
 * A capo greedy: la prima riga parte da firstPrefix, le altre da contIndent;
 * si va a capo solo tra due righe originali e la virgola resta a fine riga.
 */
function wrapClauseLines(items: ClauseLine[], firstPrefix: string, contIndent: string, maxLen: number): string[] {
    const out: string[] = [];
    let cur = firstPrefix + items[0].text;
    for (let k = 1; k < items.length; k++) {
        const sep = clauseSeparator(items[k - 1], items[k]);
        if (cur.length + sep.length + items[k].text.length <= maxLen) {
            cur += sep + items[k].text;
        } else {
            out.push(cur + (items[k - 1].endsWithComma ? ',' : ''));
            cur = contIndent + items[k].text;
        }
    }
    out.push(cur);
    return out;
}

/**
 * SELECT/FROM/WHERE/ORDER BY con i loro elementi sulla stessa riga della
 * keyword; GROUP BY/HAVING con keyword sola e gli elementi impacchettati sotto.
 * Va eseguito prima di applyJoinOnFormatting, così FROM e tabella sono sulla
 * stessa riga e l'indentazione dei JOIN viene dedotta correttamente.
 */
export function inlineClauseItems(sql: string, style: SqlPromptStyleJson, tabWidth: number): string {
    if (!isCompactListStyle(style)) return sql;
    const maxLen = style.whitespace?.wrapLinesLongerThan ?? 9999;
    const INLINE_CLAUSE = /^([ \t]*)(SELECT|FROM|WHERE|ORDER\s+BY)(\s*)$/i;
    const PACK_CLAUSE = /^([ \t]*)(GROUP\s+BY|HAVING)(\s*)$/i;
    const JOIN_RE = /^[ \t]*(?:(?:INNER|LEFT|RIGHT|FULL|CROSS)\s+(?:OUTER\s+)?JOIN|OUTER\s+APPLY|CROSS\s+APPLY|JOIN)\b/i;
    const lines = sql.split('\n');
    const out: string[] = [];
    let i = 0;
    // Profondità di parentesi (conteggio grezzo): dentro le subquery non si unisce.
    let parenDepth = 0;
    while (i < lines.length) {
        const line = lines[i];
        const lineParens = (line.match(/\(/g)?.length ?? 0) - (line.match(/\)/g)?.length ?? 0);
        const im = parenDepth === 0 ? line.match(INLINE_CLAUSE) : null;
        const pm = !im && parenDepth === 0 ? line.match(PACK_CLAUSE) : null;
        if (im || pm) {
            const kwIndent = (im || pm)![1];
            const kw = (im || pm)![2].replace(/\s+/g, ' ');
            const contIndent = kwIndent + ' '.repeat(tabWidth);
            // Righe di continuazione: elementi indentati di un tab rispetto alla keyword.
            const start = i;
            const items: ClauseLine[] = [];
            i++;
            while (i < lines.length) {
                const cl = lines[i];
                if (!cl.startsWith(contIndent)) break;
                const rest = cl.slice(contIndent.length);
                if (!rest.trim()) break;
                if (JOIN_RE.test(cl)) break;
                const text = rest.trim();
                items.push({ text: text.replace(/,\s*$/, ''), endsWithComma: /,\s*$/.test(text) });
                i++;
            }
            // Un commento di riga inglobato nella riga unita commenterebbe il codice che segue.
            if (items.length === 0 || commentBeforeLast(items.map(item => item.text))) {
                out.push(...lines.slice(start, i));
                continue;
            }
            if (im) {
                const prefix = kwIndent + kw + ' ';
                const oneLine = prefix + joinClauseLines(items, 0, items.length);
                if (oneLine.length <= maxLen) {
                    out.push(oneLine);
                } else {
                    out.push(...wrapClauseLines(items, prefix, contIndent, maxLen));
                }
            } else {
                out.push(kwIndent + kw);
                out.push(...wrapClauseLines(items, contIndent, contIndent, maxLen));
            }
            continue;
        }
        out.push(line);
        parenDepth += lineParens;
        i++;
    }
    return out.join('\n');
}

/**
 * Con `controlFlow.collapseShortStatements` riporta IF/WHILE e il loro corpo
 * su una riga quando la riga risultante è più corta di
 * `controlFlow.collapseStatementsShorterThan`.
 */
export function collapseShortControlFlow(sql: string, style: SqlPromptStyleJson, tabWidth: number): string {
    if (!style.controlFlow?.collapseShortStatements) return sql;
    const maxCollapse = style.controlFlow?.collapseStatementsShorterThan ?? Infinity;
    return sql.replace(
        /^([ \t]*)(IF|WHILE)(\b[^\n]*)\n([ \t]+)(\S[^;\n]*;)$/gim,
        (match, indent, kw, condition, bodyIndent, body) => {
            if (bodyIndent.length !== indent.length + tabWidth || hasLineComment(condition)) return match;
            const combined = indent + kw + condition + ' ' + body;
            return combined.length < maxCollapse ? combined : match;
        },
    );
}

/**
 * Stili compatti: impacchetta i parametri nominali di EXEC/EXECUTE (che
 * sql-formatter mette uno per riga a colonna 0) entro wrapLinesLongerThan.
 */
export function packExecParameters(sql: string, style: SqlPromptStyleJson, tabWidth: number): string {
    if (!isCompactListStyle(style) || !style.whitespace?.wrapLinesLongerThan) return sql;
    const maxLen = style.whitespace.wrapLinesLongerThan;
    const EXEC_FIRST_RE = /^([ \t]*EXEC(?:UTE)?\s+\S+)([ \t]+@\S+[^,\n]*,)\s*$/i;
    const EXEC_CONT_RE = /^(@\S[^\n]*?)([,;])\s*$/;
    const lines = sql.split('\n');
    const result: string[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const execM = line.match(EXEC_FIRST_RE);
        if (!execM) { result.push(line); i++; continue; }
        const indent = line.match(/^([ \t]*)/)![1];
        const start = i;
        const params: string[] = [execM[2].trim().replace(/,\s*$/, '')];
        i++;
        let terminator = ',';
        while (i < lines.length) {
            const cm = lines[i].trim().match(EXEC_CONT_RE);
            if (!cm) break;
            params.push(cm[1]);
            terminator = cm[2];
            i++;
            if (cm[2] === ';') break;
        }
        if (commentBeforeLast([execM[1], ...params])) {
            result.push(...lines.slice(start, i));
            continue;
        }
        const contPad = indent + ' '.repeat(tabWidth);
        let packed = execM[1] + ' ' + params[0];
        for (let p = 1; p < params.length; p++) {
            const candidate = packed + ', ' + params[p];
            if (candidate.length <= maxLen) {
                packed = candidate;
            } else {
                result.push(packed + ',');
                packed = contPad + params[p];
            }
        }
        result.push(packed + terminator);
    }
    return result.join('\n');
}

/**
 * Stili compatti: DECLARE impacchettati, INSERT/VALUES/UPDATE brevi su una
 * riga, IF [NOT] EXISTS brevi in linea, condizione IF con un solo AND/OR unita.
 */
export function applyCompactStatementCollapses(sql: string, style: SqlPromptStyleJson, tabWidth: number): string {
    if (!isCompactListStyle(style)) return sql;
    let formatted = sql;
    const maxLen = style.whitespace?.wrapLinesLongerThan ?? 9999;
    // Le soglie valgono solo se il relativo collapseShort* è attivo.
    const dmlMax = style.dml?.collapseShortStatements
        ? style.dml.collapseStatementsShorterThan ?? Infinity
        : Infinity;
    const subqueryMax = style.dml?.collapseShortSubqueries
        ? style.dml.collapseSubqueriesShorterThan ?? Infinity
        : Infinity;
    const cfMax = style.controlFlow?.collapseShortStatements
        ? style.controlFlow.collapseStatementsShorterThan ?? Infinity
        : Infinity;
    const commaFirst = style.lists?.placeCommasBeforeItems === true;

    // 1. DECLARE con più variabili (senza virgola iniziale): sql-formatter mette
    //    le variabili successive all'indentazione di DECLARE; si impacchettano
    //    entro maxLen con continuazione a indent + tabWidth.
    if (!commaFirst) {
        const lines = formatted.split('\n');
        const result: string[] = [];
        let i = 0;
        while (i < lines.length) {
            const line = lines[i];
            const dm = line.match(/^([ \t]*)(DECLARE\s+)(@\S+[^\n]*),\s*$/i);
            if (!dm) { result.push(line); i++; continue; }
            const declIndent = dm[1];
            const contIndent = declIndent + ' '.repeat(tabWidth);
            const start = i;
            const vars: string[] = [dm[3].trim()];
            let hasSemicolon = false;
            i++;
            while (i < lines.length) {
                const cl = lines[i].trimStart();
                if (!cl.startsWith('@')) break;
                hasSemicolon = cl.endsWith(';');
                vars.push(cl.replace(/[,;]\s*$/, '').trim());
                i++;
                if (hasSemicolon) break;
            }
            if (vars.length <= 1 || commentBeforeLast(vars)) {
                result.push(...lines.slice(start, i));
                continue;
            }
            let cur = declIndent + 'DECLARE ' + vars[0];
            for (let v = 1; v < vars.length; v++) {
                const cand = cur + ', ' + vars[v];
                if (cand.length > maxLen) { result.push(cur + ','); cur = contIndent + vars[v]; }
                else cur = cand;
            }
            result.push(cur + (hasSemicolon ? ';' : ''));
        }
        formatted = result.join('\n');
    }

    // 2. INSERT [INTO]\n    tabella → INSERT [INTO] tabella
    formatted = formatted.replace(
        /^([ \t]*INSERT(?:\s+INTO)?)\n([ \t]+)(\S[^\n]*)/gim,
        (_, kw, _ind, rest) => `${kw} ${rest.trim()}`,
    );

    // 3. VALUES\n    (...) → VALUES (...)
    formatted = formatted.replace(
        /^([ \t]*VALUES)\n[ \t]+(\S[^\n]*)/gim,
        (_, kw, rest) => `${kw} ${rest.trim()}`,
    );

    // 4. INSERT + VALUES brevi su una riga.
    if (isFinite(dmlMax) && !commaFirst) {
        formatted = formatted.replace(
            /^([ \t]*INSERT(?:\s+INTO)?[^\n]+)\n([ \t]*VALUES\s+\([^\n]*;)$/gim,
            (m, ins, vals) => {
                if (hasLineComment(ins)) return m;
                const one = ins + ' ' + vals.trimStart();
                return one.length < dmlMax ? one : m;
            },
        );
    }

    // 5. SET col = val,\n    col2 = val2 → una riga (assegnazioni di UPDATE).
    formatted = formatted.replace(
        /^([ \t]*SET\s+[^\n]+,)\n([ \t]+)(\S[^\n]*)$/gim,
        (m, setLine, _ind, rest) => {
            if (hasLineComment(setLine)) return m;
            const one = setLine + ' ' + rest.trim();
            return one.length <= maxLen ? one : m;
        },
    );

    // 6. UPDATE tabella\nSET ...\n[WHERE ...] brevi → una riga.
    if (isFinite(dmlMax) && !commaFirst) {
        formatted = formatted.replace(
            /^([ \t]*UPDATE\s+\S+)\n([ \t]*SET\s+[^\n]+)\n([ \t]*WHERE\s+[^\n]+;)$/gim,
            (m, upd, set, whr) => {
                if (hasLineComment(upd) || hasLineComment(set)) return m;
                const one = upd + ' ' + set.trimStart() + ' ' + whr.trimStart();
                return one.length < dmlMax ? one : m;
            },
        );
        formatted = formatted.replace(
            /^([ \t]*UPDATE\s+\S+)\n([ \t]*SET\s+[^\n]+;)$/gim,
            (m, upd, set) => {
                if (hasLineComment(upd)) return m;
                const one = upd + ' ' + set.trimStart();
                return one.length < dmlMax ? one : m;
            },
        );
    }

    // 7. IF [NOT] EXISTS con subquery semplice (SELECT/FROM/WHERE) in linea.
    if (!commaFirst && isFinite(subqueryMax)) {
        const lines = formatted.split('\n');
        const result: string[] = [];
        let i = 0;
        while (i < lines.length) {
            const line = lines[i];
            const em = line.match(/^([ \t]*)((?:ELSE\s+)?IF\s+(?:NOT\s+)?EXISTS\s*)\(\s*$/i);
            if (!em) { result.push(line); i++; continue; }
            const ifIndent = em[1];
            const ifPart = em[2].replace(/\s+/g, ' ').trimEnd();
            const bodyIndent = ifIndent + ' '.repeat(tabWidth * 2);
            const bodyLines: string[] = [];
            i++;
            let foundClose = false;
            while (i < lines.length) {
                const bl = lines[i];
                if (/^\s*$/.test(bl) && !foundClose) { i++; continue; }
                if (bl === ifIndent + ')') { foundClose = true; i++; break; }
                bodyLines.push(bl);
                i++;
            }
            if (!foundClose || bodyLines.some(hasLineComment)) {
                result.push(line, ...bodyLines);
                if (foundClose) result.push(ifIndent + ')');
                continue;
            }
            const parts: string[] = [];
            let b = 0;
            while (b < bodyLines.length) {
                const trimmed = bodyLines[b].trimStart();
                const km = trimmed.match(/^(SELECT|FROM|WHERE)\s*$/i);
                if (km) {
                    b++;
                    const items: string[] = [];
                    while (b < bodyLines.length && bodyLines[b].startsWith(bodyIndent)) {
                        items.push(bodyLines[b].trim());
                        b++;
                    }
                    parts.push(km[1].toUpperCase() + (items.length > 0 ? ' ' + items.join(' ') : ''));
                } else if (trimmed) { parts.push(trimmed); b++; }
                else b++;
            }
            const one = ifIndent + ifPart + ' (' + parts.join(' ') + ')';
            if (one.length <= maxLen) result.push(one);
            else result.push(line, ...bodyLines, ifIndent + ')');
        }
        formatted = result.join('\n');
    }

    // 8. Condizione IF su due righe (un solo AND/OR di continuazione) unita se ci sta.
    if (isFinite(cfMax) && !commaFirst) {
        formatted = formatted.replace(
            /^([ \t]*(?:ELSE\s+)?IF\b[^\n]+)\n([ \t]+(?:AND|OR)\b[^\n]+)$/gim,
            (m, ifLine, andLine) => {
                if (hasLineComment(ifLine)) return m;
                const one = ifLine + ' ' + andLine.trimStart();
                return one.length < cfMax ? one : m;
            },
        );
    }
    return formatted;
}
