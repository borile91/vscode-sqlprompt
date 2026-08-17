import { isReservedWord } from './sqlLexer';

/**
 * Generates a short alias from a table name.
 *
 * Examples:
 *   ORDINI_DETTAGLIO → "od"
 *   ClientiAttivi    → "ca"
 *   ARTICOLI         → "a"
 *   Orders           → "o"
 */
export function generateAlias(tableName: string, existingAliases?: Set<string>): string {
  let alias: string;
  /**
   * Index in `tableName` of the last character the alias was built from, so a
   * reserved alias can be extended with what follows it in the name.
   */
  let lastSourceIndex = 0;

  if (tableName.includes('_')) {
    const parts = tableName.split('_');
    alias = parts.map((part) => part.charAt(0).toLowerCase()).join('');
    // Start of the last non-empty part: its first character is the last initial.
    let offset = 0;
    for (const part of parts) {
      if (part.length > 0) lastSourceIndex = offset;
      offset += part.length + 1; // + the underscore
    }
  } else {
    // Only use multi-char alias when there's a genuine CamelCase pattern
    // (mixed case like "OrderDetails"), NOT when the name is entirely uppercase.
    const isAllUpperOrAllLower =
      tableName === tableName.toUpperCase() || tableName === tableName.toLowerCase();

    if (!isAllUpperOrAllLower) {
      const upperLetters = tableName.match(/[A-Z]/g);
      if (upperLetters && upperLetters.length > 1) {
        alias = upperLetters.map((l) => l.toLowerCase()).join('');
        lastSourceIndex = tableName.lastIndexOf(upperLetters[upperLetters.length - 1]);
      } else {
        alias = tableName.charAt(0).toLowerCase();
      }
    } else {
      alias = tableName.charAt(0).toLowerCase();
    }
  }

  alias = avoidReservedWord(alias, tableName, lastSourceIndex);

  // If existingAliases is provided and this alias is taken, append a counter
  if (existingAliases) {
    let counter = 2;
    const baseAlias = alias;
    while (existingAliases.has(alias)) {
      alias = baseAlias + counter;
      counter++;
    }
  }

  return alias;
}

/**
 * Keeps a generated alias out of the reserved words by extending it with the
 * characters that follow, in the table name, the last initial it was built from.
 *
 * `OrdiniFasi` would give `of`, which T-SQL rejects; the letter after `F` in the
 * name yields `ofa`. Same shape as SQL Prompt's own behaviour.
 *
 * @param alias           Alias built from the table name.
 * @param tableName       Name the alias came from.
 * @param lastSourceIndex Index in `tableName` of the last initial used.
 */
function avoidReservedWord(alias: string, tableName: string, lastSourceIndex: number): string {
  if (!isReservedWord(alias)) return alias;

  let extended = alias;
  for (let i = lastSourceIndex + 1; i < tableName.length; i++) {
    const next = tableName[i];
    if (!/[a-zA-Z0-9]/.test(next)) continue; // skip separators such as '_'
    extended += next.toLowerCase();
    if (!isReservedWord(extended)) return extended;
  }

  // The whole remainder of the name is still a reserved word (no real T-SQL
  // keyword behaves this way, but never hand back something that cannot parse).
  return `${extended}_`;
}

/**
 * Strips bracket or double-quote delimiters from an identifier.
 *
 * `[My Table]` → `"My Table"`
 * `"dbo"` → `"dbo"`
 */
export function stripIdentifierDelimiters(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
