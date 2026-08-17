/**
 * AliasRename
 *
 * Renaming a table alias by hand means touching every `alias.column` in the
 * query, and missing one produces a statement that no longer compiles.  This
 * module finds, from a cursor position, every occurrence of the alias inside
 * the current statement so the server can answer `textDocument/rename`.
 *
 * The analysis is purely token-based and needs no schema: an alias is defined
 * by the syntax of the statement, so rename also works with no connection.
 */

import { Token } from './types';
import { isReservedWord, tokenize } from './sqlLexer';
import { stripIdentifierDelimiters } from './utils';

/** An occurrence of the alias, as offsets relative to the statement text. */
export interface AliasOccurrence {
  start: number;
  end: number;
}

export interface AliasRenameTarget {
  /** Alias text as written, delimiters stripped. */
  alias: string;
  /** Definition plus every usage, in document order. */
  occurrences: AliasOccurrence[];
  /** Occurrence containing the cursor. */
  current: AliasOccurrence;
  /**
   * Aliases declared by the other table references of the same statement.
   * Renaming onto one of these would produce two identical correlation names.
   */
  otherAliases: string[];
}

/** Keywords that introduce a table reference which may carry an alias. */
const TABLE_INTRO_KEYWORDS = new Set([
  'FROM', 'JOIN', 'APPLY', 'UPDATE', 'INTO', 'MERGE', 'USING',
]);

/** Keywords that can never be an alias. */
const RESERVED_ALIASES = new Set([
  'ON', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'SET', 'AND', 'OR', 'NOT',
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER', 'APPLY',
  'UNION', 'INTERSECT', 'EXCEPT', 'SELECT', 'INSERT', 'UPDATE', 'DELETE',
  'WITH', 'PIVOT', 'UNPIVOT', 'FOR', 'OPTION', 'FROM', 'INTO', 'VALUES',
  'USING', 'MERGE', 'TOP', 'OUTPUT', 'WHEN', 'AS',
]);

/**
 * Statements whose target may be written as a bare alias:
 * `UPDATE o SET … FROM dbo.T AS o`, `DELETE o FROM dbo.T AS o`.
 */
const BARE_ALIAS_KEYWORDS = new Set(['UPDATE', 'DELETE', 'MERGE']);

/** Identifiers that can be written without brackets. */
const PLAIN_IDENTIFIER = /^[a-zA-Z_#@][a-zA-Z0-9_#@$]*$/;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the alias the cursor is on, together with every occurrence of it
 * within `statementText`, or `null` when the cursor is not on an alias.
 *
 * @param statementText Text of the statement under the cursor.
 * @param cursorOffset  Cursor offset relative to `statementText`.
 */
export function findAliasRenameTarget(
  statementText: string,
  cursorOffset: number,
): AliasRenameTarget | null {
  let tokens: Token[];
  try {
    tokens = tokenize(statementText);
  } catch {
    return null;
  }

  const sig = tokens.filter((t) => t.kind !== 'whitespace' && t.kind !== 'comment');
  const definitions = findAliasDefinitions(sig);
  if (definitions.size === 0) return null;

  const alias = aliasAtCursor(sig, definitions, cursorOffset);
  if (!alias) return null;

  const aliasLower = alias.toLowerCase();
  const occurrences: AliasOccurrence[] = [];

  for (let i = 0; i < sig.length; i++) {
    const token = sig[i];
    if (!isIdentifierToken(token)) continue;
    if (stripIdentifierDelimiters(token.text).toLowerCase() !== aliasLower) continue;
    if (isAliasReference(sig, i, definitions)) {
      occurrences.push({ start: token.start, end: token.end });
    }
  }

  const current = occurrences.find((o) => cursorOffset >= o.start && cursorOffset <= o.end);
  if (!current) return null;

  const otherAliases = [...definitions]
    .map((idx) => stripIdentifierDelimiters(sig[idx].text))
    .filter((a) => a.toLowerCase() !== aliasLower);

  return { alias, occurrences, current, otherAliases };
}

/**
 * True when `newName` is already the alias of another table reference in the
 * same statement.  Applying the rename would yield two identical correlation
 * names, which SQL Server rejects, so the request must be refused instead.
 */
export function collidesWithExistingAlias(
  target: AliasRenameTarget,
  newName: string,
): boolean {
  const bare = stripIdentifierDelimiters(newName).trim().toLowerCase();
  return target.otherAliases.some((a) => a.toLowerCase() === bare);
}

/**
 * Formats `newName` for insertion, adding brackets when it is not a plain
 * identifier.  Returns `null` when the name can never be a valid alias.
 *
 * Reserved words are refused rather than bracketed: `[of]` would parse, but the
 * user asking for `of` means the bare word, and silently delimiting it would
 * hide the problem instead of reporting it.
 */
export function formatAliasName(newName: string): string | null {
  const trimmed = stripIdentifierDelimiters(newName).trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes(']')) return null;
  // RESERVED_ALIASES covers the words this module needs while scanning a
  // statement; isReservedWord is the full T-SQL keyword set, which also rules
  // out short words like OF, IS, IN and TO that are legal nowhere as an alias.
  if (RESERVED_ALIASES.has(trimmed.toUpperCase())) return null;
  if (isReservedWord(trimmed)) return null;
  return PLAIN_IDENTIFIER.test(trimmed) ? trimmed : `[${trimmed}]`;
}

// ── Internals ─────────────────────────────────────────────────────────────────

function isIdentifierToken(token: Token): boolean {
  return token.kind === 'identifier' || token.kind === 'quotedIdentifier';
}

/**
 * Collects the token index of every alias declared by a table reference:
 * `FROM dbo.Orders o`, `JOIN dbo.Rows AS r`, `UPDATE dbo.T t`.
 */
function findAliasDefinitions(sig: Token[]): Set<number> {
  const definitions = new Set<number>();

  for (let i = 0; i < sig.length; i++) {
    const token = sig[i];
    // Reserved words such as USING may reach us as identifiers depending on
    // the lexer's keyword list, so the text is what matters here.
    if (token.kind !== 'keyword' && token.kind !== 'identifier') continue;
    if (!TABLE_INTRO_KEYWORDS.has(token.text.toUpperCase())) continue;

    // Skip the object chain: [db.][schema.]object
    let j = i + 1;
    let consumedName = false;
    while (j < sig.length) {
      const part = sig[j];
      // Non-reserved keywords are legal object names (dbo.Rows, dbo.Key, ...).
      if (!isIdentifierToken(part) && part.kind !== 'keyword') break;
      if (RESERVED_ALIASES.has(part.text.toUpperCase())) break;

      consumedName = true;
      j++;
      if (j < sig.length && sig[j].kind === 'dot') {
        j++;          // continue the chain
        consumedName = false;
        continue;
      }
      break;
    }
    if (!consumedName || j >= sig.length) continue;

    // Optional AS
    let aliasIdx = j;
    if (sig[aliasIdx].kind === 'keyword' && sig[aliasIdx].text.toUpperCase() === 'AS') {
      aliasIdx++;
    }
    if (aliasIdx >= sig.length) continue;

    const aliasTok = sig[aliasIdx];
    if (!isIdentifierToken(aliasTok)) continue;
    if (RESERVED_ALIASES.has(aliasTok.text.toUpperCase())) continue;

    definitions.add(aliasIdx);
  }

  return definitions;
}

/**
 * True when `sig[i]` uses the alias: either its definition, a qualifier before
 * a dot (`o.Id`), or the bare target of an UPDATE/DELETE/MERGE.
 */
function isAliasReference(sig: Token[], i: number, definitions: Set<number>): boolean {
  if (definitions.has(i)) return true;
  if (sig[i + 1]?.kind === 'dot') return true;

  const prev = sig[i - 1];
  return (
    prev !== undefined &&
    prev.kind === 'keyword' &&
    BARE_ALIAS_KEYWORDS.has(prev.text.toUpperCase())
  );
}

/** Alias name under the cursor, or null when the cursor is elsewhere. */
function aliasAtCursor(
  sig: Token[],
  definitions: Set<number>,
  cursorOffset: number,
): string | null {
  const declared = new Set(
    [...definitions].map((idx) => stripIdentifierDelimiters(sig[idx].text).toLowerCase()),
  );

  for (let i = 0; i < sig.length; i++) {
    const token = sig[i];
    if (cursorOffset < token.start || cursorOffset > token.end) continue;
    if (!isIdentifierToken(token)) return null;

    const text = stripIdentifierDelimiters(token.text);
    if (!declared.has(text.toLowerCase())) return null;
    return isAliasReference(sig, i, definitions) ? text : null;
  }

  return null;
}
