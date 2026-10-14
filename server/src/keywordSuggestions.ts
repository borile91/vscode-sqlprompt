/**
 * Parole chiave attese nel punto del cursore.
 *
 * Il resolver delle clausole dice *dove* si è (FROM, JOIN, WHERE…), non *cosa*
 * manca: dopo `JOIN dbo.CLIENTI c ` la clausola è ancora `join`, ma la tabella è
 * già scritta e ciò che serve è `ON`. Qui si guardano i token prima del cursore,
 * allo stesso livello di parentesi, e si deduce la parola chiave successiva.
 *
 * Tutto puro (nessuna dipendenza da LSP), per poterlo testare da solo.
 */

import { tokenize } from './sqlLexer';
import { Token } from './types';

export interface KeywordContext {
  /** Parole chiave da proporre, nell'ordine di priorità. */
  keywords: string[];
  /**
   * Vero quando una table source è già completa (`FROM dbo.T t `): proporre
   * altre tabelle lì è solo rumore.
   */
  afterCompleteSource: boolean;
  /**
   * Vero quando lì può seguire solo una parola chiave (`ORDER ` → `BY`,
   * `ALTER ` → `PROCEDURE`…): tabelle, colonne e snippet non vanno proposti.
   */
  keywordRequired?: boolean;
}

/** Token significativo; i gruppi tra parentesi già chiusi diventano un solo token `()`. */
interface LevelToken {
  kind: Token['kind'] | 'group';
  /** Testo in maiuscolo per keyword e identificatori. */
  text: string;
}

const NONE: KeywordContext = { keywords: [], afterCompleteSource: false };

const STATEMENT_START = [
  'SELECT', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'WITH', 'DECLARE', 'SET', 'EXEC',
  'IF', 'BEGIN', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE TABLE', 'MERGE', 'USE',
];

const JOINS = [
  'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN',
  'CROSS APPLY', 'OUTER APPLY',
];

/** Cosa segue una parola chiave che da sola non basta. */
const AFTER_KEYWORD: Array<[string[], string[]]> = [
  [['CREATE', 'OR', 'ALTER'], ['PROCEDURE', 'VIEW', 'FUNCTION', 'TRIGGER']],
  [['CREATE', 'OR'], ['ALTER']],
  [['CREATE'], ['TABLE', 'VIEW', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'INDEX', 'OR ALTER']],
  [['ALTER'], ['PROCEDURE', 'VIEW', 'FUNCTION', 'TABLE', 'TRIGGER']],
  [['DROP'], ['TABLE', 'VIEW', 'PROCEDURE', 'FUNCTION', 'INDEX', 'TRIGGER']],
  [['LEFT', 'OUTER'], ['JOIN']],
  [['RIGHT', 'OUTER'], ['JOIN']],
  [['FULL', 'OUTER'], ['JOIN']],
  [['LEFT'], ['JOIN', 'OUTER JOIN']],
  [['RIGHT'], ['JOIN', 'OUTER JOIN']],
  [['FULL'], ['JOIN', 'OUTER JOIN']],
  [['INNER'], ['JOIN']],
  [['CROSS'], ['JOIN', 'APPLY']],
  [['OUTER'], ['APPLY']],
  [['ORDER'], ['BY']],
  [['GROUP'], ['BY']],
  [['INSERT'], ['INTO']],
  [['DELETE'], ['FROM']],
  [['UNION', 'ALL'], ['SELECT']],
  [['UNION'], ['ALL', 'SELECT']],
  [['IS', 'NOT'], ['NULL']],
  [['IS'], ['NULL', 'NOT NULL']],
  [['NOT'], ['IN', 'LIKE', 'EXISTS', 'BETWEEN']],
];

/** Parole che chiudono una table source o un'espressione: non sono nomi. */
const STOP_WORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER',
  'APPLY', 'ON', 'AND', 'OR', 'NOT', 'GROUP', 'ORDER', 'BY', 'HAVING', 'UNION', 'SET',
  'VALUES', 'INTO', 'UPDATE', 'DELETE', 'INSERT', 'AS', 'WITH', 'IS', 'IN', 'LIKE',
  'BETWEEN', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'TOP', 'DISTINCT',
]);

/** Parole chiave che aprono il segmento in cui si trova il cursore. */
const ANCHORS = new Set([
  'FROM', 'JOIN', 'APPLY', 'UPDATE', 'INTO', 'ON', 'WHERE', 'HAVING', 'AND', 'OR',
  'SELECT', 'BY', 'SET',
]);

const COMPARISON_WORDS = new Set(['IS', 'IN', 'LIKE', 'BETWEEN']);

/**
 * Parole chiave attese con il cursore alla fine di `textBeforeCursor`
 * (il testo dello statement fino al cursore).
 */
export function suggestKeywords(textBeforeCursor: string): KeywordContext {
  // La parola in digitazione non conta: è quella che la scelta sostituirà.
  const text = textBeforeCursor.replace(/[\w@#$]+$/, '');
  const level = currentLevel(tokenize(text));

  if (level.length === 0) {
    return { keywords: STATEMENT_START, afterCompleteSource: false };
  }

  const words = level.map((t) => t.text);
  for (const [tail, next] of AFTER_KEYWORD) {
    if (endsWith(words, tail) && keywordTail(level, tail.length)) {
      // ALTER/CREATE/DROP valgono solo a inizio statement (non `ALTER TABLE … ALTER COLUMN`).
      if (['CREATE', 'ALTER', 'DROP'].includes(tail[0]) && level.length !== tail.length) continue;
      return { keywords: next, afterCompleteSource: false, keywordRequired: true };
    }
  }

  const k = lastIndexWhere(level, (t) => t.kind === 'keyword' && ANCHORS.has(t.text));
  if (k < 0) return NONE;
  const anchor = level[k].text;
  const segment = level.slice(k + 1);

  switch (anchor) {
    case 'FROM':
    case 'JOIN':
    case 'APPLY':
    case 'UPDATE':
    case 'INTO': {
      // `FROM a, b`: conta solo l'ultima table source della lista.
      const lastComma = lastIndexWhere(segment, (t) => t.kind === 'comma');
      const source = anchor === 'FROM' ? segment.slice(lastComma + 1) : segment;
      if (!isCompleteSource(source)) return NONE;
      return { keywords: afterSource(anchor, level[k - 1]?.text), afterCompleteSource: true };
    }

    case 'ON':
    case 'WHERE':
    case 'HAVING':
    case 'AND':
    case 'OR': {
      const owner = level[lastIndexWhere(level, (t) => ['ON', 'WHERE', 'HAVING'].includes(t.text))]?.text;
      if (isCompletePredicate(segment)) {
        return { keywords: ['AND', 'OR', ...afterPredicate(owner)], afterCompleteSource: owner === 'ON' };
      }
      if (segment.length > 0 && isOperand(segment)) {
        return {
          keywords: ['IN', 'LIKE', 'BETWEEN', 'IS NULL', 'IS NOT NULL', 'NOT IN', 'NOT LIKE'],
          afterCompleteSource: owner === 'ON',
        };
      }
      return { keywords: [], afterCompleteSource: owner === 'ON' };
    }

    case 'SELECT': {
      if (segment.length === 0) return { keywords: ['DISTINCT', 'TOP'], afterCompleteSource: false };
      const last = segment[segment.length - 1];
      const onlyModifiers = segment.every((t) => ['TOP', 'DISTINCT'].includes(t.text) || t.kind === 'number' || t.kind === 'group');
      if (onlyModifiers || !endsExpression(last)) return NONE;
      return { keywords: ['FROM', 'INTO'], afterCompleteSource: false };
    }

    case 'BY': {
      const last = segment[segment.length - 1];
      if (!last || !endsExpression(last)) return NONE;
      return level[k - 1]?.text === 'ORDER'
        ? { keywords: ['ASC', 'DESC'], afterCompleteSource: false }
        : { keywords: ['HAVING', 'ORDER BY'], afterCompleteSource: false };
    }

    case 'SET': {
      if (!isCompletePredicate(segment)) return NONE;
      return { keywords: ['WHERE', 'FROM'], afterCompleteSource: false };
    }
  }
  return NONE;
}

/** Parole chiave dopo una table source completa, in base a chi l'ha introdotta. */
function afterSource(anchor: string, beforeAnchor: string | undefined): string[] {
  if (anchor === 'JOIN') return ['ON'];
  if (anchor === 'UPDATE') return ['SET'];
  if (anchor === 'INTO') return beforeAnchor === 'INSERT' ? ['VALUES', 'SELECT'] : ['FROM'];
  if (beforeAnchor === 'DELETE') return ['WHERE'];
  return [...JOINS, 'WHERE', 'GROUP BY', 'ORDER BY', 'UNION', 'UNION ALL'];
}

/** Parole chiave dopo un predicato completo, oltre ad AND/OR. */
function afterPredicate(owner: string | undefined): string[] {
  if (owner === 'ON') return [...JOINS, 'WHERE', 'GROUP BY', 'ORDER BY'];
  if (owner === 'WHERE') return ['GROUP BY', 'ORDER BY', 'UNION', 'UNION ALL'];
  if (owner === 'HAVING') return ['ORDER BY'];
  return [];
}

// ── Token allo stesso livello del cursore ─────────────────────────────────────

/**
 * Token significativi del livello di parentesi in cui si trova il cursore,
 * dall'ultima `(` non chiusa in poi. I gruppi già chiusi diventano `()`.
 */
function currentLevel(tokens: Token[]): LevelToken[] {
  const stack: LevelToken[][] = [[]];
  for (const token of tokens) {
    if (token.kind === 'whitespace' || token.kind === 'comment') continue;
    if (token.kind === 'lparen') {
      stack.push([]);
      continue;
    }
    if (token.kind === 'rparen') {
      if (stack.length > 1) stack.pop();
      stack[stack.length - 1].push({ kind: 'group', text: '()' });
      continue;
    }
    // `;` chiude lo statement: si riparte da capo.
    if (token.text === ';') {
      stack.splice(0, stack.length, []);
      continue;
    }
    const upper = token.kind === 'keyword' || token.kind === 'identifier' ? token.text.toUpperCase() : token.text;
    stack[stack.length - 1].push({ kind: token.kind, text: upper });
  }
  return stack[stack.length - 1];
}

// ── Riconoscimento dei pezzi ──────────────────────────────────────────────────

function isName(token: LevelToken | undefined): boolean {
  if (!token) return false;
  if (token.kind === 'identifier' || token.kind === 'quotedIdentifier') return !STOP_WORDS.has(token.text);
  return token.kind === 'keyword' && !STOP_WORDS.has(token.text);
}

/** `[db.][schema.]nome[(…)] [WITH (…)] [[AS] alias] [WITH (…)]`, consumata per intero. */
function isCompleteSource(tokens: LevelToken[]): boolean {
  let i = 0;
  if (!isName(tokens[i])) return false;
  i++;
  while (tokens[i]?.kind === 'dot' && isName(tokens[i + 1])) i += 2;
  if (tokens[i]?.kind === 'dot') return false;
  if (tokens[i]?.kind === 'group') i++;
  if (tokens[i]?.text === 'WITH' && tokens[i + 1]?.kind === 'group') i += 2;
  if (tokens[i]?.text === 'AS') {
    if (!isName(tokens[i + 1])) return false;
    i += 2;
  } else if (isName(tokens[i])) {
    i++;
  }
  if (tokens[i]?.text === 'WITH' && tokens[i + 1]?.kind === 'group') i += 2;
  return i === tokens.length;
}

/** Un solo operando: nome qualificato, numero, stringa, variabile o gruppo. */
function isOperand(tokens: LevelToken[]): boolean {
  if (tokens.length === 1) return endsExpression(tokens[0]);
  let i = 0;
  if (!isName(tokens[i])) return false;
  i++;
  while (tokens[i]?.kind === 'dot' && isName(tokens[i + 1])) i += 2;
  return i === tokens.length;
}

/** Contiene un confronto e termina con un operando: `a.X = b.Y`, `x IS NULL`, `EXISTS (…)`. */
function isCompletePredicate(tokens: LevelToken[]): boolean {
  if (tokens.length === 0) return false;
  const last = tokens[tokens.length - 1];
  if (tokens.length === 2 && tokens[0].text === 'EXISTS' && last.kind === 'group') return true;
  const hasComparison = tokens.some(
    (t) => t.kind === 'operator' || (t.kind === 'keyword' && COMPARISON_WORDS.has(t.text)),
  );
  return hasComparison && (endsExpression(last) || last.text === 'NULL');
}

function endsExpression(token: LevelToken): boolean {
  return (
    isName(token) ||
    token.kind === 'number' ||
    token.kind === 'string' ||
    token.kind === 'group' ||
    token.text === '*'
  );
}

// ── Utilità ───────────────────────────────────────────────────────────────────

function endsWith(words: string[], tail: string[]): boolean {
  if (words.length < tail.length) return false;
  return tail.every((w, i) => words[words.length - tail.length + i] === w);
}

/** Le ultime `n` parole sono davvero keyword (non un identificatore `[ALTER]`). */
function keywordTail(level: LevelToken[], n: number): boolean {
  return level.slice(-n).every((t) => t.kind === 'keyword' || t.kind === 'identifier');
}

function lastIndexWhere<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i])) return i;
  }
  return -1;
}
