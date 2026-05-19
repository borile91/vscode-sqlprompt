/**
 * CursorContextResolver
 *
 * Given a SQL statement's text and the absolute cursor offset, produces a
 * rich `QueryContext` that describes *what the user is in the middle of typing*.
 *
 * Pipeline:
 *   statement text
 *     → tokenize (sqlLexer)
 *     → significant tokens before cursor (no whitespace / comments)
 *     → resolveStatementKind
 *     → resolveClause          (paren-stack–based, handles subqueries)
 *     → resolveDotQualifier    (isAfterDot, qualifierChain)
 *     → resolveParenContext    (isInFunctionCall, functionName, parameterIndex)
 *     → buildScope             (visibleSources, visibleCtes, visibleAliases)
 *     → resolveExpectedKinds
 *     → QueryContext
 *
 * No regex is used for context detection; all decisions are based on the
 * token stream.
 */

import { Token, QueryContext, StatementKind, ClauseKind, ExpectedKind } from './types';
import { tokenize } from './sqlLexer';
import { buildScope } from './scopeBuilder';
import { extractWordAtOffset } from './documentTextService';
import { stripIdentifierDelimiters } from './utils';
import { TableInfo } from './schemaLoader';

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolves the full `QueryContext` for the cursor position.
 *
 * @param statementText  Text of the current SQL statement (no surrounding batches).
 * @param statementStart Absolute offset in the full document where `statementText` begins.
 * @param cursorAbsolute Absolute cursor offset in the full document.
 * @param tables         Schema snapshot.
 */
export function resolveContext(
  statementText: string,
  statementStart: number,
  cursorAbsolute: number,
  tables: TableInfo[],
): QueryContext {
  const cursorOffset = cursorAbsolute - statementStart; // relative to statement

  let tokens: Token[];
  let parserRecovered = false;
  try {
    tokens = tokenize(statementText);
  } catch {
    // Lexer should never throw, but guard defensively.
    tokens = [];
    parserRecovered = true;
  }

  // Significant tokens whose end is at or before the cursor.
  // We use `end <= cursorOffset` so that a token being typed (e.g. partial
  // identifier) is NOT included — we want the context *before* the current word.
  const sig = tokens.filter(
    (t) =>
      t.end <= cursorOffset &&
      t.kind !== 'whitespace' &&
      t.kind !== 'comment',
  );

  // Current word being typed at cursor (may be empty).
  const currentWord = extractWordAtOffset(statementText, cursorOffset) || undefined;

  const statementKind = resolveStatementKind(sig);
  const { isAfterDot, qualifierChain } = resolveDotQualifier(sig, currentWord);
  const clause = resolveClause(sig, statementKind);
  const { depth, isInFunctionCall, functionName, parameterIndex } = resolveParenContext(sig);

  // Build visible scope from the full token list (includes tokens at cursor).
  const { visibleSources, visibleCtes, visibleAliases } = buildScope(
    tokens,
    cursorOffset,
    tables,
  );

  const expectedKinds = resolveExpectedKinds(
    clause,
    isAfterDot,
    isInFunctionCall,
    statementKind,
    qualifierChain,
    visibleAliases,
    visibleCtes,
  );

  const syntaxNodePath = buildSyntaxNodePath(statementKind, clause, depth, isInFunctionCall);

  return {
    cursorOffset: cursorAbsolute,
    statementRange: { start: statementStart, end: statementStart + statementText.length },
    statementKind,
    clause,
    expectedKinds,
    currentWord,
    qualifierChain: qualifierChain.length > 0 ? qualifierChain : undefined,
    isAfterDot,
    isInFunctionCall,
    functionName: functionName ?? undefined,
    parameterIndex,
    visibleSources,
    visibleCtes,
    visibleAliases,
    syntaxNodePath,
    parserRecovered,
  };
}

// ── Statement kind ────────────────────────────────────────────────────────────

function resolveStatementKind(sig: Token[]): StatementKind {
  // Look for the first DML keyword at depth 0.
  let depth = 0;
  for (const tok of sig) {
    if (tok.kind === 'lparen') { depth++; continue; }
    if (tok.kind === 'rparen') { if (depth > 0) depth--; continue; }
    if (depth !== 0 || tok.kind !== 'keyword') continue;

    switch (tok.text.toUpperCase()) {
      case 'WITH':   return 'cte';    // CTE preamble
      case 'SELECT': return 'select';
      case 'INSERT': return 'insert';
      case 'UPDATE': return 'update';
      case 'DELETE': return 'delete';
      case 'MERGE':  return 'merge';
    }
  }
  return 'unknown';
}

// ── Clause ────────────────────────────────────────────────────────────────────

interface ClauseFrame {
  clause: ClauseKind;
}

/**
 * Uses a paren-depth stack to resolve the SQL clause at the cursor.
 * When the cursor is inside a subquery, the clause of that subquery is returned.
 */
function resolveClause(sig: Token[], statementKind: StatementKind): ClauseKind {
  const stack: ClauseFrame[] = [{ clause: 'unknown' }];
  let lastKeyword = '';

  for (const tok of sig) {
    if (tok.kind === 'lparen') {
      stack.push({ clause: 'unknown' });
      lastKeyword = '';
      continue;
    }
    if (tok.kind === 'rparen') {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (tok.kind !== 'keyword') continue;

    const kw = tok.text.toUpperCase();
    const frame = stack[stack.length - 1];

    switch (kw) {
      case 'SELECT':
        frame.clause = 'select';
        break;
      case 'FROM':
        frame.clause = 'from';
        break;
      case 'JOIN':
        frame.clause = 'join';
        break;
      case 'ON':
        frame.clause = 'on';
        break;
      case 'WHERE':
        frame.clause = 'where';
        break;
      case 'HAVING':
        frame.clause = 'having';
        break;
      case 'VALUES':
        frame.clause = 'values';
        break;
      case 'SET':
        if (statementKind === 'update') frame.clause = 'updateSet';
        break;
      case 'WITH':
        // Only treat WITH as the CTE clause at the outermost depth.
        if (stack.length === 1) frame.clause = 'cte';
        break;
      case 'BY':
        if (lastKeyword === 'GROUP') frame.clause = 'groupBy';
        else if (lastKeyword === 'ORDER') frame.clause = 'orderBy';
        // PARTITION BY → stay in current clause (OVER context)
        break;
      case 'INTO':
        // INSERT INTO → keep statementKind to 'insert' but clause can be insertColumns
        // when we later see the column list.  For now, mark as from-like.
        if (statementKind === 'insert') frame.clause = 'insertColumns';
        break;
      // These are prefix keywords before JOIN — don't change clause.
      case 'INNER':
      case 'LEFT':
      case 'RIGHT':
      case 'FULL':
      case 'CROSS':
      case 'OUTER':
      case 'APPLY':
      case 'GROUP':
      case 'ORDER':
      case 'PARTITION':
        break;
      default:
        break;
    }

    lastKeyword = kw;
  }

  return stack[stack.length - 1].clause;
}

// ── Dot-qualifier context ─────────────────────────────────────────────────────

interface DotQualifierResult {
  isAfterDot: boolean;
  qualifierChain: string[];
}

/**
 * Detects whether the cursor is immediately after a dot (possibly with a
 * partial identifier already typed), and collects the qualifier chain.
 *
 * Examples:
 *   "SELECT o." (cursor here)  → isAfterDot = true,  chain = ["o"]
 *   "FROM dbo." (cursor here)  → isAfterDot = true,  chain = ["dbo"]
 *   "dbo.Orders." (cursor)     → isAfterDot = true,  chain = ["dbo", "Orders"]
 *   "WHERE o.col" (cursor)     → isAfterDot = false  (partial word after dot)
 */
function resolveDotQualifier(
  sig: Token[],
  currentWord: string | undefined,
): DotQualifierResult {
  // If the user is typing a word AND that word's start is preceded by a dot,
  // the sig array already excludes that partial word (end <= cursorOffset check).
  // So if currentWord is non-empty, the actual sig should end with "... dot".
  // If currentWord is empty, sig ends with "... dot" for isAfterDot.

  // The last significant token must be a dot.
  const lastTok = sig[sig.length - 1];
  if (!lastTok || lastTok.kind !== 'dot') {
    return { isAfterDot: false, qualifierChain: [] };
  }

  // Walk backwards collecting: identifier, dot, identifier, dot, ...
  const chain: string[] = [];
  let j = sig.length - 1; // points at the trailing dot

  while (j >= 0) {
    const t = sig[j];
    if (t.kind === 'dot') {
      j--;
      // Expect an identifier before this dot.
      if (
        j >= 0 &&
        (sig[j].kind === 'identifier' ||
          sig[j].kind === 'quotedIdentifier' ||
          sig[j].kind === 'keyword')
      ) {
        chain.unshift(stripIdentifierDelimiters(sig[j].text));
        j--;
        // Continue — maybe there's another dot before this identifier.
      } else {
        break;
      }
    } else {
      break;
    }
  }

  return { isAfterDot: true, qualifierChain: chain };
}

// ── Paren / function-call context ─────────────────────────────────────────────

interface ParenContextResult {
  depth: number;
  isInFunctionCall: boolean;
  functionName: string | null;
  parameterIndex: number | undefined;
}

interface ParenFrame {
  kind: 'function' | 'subquery' | 'list';
  functionName: string | null;
  commaCount: number;
}

function resolveParenContext(sig: Token[]): ParenContextResult {
  const stack: ParenFrame[] = [];
  let prevSig: Token | undefined;

  for (const tok of sig) {
    if (tok.kind === 'lparen') {
      let kind: ParenFrame['kind'] = 'list';
      let fname: string | null = null;

      if (
        prevSig &&
        (prevSig.kind === 'identifier' ||
          prevSig.kind === 'keyword' ||
          prevSig.kind === 'quotedIdentifier')
      ) {
        // A paren immediately after an identifier/keyword is a function call
        // *unless* the preceding keyword is a subquery introducer.
        const prevUpper = prevSig.text.toUpperCase();
        if (SUBQUERY_INTRODUCERS.has(prevUpper)) {
          kind = 'subquery';
        } else {
          kind = 'function';
          fname = stripIdentifierDelimiters(prevSig.text);
        }
      }

      stack.push({ kind, functionName: fname, commaCount: 0 });
    } else if (tok.kind === 'rparen') {
      if (stack.length > 0) stack.pop();
    } else if (tok.kind === 'comma' && stack.length > 0) {
      stack[stack.length - 1].commaCount++;
    }

    prevSig = tok;
  }

  const depth = stack.length;
  const topFrame = stack[stack.length - 1];
  const isInFunctionCall = depth > 0 && topFrame?.kind === 'function';

  return {
    depth,
    isInFunctionCall,
    functionName: isInFunctionCall ? topFrame!.functionName : null,
    parameterIndex: isInFunctionCall ? topFrame!.commaCount : undefined,
  };
}

/** Keywords that, when followed by `(`, introduce a subquery rather than a function call. */
const SUBQUERY_INTRODUCERS = new Set([
  'IN', 'EXISTS', 'NOT', 'ANY', 'ALL', 'SOME',
  'FROM', 'JOIN', 'APPLY', 'WHERE', 'HAVING',
]);

// ── Expected kinds ────────────────────────────────────────────────────────────

function resolveExpectedKinds(
  clause: ClauseKind,
  isAfterDot: boolean,
  isInFunctionCall: boolean,
  statementKind: StatementKind,
  qualifierChain: string[],
  visibleAliases: string[],
  visibleCtes: string[],
): ExpectedKind[] {
  if (isAfterDot) {
    // Qualifier chain of length 1 can be an alias or a schema.
    if (qualifierChain.length === 1) {
      const qual = qualifierChain[0].toLowerCase();
      const isAlias = visibleAliases.some((a) => a.toLowerCase() === qual);
      const isCte   = visibleCtes.some((c) => c.toLowerCase() === qual);
      if (isAlias || isCte) return ['column'];
      // Otherwise assume it's a schema → offer tables
      return ['table', 'view'];
    }
    if (qualifierChain.length >= 2) {
      // db.schema. → tables; schema.table. → columns
      // Heuristic: last qualifier is a known table → columns
      return ['column', 'table', 'view'];
    }
    return ['column', 'table', 'view', 'schema'];
  }

  if (isInFunctionCall) {
    return ['column', 'expression', 'parameter', 'function', 'keyword'];
  }

  switch (clause) {
    case 'select':
      return ['column', 'function', 'expression', 'snippet', 'keyword'];
    case 'from':
      return ['table', 'view', 'schema', 'function', 'keyword'];
    case 'join':
      return ['table', 'view', 'schema', 'keyword'];
    case 'on':
      return ['column', 'operator', 'expression', 'keyword'];
    case 'where':
      return ['column', 'function', 'operator', 'expression', 'keyword'];
    case 'groupBy':
    case 'orderBy':
    case 'having':
      return ['column', 'function', 'expression', 'keyword'];
    case 'updateSet':
      return ['column', 'expression', 'keyword'];
    case 'values':
      return ['expression', 'parameter', 'keyword'];
    case 'insertColumns':
      return ['column', 'keyword'];
    case 'cte':
      return ['keyword', 'snippet'];
    case 'functionArgs':
      return ['column', 'expression', 'parameter', 'function'];
    case 'unknown':
    default: {
      // Fall back: offer keywords + tables when in a DML statement
      if (statementKind !== 'unknown') {
        return ['keyword', 'table', 'column', 'function', 'snippet'];
      }
      return ['keyword', 'snippet'];
    }
  }
}

// ── Syntax node path ──────────────────────────────────────────────────────────

function buildSyntaxNodePath(
  statementKind: StatementKind,
  clause: ClauseKind,
  depth: number,
  isInFunctionCall: boolean,
): string[] {
  const path: string[] = [];
  if (statementKind !== 'unknown') path.push(statementKind);
  if (clause !== 'unknown') path.push(clause);
  if (depth > 0) path.push(`depth:${depth}`);
  if (isInFunctionCall) path.push('functionArgs');
  return path;
}
