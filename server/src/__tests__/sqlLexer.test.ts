import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../sqlLexer.js';
import type { Token } from '../types.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function kinds(tokens: Token[]) {
  return tokens.map((t) => t.kind);
}

function texts(tokens: Token[]) {
  return tokens.map((t) => t.text);
}

function sig(tokens: Token[]) {
  return tokens.filter((t) => t.kind !== 'whitespace' && t.kind !== 'comment');
}

// ── basic tokenisation ────────────────────────────────────────────────────────

describe('tokenize — keywords and identifiers', () => {
  it('recognises SELECT as keyword', () => {
    const toks = sig(tokenize('SELECT'));
    assert.equal(toks.length, 1);
    assert.equal(toks[0].kind, 'keyword');
    assert.equal(toks[0].text.toUpperCase(), 'SELECT');
  });

  it('recognises lowercase select as keyword', () => {
    const toks = sig(tokenize('select'));
    assert.equal(toks[0].kind, 'keyword');
  });

  it('recognises plain identifier', () => {
    const toks = sig(tokenize('myTable'));
    assert.equal(toks[0].kind, 'identifier');
    assert.equal(toks[0].text, 'myTable');
  });

  it('tokenises a simple SELECT * FROM query', () => {
    const toks = sig(tokenize('SELECT * FROM dbo.Orders'));
    const ks = kinds(toks);
    assert.deepEqual(ks, ['keyword', 'star', 'keyword', 'identifier', 'dot', 'identifier']);
    assert.equal(toks[3].text, 'dbo');
    assert.equal(toks[5].text, 'Orders');
  });
});

describe('tokenize — string literals', () => {
  it('handles single-quoted string', () => {
    const toks = tokenize("'hello world'");
    assert.equal(toks.length, 1);
    assert.equal(toks[0].kind, 'string');
    assert.equal(toks[0].text, "'hello world'");
  });

  it('handles escaped quote inside string', () => {
    const toks = tokenize("'it''s'");
    assert.equal(toks.length, 1);
    assert.equal(toks[0].kind, 'string');
    assert.equal(toks[0].text, "'it''s'");
  });

  it('handles N-prefixed unicode string', () => {
    const toks = tokenize("N'unicode'");
    assert.equal(toks.length, 1);
    assert.equal(toks[0].kind, 'string');
  });
});

describe('tokenize — quoted identifiers', () => {
  it('handles bracket-quoted identifier', () => {
    const toks = tokenize('[My Table]');
    assert.equal(toks.length, 1);
    assert.equal(toks[0].kind, 'quotedIdentifier');
    assert.equal(toks[0].text, '[My Table]');
  });

  it('handles double-quoted identifier', () => {
    const toks = tokenize('"dbo"');
    assert.equal(toks.length, 1);
    assert.equal(toks[0].kind, 'quotedIdentifier');
  });
});

describe('tokenize — comments', () => {
  it('handles line comment', () => {
    const toks = tokenize('-- this is a comment\nSELECT');
    const sigToks = sig(toks);
    assert.equal(sigToks.length, 1); // only SELECT, comment is filtered
    assert.equal(toks.find((t) => t.kind === 'comment')?.kind, 'comment');
  });

  it('handles block comment', () => {
    const toks = tokenize('/* comment */ SELECT');
    const comment = toks.find((t) => t.kind === 'comment');
    assert.ok(comment);
    assert.ok(comment!.text.startsWith('/*'));
  });
});

describe('tokenize — numbers', () => {
  it('handles integer', () => {
    const toks = tokenize('42');
    assert.equal(toks[0].kind, 'number');
    assert.equal(toks[0].text, '42');
  });

  it('handles float', () => {
    const toks = tokenize('3.14');
    assert.equal(toks[0].kind, 'number');
  });

  it('handles hex literal', () => {
    const toks = tokenize('0xFF');
    assert.equal(toks[0].kind, 'number');
    assert.equal(toks[0].text, '0xFF');
  });
});

describe('tokenize — operators and punctuation', () => {
  it('handles = operator', () => {
    const toks = sig(tokenize('a = b'));
    assert.equal(toks[1].kind, 'operator');
    assert.equal(toks[1].text, '=');
  });

  it('handles <> operator', () => {
    const toks = sig(tokenize('a <> b'));
    assert.equal(toks[1].kind, 'operator');
    assert.equal(toks[1].text, '<>');
  });

  it('handles != operator', () => {
    const toks = sig(tokenize('a != b'));
    assert.equal(toks[1].kind, 'operator');
    assert.equal(toks[1].text, '!=');
  });

  it('handles dot, comma, parens', () => {
    const toks = tokenize('a.b,(c)');
    assert.deepEqual(
      kinds(toks),
      ['identifier', 'dot', 'identifier', 'comma', 'lparen', 'identifier', 'rparen'],
    );
  });

  it('handles star', () => {
    const toks = sig(tokenize('SELECT *'));
    assert.equal(toks[1].kind, 'star');
  });
});

describe('tokenize — T-SQL specifics', () => {
  it('handles @variable', () => {
    const toks = tokenize('@CustomerID');
    assert.equal(toks[0].kind, 'identifier');
    assert.equal(toks[0].text, '@CustomerID');
  });

  it('handles @@ROWCOUNT system variable', () => {
    const toks = tokenize('@@ROWCOUNT');
    assert.equal(toks[0].kind, 'identifier');
    assert.equal(toks[0].text, '@@ROWCOUNT');
  });

  it('handles #TempTable', () => {
    const toks = tokenize('#TempTable');
    assert.equal(toks[0].kind, 'identifier');
  });

  it('covers every character exactly once', () => {
    const sql = "SELECT t.id, t.name FROM dbo.[My Table] t WHERE t.id = @p1 -- end\n";
    const toks = tokenize(sql);
    // Verify no gaps or overlaps in coverage
    let pos = 0;
    for (const t of toks) {
      assert.equal(t.start, pos, `Token "${t.text}" should start at ${pos}, got ${t.start}`);
      assert.ok(t.end > t.start, `Token "${t.text}" should have end > start`);
      pos = t.end;
    }
    assert.equal(pos, sql.length, 'Last token should end at the string length');
  });
});
