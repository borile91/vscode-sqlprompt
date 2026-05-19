/**
 * Generates a short alias from a table name.
 *
 * Examples:
 *   PRESTITI_DETTAGLIO → "od"
 *   ClientiAttivi    → "ca"
 *   LIBRI         → "a"
 *   Orders           → "o"
 */
export function generateAlias(tableName: string, existingAliases?: Set<string>): string {
  let alias: string;

  if (tableName.includes('_')) {
    alias = tableName
      .split('_')
      .map((part) => part.charAt(0).toLowerCase())
      .join('');
  } else {
    // Only use multi-char alias when there's a genuine CamelCase pattern
    // (mixed case like "OrderDetails"), NOT when the name is entirely uppercase.
    const isAllUpperOrAllLower =
      tableName === tableName.toUpperCase() || tableName === tableName.toLowerCase();

    if (!isAllUpperOrAllLower) {
      const upperLetters = tableName.match(/[A-Z]/g);
      if (upperLetters && upperLetters.length > 1) {
        alias = upperLetters.map((l) => l.toLowerCase()).join('');
      } else {
        alias = tableName.charAt(0).toLowerCase();
      }
    } else {
      alias = tableName.charAt(0).toLowerCase();
    }
  }

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
