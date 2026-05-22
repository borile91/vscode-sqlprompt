/**
 * ScopeBuilder
 *
 * Walks the token stream of a SQL statement and extracts the visible
 * table/view/CTE sources at the cursor position.
 *
 * Produces:
 *  - visibleSources — resolved table refs with alias + column names
 *  - visibleCtes    — names of CTEs defined in the WITH clause
 *  - visibleAliases — shorthand alias list (subset of visibleSources)
 *
 * All analysis is token-based; no regex is used.
 */

import { Token, VisibleSource } from './types';
import { TableInfo } from './schemaLoader';
import { generateAlias, stripIdentifierDelimiters } from './utils';

export interface ScopeResult {
  visibleSources: VisibleSource[];
  visibleCtes: string[];
  visibleAliases: string[];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Builds the visible scope from the token stream of a single SQL statement.
 *
 * @param tokens      Full token array for the statement (including whitespace).
 * @param cursorOffset Cursor offset relative to the statement text.
 *                    Only tokens whose `end` is at or before this offset
 *                    are considered — this makes scope "live" as the user types.
 * @param tables      Schema snapshot from the server.
 */
export function buildScope(
  tokens: Token[],
  cursorOffset: number,
  tables: TableInfo[],
): ScopeResult {
  // Use the full token stream (minus whitespace/comments) so that table
  // references in FROM/JOIN clauses are visible even when the cursor is
  // earlier in the statement (e.g. typing in SELECT before FROM is written).
  const allSig = tokens.filter(
    (t) => t.kind !== 'whitespace' && t.kind !== 'comment',
  );

  // Calculate the paren depth of the cursor so we can scope table refs to the
  // correct nesting level.  Depth 0 = outer query; depth 1 = inside CTE body
  // or derived-table subquery; etc.
  let cursorDepth = 0;
  for (const t of tokens) {
    if (t.end > cursorOffset) break;
    if (t.kind === 'lparen') cursorDepth++;
    else if (t.kind === 'rparen') cursorDepth--;
  }
  if (cursorDepth < 0) cursorDepth = 0;

  const cteColumns = new Map<string, string[]>();
  const visibleCtes: string[] = [];
  extractCtes(allSig, visibleCtes, cteColumns);

  const visibleSources: VisibleSource[] = [];
  // Include sources from all depths 0..cursorDepth so that columns from outer
  // scopes (e.g. the outer FROM inside an OUTER APPLY subquery) remain visible.
  for (let d = 0; d <= cursorDepth; d++) {
    const depthAliases = new Set<string>();
    extractTableRefs(allSig, tables, visibleCtes, cteColumns, visibleSources, d, depthAliases);
  }

  const visibleAliases = visibleSources
    .filter((s) => s.alias !== undefined)
    .map((s) => s.alias!);

  return { visibleSources, visibleCtes, visibleAliases };
}

// ── CTE extraction ────────────────────────────────────────────────────────────

/**
 * Detects CTEs introduced by a top-level `WITH` clause and extracts their
 * projected column names from the CTE body's SELECT list.
 *
 * Grammar:  WITH  name  AS  (  ...  )  [,  name  AS  (  ...  )]...
 */
function extractCtes(
  sig: Token[],
  out: string[],
  cteColumns: Map<string, string[]>,
): void {
  for (let i = 0; i < sig.length; i++) {
    const tok = sig[i];
    if (tok.kind !== 'keyword' || tok.text.toUpperCase() !== 'WITH') continue;

    // Walk the CTE list: name AS ( ... ) [, name AS ( ... )] ...
    let j = i + 1;
    while (j < sig.length) {
      const nameTok = sig[j];
      if (
        nameTok === undefined ||
        (nameTok.kind !== 'identifier' && nameTok.kind !== 'quotedIdentifier')
      ) {
        break;
      }

      const asKw = sig[j + 1];
      const lp = sig[j + 2];
      if (
        asKw === undefined ||
        asKw.text.toUpperCase() !== 'AS' ||
        lp === undefined ||
        lp.kind !== 'lparen'
      ) {
        break;
      }

      const cteName = stripIdentifierDelimiters(nameTok.text);
      out.push(cteName);

      // Collect body tokens (inside the outer parens)
      j += 3; // past: name, AS, (
      let depth = 1;
      const bodyTokens: Token[] = [];
      while (j < sig.length && depth > 0) {
        if (sig[j].kind === 'lparen') depth++;
        else if (sig[j].kind === 'rparen') depth--;
        if (depth > 0) bodyTokens.push(sig[j]);
        j++;
      }

      cteColumns.set(cteName.toLowerCase(), extractSelectColumns(bodyTokens));

      // Check for a comma that separates multiple CTEs
      if (j < sig.length && sig[j].kind === 'comma') {
        j++; // consume comma, continue to next CTE
      } else {
        break;
      }
    }
  }
}

/**
 * Extracts the projected column names from a SELECT body token list.
 * Handles: `expr AS alias`, `table.column`, bare `identifier`.
 * Skips wildcard `*` / `alias.*` entries.
 */
function extractSelectColumns(bodyTokens: Token[]): string[] {
  const columns: string[] = [];

  // Find the first SELECT keyword at depth 0 within the body.
  let selectIdx = -1;
  let depth = 0;
  for (let i = 0; i < bodyTokens.length; i++) {
    const t = bodyTokens[i];
    if (t.kind === 'lparen') { depth++; continue; }
    if (t.kind === 'rparen') { depth--; continue; }
    if (depth === 0 && t.kind === 'keyword' && t.text.toUpperCase() === 'SELECT') {
      selectIdx = i;
      break;
    }
  }
  if (selectIdx === -1) return columns;

  // Find the FROM keyword at depth 0 after SELECT.
  let fromIdx = bodyTokens.length;
  depth = 0;
  for (let i = selectIdx + 1; i < bodyTokens.length; i++) {
    const t = bodyTokens[i];
    if (t.kind === 'lparen') { depth++; continue; }
    if (t.kind === 'rparen') { depth--; continue; }
    if (depth === 0 && t.kind === 'keyword' && t.text.toUpperCase() === 'FROM') {
      fromIdx = i;
      break;
    }
  }

  // Split the SELECT list into comma-separated items at depth 0.
  const selectList = bodyTokens.slice(selectIdx + 1, fromIdx);
  const items: Token[][] = [];
  let currentItem: Token[] = [];
  depth = 0;
  for (const t of selectList) {
    if (t.kind === 'lparen') { depth++; currentItem.push(t); continue; }
    if (t.kind === 'rparen') { depth--; currentItem.push(t); continue; }
    if (depth === 0 && t.kind === 'comma') {
      items.push(currentItem);
      currentItem = [];
    } else {
      currentItem.push(t);
    }
  }
  if (currentItem.length > 0) items.push(currentItem);

  for (const item of items) {
    // item already has no whitespace/comments (allSig was pre-filtered)
    if (item.length === 0) continue;

    const lastTok = item[item.length - 1];

    // Skip wildcards: `*` or `alias.*`
    if (lastTok.kind === 'star') continue;

    const prevTok = item.length >= 2 ? item[item.length - 2] : undefined;

    // Explicit alias: `... AS name`
    if (
      prevTok &&
      prevTok.kind === 'keyword' &&
      prevTok.text.toUpperCase() === 'AS' &&
      (lastTok.kind === 'identifier' || lastTok.kind === 'quotedIdentifier')
    ) {
      columns.push(stripIdentifierDelimiters(lastTok.text));
      continue;
    }

    // Implicit column name — last identifier that is not preceded by `(`
    // (avoids treating function names like COUNT as a column)
    if (lastTok.kind === 'identifier' || lastTok.kind === 'quotedIdentifier') {
      if (!prevTok || prevTok.kind !== 'lparen') {
        columns.push(stripIdentifierDelimiters(lastTok.text));
      }
    }
  }

  return columns;
}

// ── Table-reference extraction ────────────────────────────────────────────────

/** Keywords that introduce a table-reference token sequence. */
const TABLE_INTRO_KEYWORDS = new Set([
  'FROM', 'JOIN', 'APPLY',
]);

/** Keywords that must NOT be mistaken for aliases or table names. */
const RESERVED_ALIASES = new Set([
  'ON', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'SET', 'AND', 'OR', 'NOT',
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER', 'APPLY',
  'UNION', 'INTERSECT', 'EXCEPT', 'SELECT', 'INSERT', 'UPDATE', 'DELETE',
  'WITH', 'PIVOT', 'UNPIVOT', 'FOR', 'OPTION',
]);

/**
 * Extracts all FROM / JOIN table references and populates `out` with
 * resolved VisibleSource entries.
 *
 * Only processes FROM/JOIN at `targetDepth` (the paren depth of the cursor).
 * Pass a `usedAliases` Set to enable automatic deduplication of generated
 * aliases (e.g. two joins to same table → "o" and "o2").
 */
function extractTableRefs(
  sig: Token[],
  tables: TableInfo[],
  cteNames: string[],
  cteColumns: Map<string, string[]>,
  out: VisibleSource[],
  targetDepth: number,
  usedAliases?: Set<string>,
): void {
  let depth = 0;
  let i = 0;

  while (i < sig.length) {
    const tok = sig[i];

    // Track paren depth.
    if (tok.kind === 'lparen') { depth++; i++; continue; }
    if (tok.kind === 'rparen') { depth--; i++; continue; }

    // Only process table-intro keywords at the cursor's depth.
    if (depth !== targetDepth || tok.kind !== 'keyword') { i++; continue; }
    const upper = tok.text.toUpperCase();
    if (!TABLE_INTRO_KEYWORDS.has(upper)) { i++; continue; }

    i++; // move past the intro keyword

    // ── Collect the identifier chain: [db.]schema.table  or  cte  ───────
    let j = i;
    const parts: string[] = [];

    while (j < sig.length) {
      const t = sig[j];

      // Subquery — skip the whole ( ... ) block and produce no ref.
      if (t.kind === 'lparen') break;

      // Keyword used as table name is unusual; bail out on reserved ones.
      if (t.kind === 'keyword' && RESERVED_ALIASES.has(t.text.toUpperCase())) break;

      if (
        t.kind === 'identifier' ||
        t.kind === 'quotedIdentifier' ||
        // Allow non-reserved keywords to appear in identifiers (e.g. "dbo.[User]")
        (t.kind === 'keyword' && !RESERVED_ALIASES.has(t.text.toUpperCase()))
      ) {
        parts.push(stripIdentifierDelimiters(t.text));
        j++;

        // Check for a dot — if so, continue collecting the chain.
        if (j < sig.length && sig[j].kind === 'dot') {
          j++; // consume dot
        } else {
          break;
        }
      } else {
        break;
      }
    }

    if (parts.length === 0) continue;

    const objectName = parts[parts.length - 1];
    const schema = parts.length >= 2 ? parts[parts.length - 2] : undefined;
    const database = parts.length >= 3 ? parts[parts.length - 3] : undefined;

    // ── Resolve optional alias: [AS] identifier ───────────────────────────
    let alias: string | undefined;

    if (j < sig.length) {
      const next = sig[j];

      if (next.kind === 'keyword' && next.text.toUpperCase() === 'AS') {
        j++;
        const aliasTok = sig[j];
        if (
          aliasTok &&
          (aliasTok.kind === 'identifier' || aliasTok.kind === 'quotedIdentifier')
        ) {
          alias = stripIdentifierDelimiters(aliasTok.text);
        }
      } else if (
        (next.kind === 'identifier' || next.kind === 'quotedIdentifier') &&
        !RESERVED_ALIASES.has(next.text.toUpperCase())
      ) {
        alias = stripIdentifierDelimiters(next.text);
      }
    }

    const isExplicitAlias = alias !== undefined;

    // ── CTE reference? ─────────────────────────────────────────────────────
    if (cteNames.some((c) => c.toLowerCase() === objectName.toLowerCase())) {
      const cols = cteColumns.get(objectName.toLowerCase()) ?? [];
      const resolvedAlias = alias ?? generateAlias(objectName, usedAliases);
      usedAliases?.add(resolvedAlias);
      out.push({
        objectName,
        alias: resolvedAlias,
        columns: cols,
        explicitAlias: isExplicitAlias,
      });
      continue;
    }

    // ── Resolve against schema snapshot ───────────────────────────────────
    const tableInfo = resolveTable(objectName, schema, database, tables);
    if (tableInfo) {
      const resolvedAlias = alias ?? generateAlias(tableInfo.name, usedAliases);
      usedAliases?.add(resolvedAlias);
      out.push({
        objectName: tableInfo.name,
        schema: tableInfo.schema,
        database,
        alias: resolvedAlias,
        columns: tableInfo.columns.map((c) => c.name),
        explicitAlias: isExplicitAlias,
      });
    } else if (schema || database) {
      // Store unresolved qualified ref so callers can still use the alias.
      const resolvedAlias = alias ?? generateAlias(objectName, usedAliases);
      usedAliases?.add(resolvedAlias);
      out.push({ objectName, schema, database, alias: resolvedAlias, columns: [], explicitAlias: isExplicitAlias });
    }
  }
}

// ── Schema resolution helper ──────────────────────────────────────────────────

function resolveTable(
  name: string,
  schema: string | undefined,
  database: string | undefined,
  tables: TableInfo[],
): TableInfo | undefined {
  const nameLower = name.toLowerCase();
  if (schema) {
    const schemaLower = schema.toLowerCase();
    if (database) {
      const dbLower = database.toLowerCase();
      // Prefer an exact database match (cross-DB tables are tagged; current-DB
      // tables have database === undefined and serve as fallback).
      const exact = tables.find(
        (t) =>
          t.name.toLowerCase() === nameLower &&
          t.schema.toLowerCase() === schemaLower &&
          t.database?.toLowerCase() === dbLower,
      );
      if (exact) return exact;
      // Fallback: untagged table with matching name+schema (current DB).
      return tables.find(
        (t) =>
          t.name.toLowerCase() === nameLower &&
          t.schema.toLowerCase() === schemaLower &&
          t.database === undefined,
      );
    }
    return tables.find(
      (t) =>
        t.name.toLowerCase() === nameLower &&
        t.schema.toLowerCase() === schemaLower,
    );
  }
  return tables.find((t) => t.name.toLowerCase() === nameLower);
}
