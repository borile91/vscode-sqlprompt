/**
 * DocumentTextService
 *
 * Handles statement-boundary detection in a T-SQL document, including:
 *   - Semicolon (`;`) statement terminators
 *   - `GO` batch separators (case-insensitive, must be on its own line)
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

  while (i < len) {
    const ch = text[i];

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
      continue;
    }

    // ── N-prefixed Unicode string  N'...' ────────────────────────────────
    if ((ch === 'N' || ch === 'n') && i + 1 < len && text[i + 1] === "'") {
      i += 2; // consume N and opening quote
      i = skipStringBody(text, i, len);
      continue;
    }

    // ── String literal  '...' ────────────────────────────────────────────
    if (ch === "'") {
      i++;
      i = skipStringBody(text, i, len);
      continue;
    }

    // ── Quoted identifier  [...] ─────────────────────────────────────────
    if (ch === '[') {
      i++;
      while (i < len && text[i] !== ']') i++;
      if (i < len) i++; // consume ]
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
      continue;
    }

    // ── Semicolon terminator ─────────────────────────────────────────────
    if (ch === ';') {
      boundaries.push(i + 1);
      i++;
      continue;
    }

    // ── GO batch separator ───────────────────────────────────────────────
    // Rules: must start at the beginning of a line (only whitespace before
    // on that line), must be followed by whitespace / end-of-line / digits /
    // end-of-string only (to avoid matching e.g. "GOTO").
    if ((ch === 'G' || ch === 'g') && i + 1 < len && (text[i + 1] === 'O' || text[i + 1] === 'o')) {
      if (isGoSeparator(text, i, len)) {
        // Skip to the end of the GO line
        let j = i + 2;
        // Optionally skip the repeat count: GO 3
        while (j < len && (text[j] === ' ' || text[j] === '\t')) j++;
        while (j < len && text[j] >= '0' && text[j] <= '9') j++; // repeat count
        while (j < len && text[j] !== '\n' && text[j] !== '\r') j++;
        if (j < len && text[j] === '\r' && j + 1 < len && text[j + 1] === '\n') j += 2;
        else if (j < len) j++;

        boundaries.push(j);
        i = j;
        continue;
      }
    }

    i++;
  }

  return boundaries;
}

/** Returns true when the two characters at `i` form a valid GO separator. */
function isGoSeparator(text: string, i: number, len: number): boolean {
  // Must be at the start of a line (or start of string)
  const prevCh = i > 0 ? text[i - 1] : '\n';
  if (prevCh !== '\n' && prevCh !== '\r') {
    return false;
  }

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
