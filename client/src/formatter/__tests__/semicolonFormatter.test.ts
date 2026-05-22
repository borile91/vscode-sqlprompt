import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applySemicolonFormatting } from '../semicolonFormatter.js';
import type { SqlPromptStyleJson } from '../styleLoader.js';

function style(placement: 'none' | 'spaceBefore' | 'newLineBefore'): SqlPromptStyleJson {
    return { whitespace: { whiteSpaceBeforeSemiColon: placement } };
}

describe('applySemicolonFormatting — none (default)', () => {
    it('removes space before inline semicolon', () => {
        const result = applySemicolonFormatting('SELECT 1 ;', style('none'));
        assert.equal(result, 'SELECT 1;');
    });

    it('joins standalone semicolon line back to previous line', () => {
        const result = applySemicolonFormatting('SELECT 1\n;', style('none'));
        assert.equal(result, 'SELECT 1;');
    });

    it('leaves already-correct semicolon unchanged', () => {
        const result = applySemicolonFormatting('SELECT 1;', style('none'));
        assert.equal(result, 'SELECT 1;');
    });

    it('applies none when whiteSpaceBeforeSemiColon is not set', () => {
        const result = applySemicolonFormatting('SELECT 1 ;', {});
        assert.equal(result, 'SELECT 1;');
    });
});

describe('applySemicolonFormatting — spaceBefore', () => {
    it('adds a space before semicolon when none present', () => {
        const result = applySemicolonFormatting('SELECT 1;', style('spaceBefore'));
        assert.equal(result, 'SELECT 1 ;');
    });

    it('normalises multiple spaces before semicolon to one', () => {
        const result = applySemicolonFormatting('SELECT 1   ;', style('spaceBefore'));
        assert.equal(result, 'SELECT 1 ;');
    });

    it('joins standalone semicolon and adds space', () => {
        const result = applySemicolonFormatting('SELECT 1\n;', style('spaceBefore'));
        assert.equal(result, 'SELECT 1 ;');
    });
});

describe('applySemicolonFormatting — newLineBefore', () => {
    it('moves inline semicolon to a new line', () => {
        const result = applySemicolonFormatting('SELECT 1;', style('newLineBefore'));
        assert.equal(result, 'SELECT 1\n;');
    });

    it('moves semicolon with leading spaces to a new line', () => {
        const result = applySemicolonFormatting('SELECT 1 ;', style('newLineBefore'));
        assert.equal(result, 'SELECT 1\n;');
    });

    it('handles multiple statements', () => {
        const input = 'SELECT 1;\nPRINT 2;';
        const result = applySemicolonFormatting(input, style('newLineBefore'));
        assert.equal(result, 'SELECT 1\n;\nPRINT 2\n;');
    });
});
