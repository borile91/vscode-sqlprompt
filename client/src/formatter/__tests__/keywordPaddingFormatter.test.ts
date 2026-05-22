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
});
