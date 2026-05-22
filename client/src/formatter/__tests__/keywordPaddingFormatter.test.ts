import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyKeywordRePadding } from '../keywordPaddingFormatter.js';

describe('applyKeywordRePadding', () => {
    it('collapses SELECT/FROM block to 7-char keyword width', () => {
        // sql-formatter tabularLeft uses 10-char keyword column (ORDER BY + 2 spaces)
        const input = 'SELECT    a, b\nFROM      t';
        const result = applyKeywordRePadding(input);
        assert.equal(result, 'SELECT a, b\nFROM   t');
    });

    it('uses 9-char width when INTERSECT is present', () => {
        const input = 'SELECT    a\nFROM      t\nINTERSECT a\nSELECT    b\nFROM      u';
        const result = applyKeywordRePadding(input);
        assert.equal(result, 'SELECT    a\nFROM      t\nINTERSECT a\nSELECT    b\nFROM      u');
    });

    it('uses ORDER BY width (9) when ORDER BY is present', () => {
        const input = 'SELECT    a\nFROM      t\nORDER BY  a';
        const result = applyKeywordRePadding(input);
        assert.equal(result, 'SELECT   a\nFROM     t\nORDER BY a');
    });

    it('processes each blank-line-separated block independently', () => {
        const block1 = 'SELECT    a\nFROM      t';
        const block2 = 'SELECT    b\nFROM      u\nWHERE     x = 1';
        const input = block1 + '\n\n' + block2;
        const result = applyKeywordRePadding(input);
        // block1: SELECT(6)+1=7, block2: SELECT(6)+1=7 — same as WHERE(5)+1=6 < SELECT(6)+1
        assert.ok(result.includes('SELECT a'));
        assert.ok(result.includes('SELECT b'));
    });

    it('re-pads continuation lines alongside keyword lines', () => {
        // Continuation line has oldWidth (10) leading spaces at indent level 0
        const input = 'SELECT    a,\n          b\nFROM      t';
        const result = applyKeywordRePadding(input);
        // keyword width becomes 7, continuation line also gets 7 leading spaces
        assert.ok(result.startsWith('SELECT a,\n       b\nFROM   t'));
    });

    it('does not count LEFT JOIN in keyword width — SELECT gets 1 space', () => {
        const input = 'SELECT    a\nFROM      t1\nLEFT JOIN t2 ON t1.id = t2.id\nWHERE     x = 1';
        const result = applyKeywordRePadding(input);
        // Without LEFT JOIN in max, newWidth = SELECT(6)+1 = 7
        assert.ok(result.startsWith('SELECT a\nFROM   t1'), `got: ${result.split('\n')[0]}`);
    });

    it('moves LEFT JOIN to the content column (FROM content column)', () => {
        const input = 'SELECT    a\nFROM      t1\nLEFT JOIN t2 ON t1.id = t2.id';
        const result = applyKeywordRePadding(input);
        const lines = result.split('\n');
        // FROM width = 7, so content at col 7. LEFT JOIN should be at col 7.
        assert.ok(lines[2].startsWith('       LEFT JOIN'), `got: "${lines[2]}"`);
    });

    it('moves AND to the content column of its parent clause', () => {
        const input = 'SELECT    a\nFROM      t\nWHERE     x = 1\nAND       y = 2';
        const result = applyKeywordRePadding(input);
        const lines = result.split('\n');
        // WHERE width = 7 (SELECT=6 max), so content at col 7. AND should be at col 7.
        assert.ok(lines[3].startsWith('       AND y = 2'), `got: "${lines[3]}"`);
    });

    it('moves OR to the content column', () => {
        const input = 'SELECT    a\nFROM      t\nWHERE     x = 1\nOR        y = 2';
        const result = applyKeywordRePadding(input);
        const lines = result.split('\n');
        assert.ok(lines[3].startsWith('       OR '), `got: "${lines[3]}"`);
    });

    it('AND does not inflate keyword width when alone with WHERE', () => {
        const input = 'WHERE     x = 1\nAND       y = 2\nAND       z = 3';
        const result = applyKeywordRePadding(input);
        const lines = result.split('\n');
        // WHERE(5) → newWidth=6. AND moves to col 6, not col 10.
        assert.ok(lines[0].startsWith('WHERE '), `got: "${lines[0]}"`);
        assert.ok(lines[1].startsWith('      AND '), `got: "${lines[1]}"`);
    });
});
