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
    const text = '\nGOTO label\nSELECT 1';
    const bounds = findStatementBoundaries(text);
    assert.equal(bounds.length, 1);
  });

  it('does not split on GO inside identifier context (mid-line)', () => {
    // "ALGO" contains "GO" but is not at line start
    const text = 'SELECT ALGO FROM t';
    const bounds = findStatementBoundaries(text);
    assert.equal(bounds.length, 1);
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
