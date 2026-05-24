/**
 * SqlFormatter
 *
 * Formats a T-SQL SELECT statement according to the supplied configuration.
 * Supports configurable keyword case, indentation size, and comma placement.
 */

import { tokenize } from './sqlLexer.js';
import type { TokenKind } from './types.js';

// ── Public API ────────────────────────────────────────────────────────────────

export interface FormatterConfig {
    /** Transform reserved word casing.  Default: 'upper'. */
    keywordCase: 'upper' | 'lower' | 'preserve';
    /** Number of spaces per indentation level.  Default: 4. */
    indentSize: number;
    /** Place commas after ('after') or before ('before') each list item.  Default: 'after'. */
    commaPosition: 'before' | 'after';
}

export const DEFAULT_CONFIG: FormatterConfig = {
    keywordCase: 'upper',
    indentSize: 4,
    commaPosition: 'after',
};

/**
 * Formats a single T-SQL statement.  Unrecognised / unsupported constructs are
 * passed through without modification.
 */
export function formatSql(sql: string, config: Partial<FormatterConfig> = {}): string {
    const cfg: FormatterConfig = { ...DEFAULT_CONFIG, ...config };
    const pad = ' '.repeat(cfg.indentSize);
    const toks = prepare(sql);
    const n = toks.length;
    let i = 0;
    const out: string[] = [];

    // ── helpers ───────────────────────────────────────────────────────────────

    /** Emit a list of expressions using the configured comma style. */
    function emitList(items: string[]): void {
        if (cfg.commaPosition === 'after') {
            for (let j = 0; j < items.length; j++) {
                out.push(pad + items[j] + (j < items.length - 1 ? ',' : '') + '\n');
            }
        } else {
            // leading commas
            for (let j = 0; j < items.length; j++) {
                out.push(pad + (j === 0 ? '' : ', ') + items[j] + '\n');
            }
        }
    }

    /** Collect comma-separated expressions until the next clause boundary. */
    function collectList(): string[] {
        const items: string[] = [];
        while (i < n) {
            const [expr, ni] = collectExpr(toks, i, cfg);
            if (expr) items.push(expr);
            i = ni;
            if (i < n && toks[i].kind === 'comma') {
                i++; // skip comma separator
            } else {
                break;
            }
        }
        return items;
    }

    // ── main loop ─────────────────────────────────────────────────────────────

    while (i < n) {
        const tok = toks[i];
        if (tok.kind !== 'keyword' && tok.kind !== 'mergedKeyword') { i++; continue; }

        const u = tok.upper;
        const rt = renderToken(tok, cfg);

        // SELECT
        if (u === 'SELECT') {
            out.push(rt + '\n');
            i++;
            emitList(collectList());
            continue;
        }

        // FROM  (standalone — no JOIN)
        if (u === 'FROM') {
            out.push(rt + ' ');
            i++;
            const [expr, ni] = collectExpr(toks, i, cfg);
            out.push(expr + '\n');
            i = ni;
            continue;
        }

        // JOIN variants
        if (JOIN_TYPES.has(u)) {
            out.push(rt + ' ');
            i++;
            // Table expression stops at ON
            const [table, ni] = collectExpr(toks, i, cfg, new Set(['ON']));
            out.push(table + '\n');
            i = ni;
            // ON condition
            if (i < n && toks[i].upper === 'ON') {
                out.push(pad + renderToken(toks[i], cfg) + ' ');
                i++;
                const [cond, ni2] = collectExpr(toks, i, cfg);
                out.push(cond + '\n');
                i = ni2;
            }
            continue;
        }

        // WHERE / HAVING
        if (u === 'WHERE' || u === 'HAVING') {
            out.push(rt + '\n');
            i++;
            // First condition (stop at AND / OR)
            const [first, ni] = collectExpr(toks, i, cfg, new Set(), true);
            out.push(pad + first + '\n');
            i = ni;
            // Subsequent AND / OR conditions
            while (i < n && (toks[i].upper === 'AND' || toks[i].upper === 'OR')) {
                const conn = renderToken(toks[i], cfg);
                i++;
                const [cond, ni2] = collectExpr(toks, i, cfg, new Set(), true);
                out.push(pad + conn + ' ' + cond + '\n');
                i = ni2;
            }
            continue;
        }

        // GROUP BY / ORDER BY
        if (u === 'GROUP BY' || u === 'ORDER BY') {
            out.push(rt + '\n');
            i++;
            emitList(collectList());
            continue;
        }

        // UNION / UNION ALL / INTERSECT / EXCEPT — blank line around set operators
        if (['UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT'].includes(u)) {
            out.push('\n' + rt + '\n');
            i++;
            continue;
        }

        // Generic clause keyword — just emit it
        out.push(rt + '\n');
        i++;
    }

    return out.join('').trimEnd();
}

// ── Internal token type ───────────────────────────────────────────────────────

type FmtKind = TokenKind | 'mergedKeyword';

interface FmtToken {
    kind: FmtKind;
    text: string;   // original text from source
    upper: string;  // uppercase representation (used for comparisons and upper mode)
}

// ── Clause-start keyword sets ─────────────────────────────────────────────────

const CLAUSE_STARTERS = new Set([
    'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING',
    'JOIN', 'INNER JOIN', 'LEFT JOIN', 'LEFT OUTER JOIN',
    'RIGHT JOIN', 'RIGHT OUTER JOIN', 'FULL JOIN', 'FULL OUTER JOIN', 'CROSS JOIN',
    'ON', 'UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT',
    'INSERT INTO', 'INSERT', 'UPDATE', 'SET', 'DELETE FROM', 'DELETE', 'WITH',
]);

const JOIN_TYPES = new Set([
    'JOIN', 'INNER JOIN', 'LEFT JOIN', 'LEFT OUTER JOIN',
    'RIGHT JOIN', 'RIGHT OUTER JOIN', 'FULL JOIN', 'FULL OUTER JOIN', 'CROSS JOIN',
]);

// ── prepare ───────────────────────────────────────────────────────────────────

/**
 * Tokenises the SQL, removes whitespace / comments, and merges multi-word
 * keyword sequences (GROUP BY, INNER JOIN, …) into single FmtTokens.
 */
function prepare(sql: string): FmtToken[] {
    const raw = tokenize(sql).filter(t => t.kind !== 'whitespace' && t.kind !== 'comment');
    const result: FmtToken[] = [];
    let i = 0;

    while (i < raw.length) {
        const tok = raw[i];
        const u = tok.text.toUpperCase();

        if (tok.kind === 'keyword') {
            const n1 = raw[i + 1];
            const n2 = raw[i + 2];
            const u1 = n1?.kind === 'keyword' ? n1.text.toUpperCase() : '';
            const u2 = n2?.kind === 'keyword' ? n2.text.toUpperCase() : '';

            // 3-word merges: LEFT/RIGHT/FULL OUTER JOIN
            if (u1 === 'OUTER' && u2 === 'JOIN' &&
                (u === 'LEFT' || u === 'RIGHT' || u === 'FULL')) {
                result.push({ kind: 'mergedKeyword', text: `${tok.text} ${n1!.text} ${n2!.text}`, upper: `${u} OUTER JOIN` });
                i += 3; continue;
            }

            // 2-word merges
            if ((u === 'INNER' || u === 'LEFT' || u === 'RIGHT' || u === 'FULL' || u === 'CROSS') && u1 === 'JOIN') {
                result.push({ kind: 'mergedKeyword', text: `${tok.text} ${n1!.text}`, upper: `${u} JOIN` });
                i += 2; continue;
            }
            if ((u === 'GROUP' || u === 'ORDER') && u1 === 'BY') {
                result.push({ kind: 'mergedKeyword', text: `${tok.text} ${n1!.text}`, upper: `${u} BY` });
                i += 2; continue;
            }
            if (u === 'INSERT' && u1 === 'INTO') {
                result.push({ kind: 'mergedKeyword', text: `${tok.text} ${n1!.text}`, upper: 'INSERT INTO' });
                i += 2; continue;
            }
            if (u === 'DELETE' && u1 === 'FROM') {
                result.push({ kind: 'mergedKeyword', text: `${tok.text} ${n1!.text}`, upper: 'DELETE FROM' });
                i += 2; continue;
            }
            if (u === 'UNION' && u1 === 'ALL') {
                result.push({ kind: 'mergedKeyword', text: `${tok.text} ${n1!.text}`, upper: 'UNION ALL' });
                i += 2; continue;
            }
        }

        result.push({ kind: tok.kind as FmtKind, text: tok.text, upper: u });
        i++;
    }

    return result;
}

// ── collectExpr ───────────────────────────────────────────────────────────────

/**
 * Collects tokens that form a single expression, stopping before:
 *  - a comma or semicolon at depth 0
 *  - a clause-starter keyword at depth 0
 *  - any keyword in `stopKws` at depth 0
 *  - AND / OR at depth 0 when `stopAtBoolOp` is true
 *
 * Returns the rendered expression string and the index of the first unconsumed token.
 */
function collectExpr(
    toks: FmtToken[],
    start: number,
    cfg: FormatterConfig,
    stopKws: Set<string> = new Set(),
    stopAtBoolOp = false,
): [string, number] {
    const parts: string[] = [];
    let prev: FmtToken | undefined;
    let depth = 0;
    let i = start;

    while (i < toks.length) {
        const tok = toks[i];

        if (tok.kind === 'lparen') { depth++; }
        else if (tok.kind === 'rparen') {
            if (depth === 0) break;
            depth--;
        }

        if (depth === 0) {
            if (tok.kind === 'comma' || tok.kind === 'semicolon') break;
            if (tok.kind === 'keyword' || tok.kind === 'mergedKeyword') {
                if (CLAUSE_STARTERS.has(tok.upper)) break;
                if (stopKws.has(tok.upper)) break;
                if (stopAtBoolOp && (tok.upper === 'AND' || tok.upper === 'OR')) break;
            }
        }

        if (prev && needsSpace(prev, tok)) parts.push(' ');
        parts.push(renderToken(tok, cfg));
        prev = tok;
        i++;
    }

    return [parts.join(''), i];
}

// ── renderToken ───────────────────────────────────────────────────────────────

function renderToken(tok: FmtToken, cfg: FormatterConfig): string {
    if (tok.kind === 'keyword' || tok.kind === 'mergedKeyword') {
        if (cfg.keywordCase === 'upper') return tok.upper;
        if (cfg.keywordCase === 'lower') return tok.upper.toLowerCase();
        return tok.text; // preserve original casing
    }
    return tok.text;
}

// ── needsSpace ────────────────────────────────────────────────────────────────

function needsSpace(prev: FmtToken, cur: FmtToken): boolean {
    if (prev.kind === 'dot') return false;
    if (cur.kind === 'dot') return false;
    if (cur.kind === 'rparen') return false;
    if (prev.kind === 'lparen') return false;
    if (cur.kind === 'comma' || cur.kind === 'semicolon') return false;
    // No space between an identifier / keyword and an immediately following '('
    if (cur.kind === 'lparen' &&
        (prev.kind === 'identifier' || prev.kind === 'keyword' ||
         prev.kind === 'quotedIdentifier' || prev.kind === 'mergedKeyword')) {
        return false;
    }
    return true;
}
