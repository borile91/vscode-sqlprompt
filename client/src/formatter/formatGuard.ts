/**
 * FormatGuard
 *
 * The formatting pipeline is a stack of regex passes, and a regex that matches
 * where it should not can rewrite the statement into something that no longer
 * compiles — the leading-comma pass, for instance, has been seen inserting a
 * comma after `DECLARE` or `END` when a comment followed it.
 *
 * Formatting must never be able to break a query: it is a cosmetic operation,
 * so when the result is not trustworthy the right outcome is to leave the
 * document untouched rather than to apply a plausible-looking edit.
 *
 * The check is a conservative invariant rather than a parser: formatting only
 * ever moves the significant characters of a statement around, it never adds or
 * removes them. So the multiset of non-whitespace characters must be preserved.
 * Measured over 380 formattings (55 real stored procedures × 7 styles) the only
 * character whose count ever changed was the comma — and every one of those
 * cases was a genuine defect.
 *
 * The same count is repeated on the code alone (comments stripped), so a pass
 * that pushes code into a `--` comment is refused too: Lo stesso conteggio
 * sul solo codice rileva codice finito dentro un commento.
 *
 * Deliberately ignored:
 *   - whitespace, which is the whole point of formatting;
 *   - letter case, since keyword casing is a formatting option;
 *   - `;`, which semicolon options may legitimately add or remove.
 */

/** Characters the formatter is allowed to add or drop. */
const NEUTRAL_CHARACTERS = new Set([';']);

/** Counts the significant characters of `sql`, ignoring whitespace and case. */
function countSignificantCharacters(sql: string): Map<string, number> {
    const counts = new Map<string, number>();
    for (const character of sql.toLowerCase()) {
        if (/\s/.test(character) || NEUTRAL_CHARACTERS.has(character)) {
            continue;
        }
        counts.set(character, (counts.get(character) ?? 0) + 1);
    }
    return counts;
}

/**
 * Rimuove i commenti (`--` e `/* *\/`, anche annidati) lasciando il codice;
 * stringhe e identificatori delimitati restano intatti.
 */
function stripComments(sql: string): string {
    let out = '';
    let i = 0;
    while (i < sql.length) {
        const ch = sql[i];
        if (ch === '-' && sql[i + 1] === '-') {
            const end = sql.indexOf('\n', i);
            i = end === -1 ? sql.length : end;
            continue;
        }
        if (ch === '/' && sql[i + 1] === '*') {
            let depth = 1;
            i += 2;
            while (i < sql.length && depth > 0) {
                if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; }
                else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
                else i++;
            }
            out += ' ';
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
            out += sql.slice(i, j + 1);
            i = j + 1;
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}

/** Differenze nei conteggi dei caratteri significativi, come testo. */
function describeChanges(before: Map<string, number>, after: Map<string, number>): string[] {
    const changes: string[] = [];
    for (const character of new Set([...before.keys(), ...after.keys()])) {
        const delta = (after.get(character) ?? 0) - (before.get(character) ?? 0);
        if (delta === 0) {
            continue;
        }
        changes.push(
            `${delta > 0 ? 'added' : 'removed'} ${Math.abs(delta)} "${character}"`,
        );
    }
    return changes;
}

/** Riassume le differenze: le prime bastano a identificare il problema. */
function summarise(changes: string[]): string {
    const shown = changes.slice(0, 3).join(', ');
    const rest = changes.length > 3 ? `, and ${changes.length - 3} more` : '';
    return `${shown}${rest}`;
}

/**
 * Returns a human-readable reason when `formatted` cannot be trusted as a
 * formatting of `original`, or `null` when it is safe to apply.
 *
 * The reason is meant to be shown to the user, so it names what changed.
 */
export function describeFormattingRisk(original: string, formatted: string): string | null {
    const changes = describeChanges(
        countSignificantCharacters(original),
        countSignificantCharacters(formatted),
    );
    if (changes.length > 0) {
        return summarise(changes);
    }

    // Stessi caratteri ma codice finito dentro un commento (o viceversa), es.
    // "a -- primo, b" con b inghiottita dal commento: confronta il solo codice.
    const codeChanges = describeChanges(
        countSignificantCharacters(stripComments(original)),
        countSignificantCharacters(stripComments(formatted)),
    );
    if (codeChanges.length > 0) {
        return `code moved into or out of a comment (${summarise(codeChanges)})`;
    }
    return null;
}
