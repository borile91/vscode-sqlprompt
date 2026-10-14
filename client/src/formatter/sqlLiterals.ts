/**
 * Riconoscimento di stringhe letterali e commenti nel testo SQL, condiviso dal
 * guard (che verifica i letterali) e dal mascheramento usato dai passaggi a
 * regex (che non devono toccarne il contenuto).
 */

export type SqlRegionKind = 'string' | 'lineComment' | 'blockComment' | 'identifier';

export interface SqlRegion {
    kind: SqlRegionKind;
    /** Indice del primo carattere (l'apertura). */
    start: number;
    /** Indice successivo all'ultimo carattere (la chiusura, se presente). */
    end: number;
}

/**
 * Regioni di `sql` che non sono codice: stringhe '…' (anche N'…', con ''
 * come escape), commenti `--` e `/* *\/` (annidati), identificatori "…" e […].
 * Un'apertura senza chiusura arriva fino alla fine del testo.
 */
export function findSqlRegions(sql: string): SqlRegion[] {
    const regions: SqlRegion[] = [];
    let i = 0;
    while (i < sql.length) {
        const ch = sql[i];
        if (ch === '-' && sql[i + 1] === '-') {
            const newline = sql.indexOf('\n', i);
            const end = newline === -1 ? sql.length : newline;
            regions.push({ kind: 'lineComment', start: i, end });
            i = end;
            continue;
        }
        if (ch === '/' && sql[i + 1] === '*') {
            let depth = 1;
            let j = i + 2;
            while (j < sql.length && depth > 0) {
                if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; }
                else if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; }
                else j++;
            }
            regions.push({ kind: 'blockComment', start: i, end: j });
            i = j;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '[') {
            const close = ch === '[' ? ']' : ch;
            let j = i + 1;
            while (j < sql.length) {
                if (sql[j] === close) {
                    if (sql[j + 1] === close) { j += 2; continue; } // carattere raddoppiato = escape
                    break;
                }
                j++;
            }
            const end = Math.min(j + 1, sql.length);
            regions.push({ kind: ch === "'" ? 'string' : 'identifier', start: i, end });
            i = end;
            continue;
        }
        i++;
    }
    return regions;
}

/** Le stringhe letterali di `sql`, nell'ordine, apici compresi. */
export function extractStringLiterals(sql: string): string[] {
    return findSqlRegions(sql)
        .filter(region => region.kind === 'string')
        .map(region => sql.slice(region.start, region.end));
}

const MASK_OPEN = '';
const MASK_CLOSE = '';

/**
 * Esegue `pass` con le stringhe letterali e i commenti a blocco su più righe
 * sostituiti da un segnaposto su una riga, poi li ripristina: il passaggio
 * lavora per righe e non deve unire, spezzare o reindentare il loro contenuto.
 * I letterali su una riga restano visibili, così le lunghezze delle righe (e
 * quindi le soglie) non cambiano.
 * Se il passaggio perde o duplica un segnaposto il suo risultato viene
 * scartato e si restituisce il testo di partenza.
 */
export function withProtectedLiterals(sql: string, pass: (masked: string) => string): string {
    if (sql.includes(MASK_OPEN) || sql.includes(MASK_CLOSE)) {
        // Testo che contiene già i caratteri del segnaposto: niente mascheramento possibile.
        return sql;
    }
    const saved: string[] = [];
    let masked = '';
    let last = 0;
    for (const region of findSqlRegions(sql)) {
        if (region.kind !== 'string' && region.kind !== 'blockComment') continue;
        const text = sql.slice(region.start, region.end);
        if (!text.includes('\n')) continue;
        masked += sql.slice(last, region.start) + MASK_OPEN + saved.length + MASK_CLOSE;
        saved.push(text);
        last = region.end;
    }
    if (saved.length === 0) return pass(sql);
    masked += sql.slice(last);

    const result = pass(masked);
    const placeholder = new RegExp(`${MASK_OPEN}(\\d+)${MASK_CLOSE}`, 'g');
    const seen = new Array<number>(saved.length).fill(0);
    const restored = result.replace(placeholder, (_m, index: string) => {
        const n = Number(index);
        if (n < saved.length) seen[n]++;
        return saved[n] ?? '';
    });
    return seen.every(count => count === 1) ? restored : sql;
}
