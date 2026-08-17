/**
 * DocumentTextService
 *
 * Handles statement-boundary detection in a T-SQL document, including:
 *   - Semicolon (`;`) statement terminators
 *   - `GO` batch separators (case-insensitive, must be on its own line)
 *   - Implicit boundaries: a statement keyword (SELECT, UPDATE, INSERT, …)
 *     that opens a line while the previous statement was left unterminated
 *
 * All parsing is done character-by-character, correctly skipping string
 * literals, block/line comments, and quoted identifiers so that these
 * tokens never trigger false boundaries.
 */

export interface StatementRange {
  /** Raw text of the statement. */
  text: string;
  /** Absolute start offset in the full document text (inclusive). */
  start: number;
  /** Absolute end offset in the full document text (exclusive). */
  end: number;
  /**
   * Offset of the cursor *relative to the start of this statement*.
   * Useful as input to the lexer and context resolver.
   */
  cursorOffset: number;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the SQL statement (or batch segment) that contains `cursorAbsolute`.
 *
 * Handles:
 *  - `;` terminators (standard ANSI SQL)
 *  - `GO` on its own line (T-SQL batch separator, case-insensitive)
 */
export function extractStatementAtOffset(
  fullText: string,
  cursorAbsolute: number,
): StatementRange {
  const boundaries = findStatementBoundaries(fullText);

  let start = 0;
  let end = fullText.length;

  for (let i = 0; i < boundaries.length; i++) {
    if (boundaries[i] <= cursorAbsolute) {
      start = boundaries[i];
    } else {
      end = boundaries[i];
      break;
    }
  }

  end = Math.min(end, fullText.length);

  return {
    text: fullText.slice(start, end),
    start,
    end,
    cursorOffset: cursorAbsolute - start,
  };
}

/**
 * Returns the identifier word that ends exactly at `offset` (i.e. the
 * word being typed at the cursor, without the trailing partial character).
 */
export function extractWordAtOffset(text: string, offset: number): string {
  let start = offset;
  while (start > 0 && /\w/.test(text[start - 1])) {
    start--;
  }
  return text.slice(start, offset);
}

// ── Internal boundary finder ──────────────────────────────────────────────────

/**
 * Returns a sorted list of absolute offsets at which new statements begin.
 * The first element is always `0`.
 */
export function findStatementBoundaries(text: string): number[] {
  const boundaries: number[] = [0];
  const len = text.length;
  let i = 0;

  // ── State for the implicit-boundary heuristic ──────────────────────────
  /** Paren nesting depth: implicit boundaries only apply at depth 0. */
  let parenDepth = 0;
  /** True while only whitespace has been seen on the current line. */
  let atLineStart = true;
  /** Last significant token before the cursor position (uppercased). */
  let prevToken: PrevToken | null = null;
  /** First statement keyword seen at depth 0 since the last boundary. */
  let pendingStatement: string | null = null;

  /** Records a boundary and resets the per-statement heuristic state. */
  const pushBoundary = (offset: number): void => {
    if (offset > boundaries[boundaries.length - 1]) boundaries.push(offset);
    prevToken = null;
    pendingStatement = null;
    parenDepth = 0;
  };

  while (i < len) {
    const ch = text[i];

    // ── Whitespace / newlines ────────────────────────────────────────────
    if (ch === '\n') { atLineStart = true; i++; continue; }
    if (ch === '\r' || ch === ' ' || ch === '\t') { i++; continue; }

    // ── Line comment  -- ... \n ──────────────────────────────────────────
    if (ch === '-' && i + 1 < len && text[i + 1] === '-') {
      i += 2;
      while (i < len && text[i] !== '\n') i++;
      continue;
    }

    // ── Block comment  /* ... */ ─────────────────────────────────────────
    if (ch === '/' && i + 1 < len && text[i + 1] === '*') {
      i += 2;
      while (i < len && !(text[i] === '*' && i + 1 < len && text[i + 1] === '/')) {
        i++;
      }
      i += 2; // consume */
      // The comment itself counts as content on the line it ends on; a
      // trailing newline (if any) is handled by the whitespace branch.
      atLineStart = false;
      continue;
    }

    // ── N-prefixed Unicode string  N'...' ────────────────────────────────
    if ((ch === 'N' || ch === 'n') && i + 1 < len && text[i + 1] === "'") {
      i += 2; // consume N and opening quote
      i = skipStringBody(text, i, len);
      prevToken = { text: "'", isWord: false };
      atLineStart = false;
      continue;
    }

    // ── String literal  '...' ────────────────────────────────────────────
    if (ch === "'") {
      i++;
      i = skipStringBody(text, i, len);
      prevToken = { text: "'", isWord: false };
      atLineStart = false;
      continue;
    }

    // ── Quoted identifier  [...] ─────────────────────────────────────────
    if (ch === '[') {
      i++;
      while (i < len && text[i] !== ']') i++;
      if (i < len) i++; // consume ]
      prevToken = { text: ']', isWord: false };
      atLineStart = false;
      continue;
    }

    // ── Double-quoted identifier  "..." ──────────────────────────────────
    if (ch === '"') {
      i++;
      while (i < len) {
        if (text[i] === '"' && i + 1 < len && text[i + 1] === '"') { i += 2; continue; }
        if (text[i] === '"') { i++; break; }
        i++;
      }
      prevToken = { text: ']', isWord: false };
      atLineStart = false;
      continue;
    }

    // ── Semicolon terminator ─────────────────────────────────────────────
    if (ch === ';') {
      pushBoundary(i + 1);
      atLineStart = false;
      i++;
      continue;
    }

    // ── GO batch separator ───────────────────────────────────────────────
    // Rules: must be the first token on its line (leading whitespace is
    // allowed), and must be followed by whitespace / end-of-line / digits /
    // end-of-string only (to avoid matching e.g. "GOTO").
    if ((ch === 'G' || ch === 'g') && i + 1 < len && (text[i + 1] === 'O' || text[i + 1] === 'o')) {
      if (atLineStart && isGoSeparator(text, i, len)) {
        // Skip to the end of the GO line
        let j = i + 2;
        // Optionally skip the repeat count: GO 3
        while (j < len && (text[j] === ' ' || text[j] === '\t')) j++;
        while (j < len && text[j] >= '0' && text[j] <= '9') j++; // repeat count
        while (j < len && text[j] !== '\n' && text[j] !== '\r') j++;
        if (j < len && text[j] === '\r' && j + 1 < len && text[j + 1] === '\n') j += 2;
        else if (j < len) j++;

        pushBoundary(j);
        atLineStart = true;
        i = j;
        continue;
      }
    }

    // ── Word (identifier / keyword / number) ─────────────────────────────
    if (isWordChar(ch)) {
      const start = i;
      let j = i;
      while (j < len && isWordChar(text[j])) j++;
      const upper = text.slice(start, j).toUpperCase();

      if (
        atLineStart &&
        parenDepth === 0 &&
        start > 0 &&
        STATEMENT_START_KEYWORDS.has(upper) &&
        canStartNewStatement(upper, prevToken, pendingStatement) &&
        !(upper === 'WITH' && isTableHint(text, j, len))
      ) {
        pushBoundary(start);
      }

      // The `INSERT … SELECT` / `WITH … SELECT` exemption is single-use: once
      // the body that legitimately belongs to the statement has been seen (the
      // SELECT itself, or a VALUES list), any *further* line-initial SELECT is
      // a new statement again.  Without this the pending keyword would survive
      // until the next `;`/`GO` and suppress every later boundary.
      if (
        parenDepth === 0 &&
        (pendingStatement === 'INSERT' || pendingStatement === 'WITH') &&
        (upper === 'VALUES' || (atLineStart && upper === 'SELECT'))
      ) {
        pendingStatement = 'SELECT';
      }

      if (parenDepth === 0 && pendingStatement === null && STATEMENT_START_KEYWORDS.has(upper)) {
        pendingStatement = upper;
      }

      prevToken = { text: upper, isWord: true };
      atLineStart = false;
      i = j;
      continue;
    }

    // ── Parens and any other punctuation ─────────────────────────────────
    if (ch === '(') parenDepth++;
    else if (ch === ')' && parenDepth > 0) parenDepth--;

    prevToken = { text: ch, isWord: false };
    atLineStart = false;
    i++;
  }

  return boundaries;
}

// ── Implicit statement boundaries ─────────────────────────────────────────────

interface PrevToken {
  /** Uppercased token text (a single character for punctuation). */
  text: string;
  isWord: boolean;
}

/**
 * Keywords that may open a new statement when they are the first token on a
 * line.  Deliberately excludes block openers such as `BEGIN`, whose body is
 * best kept together with its header.
 */
const STATEMENT_START_KEYWORDS = new Set([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'WITH',
  'EXEC', 'EXECUTE', 'DECLARE', 'TRUNCATE',
  'CREATE', 'ALTER', 'DROP', 'USE', 'PRINT',
]);

/**
 * Keywords that, when they precede a line-initial statement keyword, mean the
 * previous statement is still open — so no boundary may be inserted.
 * Covers set operators (`UNION SELECT`), MERGE actions (`THEN UPDATE`),
 * clause keywords and subquery introducers.
 */
const OPEN_STATEMENT_KEYWORDS = new Set([
  'UNION', 'ALL', 'EXCEPT', 'INTERSECT',
  'AS', 'INTO', 'EXISTS', 'IN', 'AND', 'OR', 'NOT', 'CASE', 'WHEN', 'THEN',
  // NB: MERGE's own keywords (MATCHED, TARGET, SOURCE) are deliberately absent —
  // the whole statement is already exempted via `pendingStatement === 'MERGE'`,
  // and they are common table/column names that would otherwise suppress a
  // legitimate boundary (e.g. `… FROM dbo.Source` followed by a new SELECT).
  'ELSE', 'BEGIN', 'RETURN', 'BY', 'OVER',
  'FROM', 'JOIN', 'ON', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'SET', 'VALUES',
  'OUTPUT', 'APPLY', 'USING', 'WITH', 'PARTITION', 'TOP', 'DISTINCT',
  'LIKE', 'BETWEEN', 'IS', 'FOR', 'OPTION', 'GO',
]);

/** Punctuation that may legitimately end a statement. */
const CLOSING_PUNCTUATION = new Set([')', ']', "'", '*']);

/**
 * Decides whether a line-initial statement keyword really opens a new
 * statement, given what came before it.
 *
 * The rule is conservative on purpose: a false split loses the visible scope
 * of the query, so anything ambiguous is left attached to the previous
 * statement.
 */
function canStartNewStatement(
  keyword: string,
  prevToken: PrevToken | null,
  pendingStatement: string | null,
): boolean {
  // Nothing significant before → the statement already starts at offset 0.
  if (prevToken === null) return false;

  // MERGE spans several action blocks (WHEN MATCHED THEN UPDATE …): never split.
  if (pendingStatement === 'MERGE') return false;

  // `INSERT INTO t` / `WITH cte AS (…)` are routinely followed by a SELECT
  // that belongs to the very same statement.
  if (keyword === 'SELECT' && (pendingStatement === 'INSERT' || pendingStatement === 'WITH')) {
    return false;
  }

  if (prevToken.isWord) return !OPEN_STATEMENT_KEYWORDS.has(prevToken.text);
  return CLOSING_PUNCTUATION.has(prevToken.text);
}

/**
 * Detects the table-hint form `WITH (NOLOCK)`, which must not be mistaken for
 * a CTE preamble when it happens to start a line.
 */
function isTableHint(text: string, afterWith: number, len: number): boolean {
  let k = afterWith;
  while (k < len && (text[k] === ' ' || text[k] === '\t' || text[k] === '\r' || text[k] === '\n')) k++;
  return k < len && text[k] === '(';
}

/** Characters that may appear inside an identifier, keyword or number. */
function isWordChar(ch: string): boolean {
  return (
    (ch >= 'a' && ch <= 'z') ||
    (ch >= 'A' && ch <= 'Z') ||
    (ch >= '0' && ch <= '9') ||
    ch === '_' || ch === '@' || ch === '#' || ch === '$'
  );
}

/** Returns true when the two characters at `i` form a valid GO separator. */
function isGoSeparator(text: string, i: number, len: number): boolean {
  // Character after "GO" must be whitespace, digit, end-of-string, or \r/\n
  const afterGo = i + 2;
  if (afterGo >= len) return true;
  const next = text[afterGo];
  return next === ' ' || next === '\t' || next === '\r' || next === '\n' ||
         (next >= '0' && next <= '9');
}

/** Advances past a single-quoted string body (opening quote already consumed). */
function skipStringBody(text: string, i: number, len: number): number {
  while (i < len) {
    if (text[i] === "'" && i + 1 < len && text[i + 1] === "'") {
      i += 2; // escaped quote
      continue;
    }
    if (text[i] === "'") {
      i++; // closing quote
      break;
    }
    i++;
  }
  return i;
}
