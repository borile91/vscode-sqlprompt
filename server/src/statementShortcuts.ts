/**
 * Scorciatoie di statement in stile SQL Prompt (`ssf` → `SELECT * FROM `).
 *
 * Quelle predefinite si combinano con `sqlPrompt.snippets.shortcuts`
 * dell'utente: una chiave già presente la sostituisce, una stringa vuota la
 * disattiva. `st<N>` (es. `st25`) è sempre disponibile come `SELECT TOP N * FROM`.
 *
 * Tutto puro (nessuna dipendenza da LSP), per poterlo testare da solo.
 */

export const DEFAULT_SHORTCUTS: Readonly<Record<string, string>> = {
  ssf: 'SELECT * FROM ',
  scf: 'SELECT COUNT(*) FROM ',
  sct: 'SELECT COUNT(*) FROM ',
  st10: 'SELECT TOP 10 * FROM ',
  st100: 'SELECT TOP 100 * FROM ',
  ap: 'ALTER PROCEDURE ',
  av: 'ALTER VIEW ',
  af: 'ALTER FUNCTION ',
};

/** Segnaposto del cursore, come negli snippet di SQL Prompt. */
const CURSOR = '$CURSOR$';

/** `st<N>`: SELECT TOP N. */
const TOP_N = /^st(\d{1,6})$/i;

export interface Shortcut {
  /** Sigla da digitare, in minuscolo. */
  label: string;
  /** Testo inserito, così come scritto (con l'eventuale `$CURSOR$`). */
  text: string;
}

/**
 * Unisce le scorciatoie predefinite con quelle dell'utente. Le sigle sono
 * parole (`\w+`) senza distinzione di maiuscole; le voci non valide si scartano.
 */
export function resolveShortcuts(custom: unknown): Map<string, string> {
  const result = new Map(Object.entries(DEFAULT_SHORTCUTS));
  if (!custom || typeof custom !== 'object' || Array.isArray(custom)) return result;

  for (const [key, value] of Object.entries(custom as Record<string, unknown>)) {
    const label = key.trim().toLowerCase();
    if (!/^\w+$/.test(label) || typeof value !== 'string') continue;
    if (value === '') result.delete(label);
    else result.set(label, value);
  }
  return result;
}

/**
 * Scorciatoie da proporre mentre si digita `typed`: tutte quelle definite più,
 * se `typed` è `st<N>` e non è già definita, la sua forma con parametro.
 */
export function shortcutsFor(typed: string, shortcuts: ReadonlyMap<string, string>): Shortcut[] {
  const list: Shortcut[] = [...shortcuts].map(([label, text]) => ({ label, text }));
  const lower = typed.toLowerCase();
  const topN = TOP_N.exec(lower);
  if (topN && !shortcuts.has(lower)) {
    list.push({ label: lower, text: `SELECT TOP ${Number(topN[1])} * FROM ` });
  }
  return list;
}

/** Vero se, digitando ancora, `typed` può diventare un `st<N>` diverso. */
export function isTypingTopN(typed: string): boolean {
  return /^st\d*$/i.test(typed);
}

/**
 * Testo in formato snippet di VS Code: `$`, `}` e `\` letterali vanno protetti,
 * `$CURSOR$` diventa la posizione finale del cursore.
 */
export function toSnippetText(text: string): string {
  return text
    .split(CURSOR)
    .map((part) => part.replace(/[\\$}]/g, (ch) => `\\${ch}`))
    .join('$0');
}

/**
 * Dopo l'inserimento conviene riaprire i suggerimenti solo se il testo finisce
 * dove inizia un nome (`… FROM `) e il cursore resta in fondo.
 */
export function shouldRetrigger(text: string): boolean {
  return !text.includes(CURSOR) && /\s$/.test(text);
}
