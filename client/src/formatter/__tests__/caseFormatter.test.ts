import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyCaseFormatting } from '../caseFormatter.js';
import type { SqlPromptStyleJson } from '../styleLoader.js';

const TAB = 4;

function testStyle(): SqlPromptStyleJson {
    return {
        caseExpressions: {
            placeFirstWhenOnNewLine: 'ifInputExpression',
            whenAlignment: 'toFirstItem',
            alignElseToWhen: true,
            placeElseOnNewLine: true,
            placeEndOnNewLine: true,
            endAlignment: 'toCase',
        },
    };
}

describe('applyCaseFormatting — no caseExpressions config', () => {
    it('returns sql unchanged when caseExpressions is not configured', () => {
        const sql = 'SELECT CASE x WHEN 1 THEN 2 ELSE 3 END';
        assert.equal(applyCaseFormatting(sql, {}, TAB), sql);
    });
});

describe('applyCaseFormatting — placeFirstWhenOnNewLine: ifInputExpression', () => {
    it('places first WHEN on new line for simple CASE (has input expression)', () => {
        // Simple CASE: CASE Status WHEN 1 THEN …
        const input = "SELECT CASE Status WHEN 1 THEN 'Active' WHEN 2 THEN 'Inactive' ELSE 'Unknown' END AS Label";
        const result = applyCaseFormatting(input, testStyle(), TAB);
        const lines = result.split('\n');

        // First line should end with CASE Status
        assert.ok(lines[0].includes('CASE Status'), `line 0: ${lines[0]}`);
        // WHEN should be on its own line
        assert.ok(lines.some(l => l.trim().startsWith('WHEN 1')), `no WHEN 1 line`);
    });

    it('keeps first WHEN inline for searched CASE (no input expression)', () => {
        // Searched CASE: CASE WHEN x > 0 THEN …
        const input = "SELECT CASE WHEN x > 0 THEN 'Pos' ELSE 'Neg' END";
        const result = applyCaseFormatting(input, testStyle(), TAB);
        const lines = result.split('\n');
        // CASE WHEN should remain on the same line
        assert.ok(lines[0].includes('CASE') && lines[0].includes('WHEN'), `line 0: ${lines[0]}`);
    });
});

describe('applyCaseFormatting — placeElseOnNewLine: true', () => {
    it('places ELSE on a new line', () => {
        const input = "SELECT CASE x WHEN 1 THEN 'A' ELSE 'B' END";
        const result = applyCaseFormatting(input, testStyle(), TAB);
        const lines = result.split('\n');
        assert.ok(lines.some(l => l.trim().startsWith('ELSE')), 'ELSE should be on its own line');
    });
});

describe('applyCaseFormatting — placeEndOnNewLine: true + endAlignment: toCase', () => {
    it('places END on a new line aligned to CASE column', () => {
        const input = "SELECT CASE x WHEN 1 THEN 'A' END";
        const result = applyCaseFormatting(input, testStyle(), TAB);
        const lines = result.split('\n');
        const endLine = lines.find(l => l.trim().startsWith('END'));
        assert.ok(endLine !== undefined, 'END should be on its own line');
        // CASE is at column 7 (after "SELECT "), so END should also be at 7
        const caseCol = input.indexOf('CASE');
        assert.equal(endLine!.indexOf('END'), caseCol, `endLine: ${JSON.stringify(endLine)}`);
    });
});

describe('applyCaseFormatting — placeFirstWhenOnNewLine: always', () => {
    it('always places first WHEN on new line regardless of CASE type', () => {
        const style: SqlPromptStyleJson = {
            caseExpressions: {
                placeFirstWhenOnNewLine: 'always',
                whenAlignment: 'toCase',
                placeElseOnNewLine: false,
                placeEndOnNewLine: false,
                endAlignment: 'toCase',
            },
        };
        // Searched CASE (no input expression) should still get WHEN on new line
        const input = "SELECT CASE WHEN x > 0 THEN 'P' ELSE 'N' END";
        const result = applyCaseFormatting(input, style, TAB);
        const lines = result.split('\n');
        assert.ok(lines.length > 1, 'should have multiple lines');
        assert.ok(lines.some(l => l.trim().startsWith('WHEN')), 'WHEN should be on its own line');
    });
});

describe('applyCaseFormatting — lines without CASE are unchanged', () => {
    it('passes through non-CASE lines untouched', () => {
        const sql = 'SELECT a, b\nFROM t\nWHERE x = 1';
        const result = applyCaseFormatting(sql, testStyle(), TAB);
        assert.equal(result, sql);
    });
});
