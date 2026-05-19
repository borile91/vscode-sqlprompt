// ── Token types ───────────────────────────────────────────────────────────────

export type TokenKind =
  | 'keyword'
  | 'identifier'
  | 'quotedIdentifier'
  | 'string'
  | 'number'
  | 'operator'
  | 'dot'
  | 'comma'
  | 'lparen'
  | 'rparen'
  | 'comment'
  | 'whitespace'
  | 'semicolon'
  | 'star'
  | 'unknown';

export interface Token {
  kind: TokenKind;
  text: string;
  /** Offset from the start of the tokenized string (inclusive). */
  start: number;
  /** Offset from the start of the tokenized string (exclusive). */
  end: number;
}

// ── Statement / clause types ──────────────────────────────────────────────────

export type StatementKind =
  | 'select'
  | 'exec'
  | 'insert'
  | 'update'
  | 'delete'
  | 'merge'
  | 'cte'
  | 'unknown';

export type ClauseKind =
  | 'select'
  | 'from'
  | 'join'
  | 'exec'
  | 'on'
  | 'where'
  | 'groupBy'
  | 'having'
  | 'orderBy'
  | 'insertColumns'
  | 'values'
  | 'updateSet'
  | 'cte'
  | 'functionArgs'
  | 'unknown';

export type ExpectedKind =
  | 'keyword'
  | 'table'
  | 'view'
  | 'column'
  | 'function'
  | 'procedure'
  | 'schema'
  | 'database'
  | 'operator'
  | 'expression'
  | 'snippet'
  | 'parameter';

// ── Scope types ───────────────────────────────────────────────────────────────

export interface VisibleSource {
  alias?: string;
  objectName: string;
  schema?: string;
  database?: string;
  /** Column names for the resolved table (empty for unresolved CTEs / subqueries). */
  columns?: string[];
  /** True when the alias was explicitly written in SQL (AS x or bare x after table name). */
  explicitAlias?: boolean;
}

// ── Query context ─────────────────────────────────────────────────────────────

export interface QueryContext {
  /** Absolute cursor offset in the full document text. */
  cursorOffset: number;
  /** Absolute start/end of the current statement in the full document. */
  statementRange: { start: number; end: number };
  statementKind: StatementKind;
  clause: ClauseKind;
  expectedKinds: ExpectedKind[];
  /** The word being typed at the cursor (may be empty). */
  currentWord?: string;
  /**
   * For dot-qualified completions: the chain of qualifiers before the final dot.
   * E.g. cursor after "dbo.Orders." → qualifierChain = ["dbo", "Orders"]
   * Cursor after "o." → qualifierChain = ["o"]
   */
  qualifierChain?: string[];
  /** True when the cursor immediately follows a dot (possibly with a partial word after). */
  isAfterDot: boolean;
  /** True when the cursor is inside a function-call argument list. */
  isInFunctionCall: boolean;
  functionName?: string;
  /** Zero-based parameter index inside the function call. */
  parameterIndex?: number;
  /**
   * Tables/views/CTEs/subqueries that are in scope at the cursor position,
   * resolved with their aliases and column lists.
   */
  visibleSources: VisibleSource[];
  visibleCtes: string[];
  visibleAliases: string[];
  /**
   * A breadcrumb path describing where the cursor is syntactically,
   * e.g. ["select", "from", "join", "on"]. Useful for debugging and
   * for future finer-grained completion routing.
   */
  syntaxNodePath: string[];
  /**
   * True when the parser had to recover from a syntax error
   * (the context may be partially inferred).
   */
  parserRecovered: boolean;
}
