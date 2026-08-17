import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractStatementAtOffset, findStatementBoundaries } from '../documentTextService.js';

// ── boundary finding ──────────────────────────────────────────────────────────

describe('findStatementBoundaries — semicolons', () => {
  it('single statement no semicolon', () => {
    const bounds = findStatementBoundaries('SELECT 1');
    assert.deepEqual(bounds, [0]);
  });

  it('two semicolon-terminated statements', () => {
    const bounds = findStatementBoundaries('SELECT 1; SELECT 2;');
    // ';' is at index 8 → next statement starts at 9
    // second ';' is at index 18 → boundary at 19
    assert.deepEqual(bounds, [0, 9, 19]);
  });

  it('does not split inside string', () => {
    const bounds = findStatementBoundaries("SELECT 'a;b'");
    assert.deepEqual(bounds, [0]);
  });

  it('does not split inside block comment', () => {
    const bounds = findStatementBoundaries('/* a;b */ SELECT 1');
    assert.deepEqual(bounds, [0]);
  });

  it('does not split inside quoted identifier', () => {
    const bounds = findStatementBoundaries('SELECT [a;b] FROM t');
    assert.deepEqual(bounds, [0]);
  });
});

describe('findStatementBoundaries — GO separator', () => {
  it('splits on GO at start of line', () => {
    const text = 'SELECT 1\nGO\nSELECT 2';
    const bounds = findStatementBoundaries(text);
    assert.ok(bounds.length >= 2, `Expected at least 2 boundaries, got ${bounds.length}`);
    // Second boundary should start after GO\n
    assert.equal(text.slice(bounds[1]).trimStart().startsWith('SELECT 2'), true);
  });

  it('does not split on GOTO keyword', () => {
    const text = 'SELECT 1\nGOTO label';
    const bounds = findStatementBoundaries(text);
    assert.equal(bounds.length, 1);
  });

  it('does not split on GO inside identifier context (mid-line)', () => {
    // "ALGO" contains "GO" but is not at line start
    const text = 'SELECT ALGO FROM t';
    const bounds = findStatementBoundaries(text);
    assert.equal(bounds.length, 1);
  });

  it('splits on an indented GO', () => {
    const text = 'SELECT 1\n   GO\nSELECT 2';
    const bounds = findStatementBoundaries(text);
    assert.equal(bounds.length, 2);
    assert.equal(text.slice(bounds[1]), 'SELECT 2');
  });
});

// ── implicit boundaries (issue #12) ───────────────────────────────────────────

describe('findStatementBoundaries — unterminated statements', () => {
  it('splits before a line-initial SELECT', () => {
    const text = 'SELECT * FROM Orders\nSELECT * FROM Customers';
    const bounds = findStatementBoundaries(text);
    assert.deepEqual(bounds, [0, text.indexOf('SELECT * FROM Customers')]);
  });

  it('splits before UPDATE / DELETE / EXEC', () => {
    const text = 'SELECT 1\nUPDATE t SET a = 1\nDELETE FROM t\nEXEC dbo.Proc';
    const bounds = findStatementBoundaries(text);
    assert.deepEqual(bounds, [
      0,
      text.indexOf('UPDATE'),
      text.indexOf('DELETE'),
      text.indexOf('EXEC'),
    ]);
  });

  it('does not split a statement spread over several lines', () => {
    const text = 'SELECT a, b\nFROM Orders o\nWHERE o.Id = 1';
    assert.deepEqual(findStatementBoundaries(text), [0]);
  });

  it('does not split a UNION', () => {
    const text = 'SELECT a FROM t1\nUNION ALL\nSELECT a FROM t2';
    assert.deepEqual(findStatementBoundaries(text), [0]);
  });

  it('does not split INSERT … SELECT', () => {
    const text = 'INSERT INTO dbo.Target\nSELECT * FROM dbo.Source';
    assert.deepEqual(findStatementBoundaries(text), [0]);
  });

  it('does not split INSERT with a column list followed by SELECT', () => {
    const text = 'INSERT INTO dbo.Target (a, b)\nSELECT a, b FROM dbo.Source';
    assert.deepEqual(findStatementBoundaries(text), [0]);
  });

  it('does not split the main query of a CTE', () => {
    const text = 'WITH c AS (\n  SELECT 1 AS x\n)\nSELECT * FROM c';
    assert.deepEqual(findStatementBoundaries(text), [0]);
  });

  it('does not split a subquery', () => {
    const text = 'SELECT *\nFROM t\nWHERE Id IN (\nSELECT Id FROM u\n)';
    assert.deepEqual(findStatementBoundaries(text), [0]);
  });

  it('does not split MERGE actions', () => {
    const text =
      'MERGE dbo.T AS t\nUSING dbo.S AS s ON t.Id = s.Id\n' +
      'WHEN MATCHED THEN\nUPDATE SET t.a = s.a\n' +
      'WHEN NOT MATCHED THEN\nINSERT (a) VALUES (s.a);';
    const bounds = findStatementBoundaries(text);
    assert.deepEqual(bounds, [0, text.length]);
  });

  it('does not treat a table hint as a CTE preamble', () => {
    const text = 'SELECT * FROM dbo.T\nWITH (NOLOCK)';
    assert.deepEqual(findStatementBoundaries(text), [0]);
  });

  it('does not split inside a string or comment', () => {
    const text = "SELECT 'x\nSELECT y'\n-- SELECT z\n/*\nSELECT w\n*/";
    assert.deepEqual(findStatementBoundaries(text), [0]);
  });

  it('does not add a duplicate boundary after a semicolon', () => {
    const text = 'SELECT 1;\nSELECT 2';
    const bounds = findStatementBoundaries(text);
    // The ';' already opened the new statement — the line-initial SELECT
    // must not add a second boundary one character later.
    assert.deepEqual(bounds, [0, text.indexOf(';') + 1]);
  });

  it('keeps the CREATE PROCEDURE header attached to its body', () => {
    const text = 'CREATE PROCEDURE dbo.P\nAS\nBEGIN\n  SELECT 1\nEND';
    assert.deepEqual(findStatementBoundaries(text), [0]);
  });

  it('scopes completion to the statement under the cursor', () => {
    const text = 'SELECT * FROM Orders o\nSELECT  FROM Customers c';
    const cursor = text.indexOf('SELECT  FROM') + 7;
    const result = extractStatementAtOffset(text, cursor);
    assert.ok(!result.text.includes('Orders'), `Got: "${result.text}"`);
    assert.equal(result.start, text.indexOf('SELECT  FROM'));
  });
});

// ── extractStatementAtOffset ──────────────────────────────────────────────────

describe('extractStatementAtOffset', () => {
  it('returns full text for single statement', () => {
    const text = 'SELECT 1';
    const result = extractStatementAtOffset(text, 4);
    assert.equal(result.text, 'SELECT 1');
    assert.equal(result.start, 0);
    assert.equal(result.cursorOffset, 4);
  });

  it('returns first of two semicolon-delimited statements', () => {
    const text = 'SELECT 1; SELECT 2';
    const result = extractStatementAtOffset(text, 4);
    // Statement slice runs from 0 to the next boundary (9), so it includes the ';'
    assert.ok(result.text.includes('SELECT 1'), `Expected text to include 'SELECT 1', got: "${result.text}"`);
    assert.ok(!result.text.includes('SELECT 2'), 'Should not include second statement');
    assert.equal(result.start, 0);
  });

  it('returns second of two semicolon-delimited statements', () => {
    const text = 'SELECT 1; SELECT 2';
    const result = extractStatementAtOffset(text, 14);
    assert.ok(result.text.includes('SELECT 2'), `Got: "${result.text}"`);
    // Boundary after ';' at index 8 is 9, so second statement starts at 9
    assert.equal(result.start, 9);
    // cursorOffset = 14 - 9 = 5
    assert.equal(result.cursorOffset, 5);
  });

  it('correct cursorOffset is relative to statement start', () => {
    const text = 'SELECT 1; SELECT col FROM t';
    // ';' at index 8 → second statement starts at 9
    const result = extractStatementAtOffset(text, 18);
    assert.equal(result.start, 9);
    assert.equal(result.cursorOffset, 18 - 9); // 9
  });

  it('handles cursor at end of text', () => {
    const text = 'SELECT 1';
    const result = extractStatementAtOffset(text, text.length);
    assert.equal(result.end, text.length);
  });

  it('handles multi-batch GO document', () => {
    const text = 'SELECT 1\nGO\nSELECT 2';
    const secondBatchOffset = text.indexOf('SELECT 2');
    const result = extractStatementAtOffset(text, secondBatchOffset + 3);
    assert.ok(result.text.includes('SELECT 2'), `Expected "SELECT 2", got "${result.text}"`);
    assert.ok(!result.text.includes('SELECT 1'));
  });
});
