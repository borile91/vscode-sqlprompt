import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { suggestKeywords } from '../keywordSuggestions.js';

const kw = (sql: string) => suggestKeywords(sql).keywords;

describe('suggestKeywords — inizio statement e DDL', () => {
  it('a inizio statement propone le parole chiave che aprono uno statement', () => {
    assert.ok(kw('').includes('SELECT'));
    assert.ok(kw('ALT').includes('ALTER'));
  });

  it('dopo ALTER propone il tipo di oggetto', () => {
    assert.deepEqual(kw('ALTER '), ['PROCEDURE', 'VIEW', 'FUNCTION', 'TABLE', 'TRIGGER']);
    assert.deepEqual(kw('alter p'), ['PROCEDURE', 'VIEW', 'FUNCTION', 'TABLE', 'TRIGGER']);
  });

  it('CREATE, CREATE OR, CREATE OR ALTER e DROP', () => {
    assert.ok(kw('CREATE ').includes('OR ALTER'));
    assert.deepEqual(kw('CREATE OR '), ['ALTER']);
    assert.deepEqual(kw('CREATE OR ALTER '), ['PROCEDURE', 'VIEW', 'FUNCTION', 'TRIGGER']);
    assert.ok(kw('DROP ').includes('TABLE'));
  });

  it('ALTER dentro uno statement non è un header', () => {
    assert.deepEqual(kw('ALTER TABLE dbo.T ALTER '), []);
  });
});

describe('suggestKeywords — FROM e JOIN', () => {
  it('dopo JOIN con tabella e alias propone ON', () => {
    const r = suggestKeywords('SELECT * FROM dbo.ORDINI o JOIN dbo.CLIENTI c ');
    assert.deepEqual(r.keywords, ['ON']);
    assert.equal(r.afterCompleteSource, true);
  });

  it('anche con AS, senza alias o mentre si scrive ON', () => {
    assert.deepEqual(kw('SELECT * FROM dbo.ORDINI AS o JOIN dbo.CLIENTI AS c '), ['ON']);
    assert.deepEqual(kw('SELECT * FROM dbo.ORDINI o JOIN dbo.CLIENTI '), ['ON']);
    assert.deepEqual(kw('SELECT * FROM dbo.ORDINI o JOIN dbo.CLIENTI c O'), ['ON']);
  });

  it('dopo FROM completo propone JOIN, WHERE, GROUP BY, ORDER BY', () => {
    const r = suggestKeywords('SELECT * FROM dbo.ORDINI o ');
    assert.ok(r.keywords.includes('LEFT JOIN'));
    assert.ok(r.keywords.includes('WHERE'));
    assert.ok(r.keywords.includes('ORDER BY'));
    assert.equal(r.afterCompleteSource, true);
  });

  it('mentre si scrive la tabella non propone parole chiave', () => {
    assert.deepEqual(suggestKeywords('SELECT * FROM ').keywords, []);
    assert.equal(suggestKeywords('SELECT * FROM ').afterCompleteSource, false);
    assert.deepEqual(kw('SELECT * FROM ORD'), []);
    assert.deepEqual(kw('SELECT * FROM dbo.'), []);
    assert.deepEqual(kw('SELECT * FROM dbo.ORDINI o, '), []);
  });

  it('LEFT, INNER, CROSS e LEFT OUTER completano il join', () => {
    assert.deepEqual(kw('SELECT * FROM dbo.ORDINI o LEFT '), ['JOIN', 'OUTER JOIN']);
    assert.deepEqual(kw('SELECT * FROM dbo.ORDINI o INNER '), ['JOIN']);
    assert.deepEqual(kw('SELECT * FROM dbo.ORDINI o CROSS '), ['JOIN', 'APPLY']);
    assert.deepEqual(kw('SELECT * FROM dbo.ORDINI o LEFT OUTER '), ['JOIN']);
  });

  it('dopo un predicato ON completo propone AND, OR e le clausole successive', () => {
    const r = kw('SELECT * FROM dbo.ORDINI o JOIN dbo.CLIENTI c ON o.ClienteId = c.Id ');
    assert.equal(r[0], 'AND');
    assert.ok(r.includes('WHERE'));
    assert.ok(r.includes('LEFT JOIN'));
  });

  it('ignora i suggerimenti dentro una sottoquery già chiusa', () => {
    assert.deepEqual(kw('SELECT * FROM (SELECT Id FROM dbo.T) x JOIN dbo.CLIENTI c '), ['ON']);
  });

  it('UPDATE, INSERT INTO e DELETE FROM', () => {
    assert.deepEqual(kw('UPDATE dbo.ORDINI '), ['SET']);
    assert.deepEqual(kw('INSERT INTO dbo.ORDINI (Id) '), ['VALUES', 'SELECT']);
    assert.deepEqual(kw('INSERT '), ['INTO']);
    assert.deepEqual(kw('DELETE FROM dbo.ORDINI '), ['WHERE']);
  });
});

describe('suggestKeywords — WHERE, ORDER BY, SELECT', () => {
  it('dopo un predicato completo propone AND, OR, GROUP BY, ORDER BY', () => {
    const r = kw('SELECT * FROM dbo.ORDINI o WHERE o.Id = 1 ');
    assert.deepEqual(r.slice(0, 2), ['AND', 'OR']);
    assert.ok(r.includes('ORDER BY'));
  });

  it('dopo una colonna propone gli operatori a parola', () => {
    assert.ok(kw('SELECT * FROM dbo.ORDINI o WHERE o.Id ').includes('IS NULL'));
  });

  it('IS, IS NOT, NOT', () => {
    assert.deepEqual(kw('SELECT * FROM dbo.T t WHERE t.X IS '), ['NULL', 'NOT NULL']);
    assert.deepEqual(kw('SELECT * FROM dbo.T t WHERE t.X IS NOT '), ['NULL']);
    assert.ok(kw('SELECT * FROM dbo.T t WHERE t.X NOT ').includes('IN'));
  });

  it('ORDER e GROUP completano con BY; dopo ORDER BY colonna ASC/DESC', () => {
    assert.deepEqual(kw('SELECT * FROM dbo.T t ORDER '), ['BY']);
    assert.deepEqual(kw('SELECT * FROM dbo.T t ORDER BY t.Id '), ['ASC', 'DESC']);
    assert.deepEqual(kw('SELECT t.Id FROM dbo.T t GROUP BY t.Id '), ['HAVING', 'ORDER BY']);
  });

  it('nella lista di SELECT propone FROM dopo un\'espressione', () => {
    assert.deepEqual(kw('SELECT '), ['DISTINCT', 'TOP']);
    assert.deepEqual(kw('SELECT o.Id '), ['FROM', 'INTO']);
    assert.deepEqual(kw('SELECT * '), ['FROM', 'INTO']);
    assert.deepEqual(kw('SELECT TOP 10 '), []);
  });

  it('commenti e stringhe non contano', () => {
    assert.deepEqual(kw("SELECT * FROM dbo.ORDINI o /* JOIN x */ JOIN dbo.CLIENTI c -- WHERE\n"), ['ON']);
  });
});

describe('suggestKeywords — keyword obbligatoria', () => {
  it('dopo ORDER, ALTER, LEFT può seguire solo una parola chiave', () => {
    assert.equal(suggestKeywords('SELECT * FROM dbo.T t ORDER ').keywordRequired, true);
    assert.equal(suggestKeywords('ALTER ').keywordRequired, true);
    assert.equal(suggestKeywords('SELECT * FROM dbo.T t LEFT ').keywordRequired, true);
    assert.ok(!suggestKeywords('SELECT * FROM dbo.T t ').keywordRequired);
  });
});
