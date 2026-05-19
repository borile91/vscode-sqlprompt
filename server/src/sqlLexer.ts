/**
 * SqlLexerService
 *
 * Converts a T-SQL string into a flat, position-annotated token stream.
 * Every character in the input is covered by exactly one token.
 *
 * Token rules:
 *  - Keywords are recognised case-insensitively (SELECT, FROM, …)
 *  - Identifiers: letters / digits / _ / @ / # / $
 *  - Quoted identifiers: [...] and "..."
 *  - String literals: '...' and N'...' (doubled-quote escape)
 *  - Comments: -- line comment and block comments
 *  - Numbers: integer, decimal, scientific, 0x hex
 *  - Operators: = < > ! + - / % & | ^ ~ and two-char combos
 *  - Punctuation: . , ( ) ; *
 */

import { Token, TokenKind } from './types';

// ── T-SQL keyword set ─────────────────────────────────────────────────────────
// Used solely for TokenKind classification; does not affect parsing logic.
const KEYWORDS = new Set<string>([
  'ADD', 'ALL', 'ALTER', 'AND', 'ANY', 'AS', 'ASC',
  'AUTHORIZATION', 'BACKUP', 'BEGIN', 'BETWEEN', 'BREAK', 'BROWSE',
  'BULK', 'BY', 'CASCADE', 'CASE', 'CHECK', 'CHECKPOINT', 'CLOSE',
  'CLUSTERED', 'COALESCE', 'COLLATE', 'COLUMN', 'COMMIT', 'COMPUTE',
  'CONSTRAINT', 'CONTAINS', 'CONTAINSTABLE', 'CONTINUE', 'CONVERT',
  'CREATE', 'CROSS', 'CURRENT', 'CURRENT_DATE', 'CURRENT_TIME',
  'CURRENT_TIMESTAMP', 'CURRENT_USER', 'CURSOR',
  'DATABASE', 'DBCC', 'DEALLOCATE', 'DECLARE', 'DEFAULT', 'DELETE',
  'DENY', 'DESC', 'DISTINCT', 'DISTRIBUTED', 'DOUBLE', 'DROP', 'DUMP',
  'ELSE', 'END', 'ERRLVL', 'ESCAPE', 'EXCEPT', 'EXEC', 'EXECUTE',
  'EXISTS', 'EXIT', 'EXTERNAL',
  'FETCH', 'FILE', 'FILLFACTOR', 'FOR', 'FOREIGN', 'FOLLOWING',
  'FREETEXT', 'FREETEXTTABLE', 'FROM', 'FULL', 'FUNCTION',
  'GO', 'GOTO', 'GRANT', 'GROUP',
  'HAVING', 'HOLDLOCK',
  'IDENTITY', 'IDENTITY_INSERT', 'IDENTITYCOL', 'IF', 'IN', 'INDEX',
  'INNER', 'INSERT', 'INTERSECT', 'INTO', 'IS',
  'JOIN', 'KEY', 'KILL',
  'LEFT', 'LIKE', 'LINENO',
  'MERGE',
  'NATIONAL', 'NOCHECK', 'NONCLUSTERED', 'NOT', 'NULL', 'NULLIF',
  'OF', 'OFF', 'OFFSETS', 'ON', 'OPEN', 'OPENDATASOURCE', 'OPENQUERY',
  'OPENROWSET', 'OPENXML', 'OPTION', 'OR', 'ORDER', 'OUTER', 'OVER',
  'PARTITION', 'PERCENT', 'PIVOT', 'PLAN', 'PRECEDING', 'PRIMARY',
  'PRINT', 'PROC', 'PROCEDURE', 'PUBLIC',
  'RAISERROR', 'RANGE', 'READ', 'READTEXT', 'RECONFIGURE', 'REFERENCES',
  'REPLICATION', 'RESTORE', 'RESTRICT', 'RETURN', 'REVERT', 'REVOKE',
  'RIGHT', 'ROLLBACK', 'ROW', 'ROWCOUNT', 'ROWGUIDCOL', 'ROWS', 'RULE',
  'SAVE', 'SCHEMA', 'SELECT', 'SESSION_USER', 'SET', 'SETUSER',
  'SHUTDOWN', 'SOME', 'STATISTICS', 'SYSTEM_USER',
  'TABLE', 'TABLESAMPLE', 'TEXTSIZE', 'THEN', 'TO', 'TOP',
  'TRAN', 'TRANSACTION', 'TRIGGER', 'TRUNCATE',
  'UNBOUNDED', 'UNION', 'UNIQUE', 'UNPIVOT', 'UPDATE', 'UPDATETEXT',
  'USE', 'USER',
  'VALUES', 'VARYING', 'VIEW',
  'WAITFOR', 'WHEN', 'WHERE', 'WHILE', 'WITH', 'WITHIN', 'WRITETEXT',
  // Built-in aggregate / scalar / window functions used as context markers
  'APPLY', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
  'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE', 'LAG', 'LEAD',
  'FIRST_VALUE', 'LAST_VALUE', 'CUME_DIST', 'PERCENT_RANK',
  'CAST', 'CONVERT', 'ISNULL', 'COALESCE', 'NULLIF', 'IIF',
  'GETDATE', 'GETUTCDATE', 'NEWID', 'NEWSEQUENTIALID',
  'LEN', 'SUBSTRING', 'UPPER', 'LOWER', 'LTRIM', 'RTRIM',
  'REPLACE', 'CHARINDEX', 'PATINDEX', 'STUFF', 'REVERSE',
  'ABS', 'CEILING', 'FLOOR', 'ROUND', 'POWER', 'SQRT', 'SIGN',
  'DATEADD', 'DATEDIFF', 'DATEPART', 'DATENAME', 'EOMONTH',
  'YEAR', 'MONTH', 'DAY', 'ISDATE', 'ISNUMERIC',
]);

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Tokenizes `text` and returns a flat token array covering every character.
 * The input is expected to be a single SQL statement (no GO separators).
 */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = text.length;

  while (i < len) {
    const start = i;
    const ch = text[i];

    // ── Line comment  -- ... ─────────────────────────────────────────────
    if (ch === '-' && i + 1 < len && text[i + 1] === '-') {
      i += 2;
      while (i < len && text[i] !== '\n') i++;
      tokens.push(mkTok('comment', text, start, i));
      continue;
    }

    // ── Block comment  /* ... */ ─────────────────────────────────────────
    if (ch === '/' && i + 1 < len && text[i + 1] === '*') {
      i += 2;
      while (i < len && !(text[i] === '*' && i + 1 < len && text[i + 1] === '/')) {
        i++;
      }
      if (i < len) i += 2; // consume */
      tokens.push(mkTok('comment', text, start, i));
      continue;
    }

    // ── N'...' Unicode string literal ───────────────────────────────────
    if ((ch === 'N' || ch === 'n') && i + 1 < len && text[i + 1] === "'") {
      i += 2; // N and opening '
      i = scanStringBody(text, i, len);
      tokens.push(mkTok('string', text, start, i));
      continue;
    }

    // ── String literal  '...' ────────────────────────────────────────────
    if (ch === "'") {
      i++;
      i = scanStringBody(text, i, len);
      tokens.push(mkTok('string', text, start, i));
      continue;
    }

    // ── Quoted identifier  [...] ─────────────────────────────────────────
    if (ch === '[') {
      i++;
      while (i < len && text[i] !== ']') i++;
      if (i < len) i++; // consume ]
      tokens.push(mkTok('quotedIdentifier', text, start, i));
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
      tokens.push(mkTok('quotedIdentifier', text, start, i));
      continue;
    }

    // ── Whitespace ───────────────────────────────────────────────────────
    if (isWS(ch)) {
      while (i < len && isWS(text[i])) i++;
      tokens.push(mkTok('whitespace', text, start, i));
      continue;
    }

    // ── Hex number  0x... ────────────────────────────────────────────────
    if (ch === '0' && i + 1 < len && (text[i + 1] === 'x' || text[i + 1] === 'X')) {
      i += 2;
      while (i < len && isHexDigit(text[i])) i++;
      tokens.push(mkTok('number', text, start, i));
      continue;
    }

    // ── Decimal starting with a dot  .5 ─────────────────────────────────
    if (ch === '.' && i + 1 < len && isDigit(text[i + 1])) {
      i++;
      while (i < len && isDigit(text[i])) i++;
      tokens.push(mkTok('number', text, start, i));
      continue;
    }

    // ── Integer / float ──────────────────────────────────────────────────
    if (isDigit(ch)) {
      while (i < len && isDigit(text[i])) i++;
      if (i < len && text[i] === '.' && i + 1 < len && isDigit(text[i + 1])) {
        i++; // consume dot
        while (i < len && isDigit(text[i])) i++;
      }
      if (i < len && (text[i] === 'e' || text[i] === 'E')) {
        i++;
        if (i < len && (text[i] === '+' || text[i] === '-')) i++;
        while (i < len && isDigit(text[i])) i++;
      }
      tokens.push(mkTok('number', text, start, i));
      continue;
    }

    // ── Identifier or keyword ─────────────────────────────────────────────
    // Includes: letters, _, @, # (T-SQL locals / temp tables)
    if (isIdentStart(ch)) {
      while (i < len && isIdentContinue(text[i])) i++;
      const word = text.slice(start, i);
      const kind: TokenKind = KEYWORDS.has(word.toUpperCase()) ? 'keyword' : 'identifier';
      tokens.push({ kind, text: word, start, end: i });
      continue;
    }

    // ── Single-char punctuation ──────────────────────────────────────────
    if (ch === '.') { tokens.push(mkTok('dot',       text, start, ++i)); continue; }
    if (ch === ',') { tokens.push(mkTok('comma',     text, start, ++i)); continue; }
    if (ch === '(') { tokens.push(mkTok('lparen',    text, start, ++i)); continue; }
    if (ch === ')') { tokens.push(mkTok('rparen',    text, start, ++i)); continue; }
    if (ch === ';') { tokens.push(mkTok('semicolon', text, start, ++i)); continue; }
    if (ch === '*') { tokens.push(mkTok('star',      text, start, ++i)); continue; }

    // ── Operators ────────────────────────────────────────────────────────
    if (isOpChar(ch)) {
      i++;
      // Two-char operators: <>, !=, <=, >=, +=, -=, *=, /=, |=, &=, ^=
      if (i < len && isOpChar(text[i]) && isSecondOpChar(text[i])) i++;
      tokens.push(mkTok('operator', text, start, i));
      continue;
    }

    // ── Unknown ──────────────────────────────────────────────────────────
    tokens.push(mkTok('unknown', text, start, ++i));
  }

  return tokens;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mkTok(kind: TokenKind, text: string, start: number, end: number): Token {
  return { kind, text: text.slice(start, end), start, end };
}

/** Scans past the body of a single-quoted string (opening quote already consumed). */
function scanStringBody(text: string, i: number, len: number): number {
  while (i < len) {
    if (text[i] === "'" && i + 1 < len && text[i + 1] === "'") { i += 2; continue; }
    if (text[i] === "'") { i++; break; }
    i++;
  }
  return i;
}

function isWS(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isHexDigit(ch: string): boolean {
  return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') ||
         (ch >= 'A' && ch <= 'Z') ||
         ch === '_' || ch === '@' || ch === '#';
}

function isIdentContinue(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch) || ch === '$';
}

function isOpChar(ch: string): boolean {
  return ch === '=' || ch === '<' || ch === '>' || ch === '!' ||
         ch === '+' || ch === '-' || ch === '/' || ch === '%' ||
         ch === '&' || ch === '|' || ch === '^' || ch === '~';
}

/** Returns true for characters that can be the second char of a 2-char operator. */
function isSecondOpChar(ch: string): boolean {
  return ch === '=' || ch === '>';
}
