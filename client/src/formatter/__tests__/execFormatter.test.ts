import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyExecParamFormatting } from '../execFormatter.js';
import type { SqlPromptStyleJson } from '../styleLoader.js';

const styleOn: SqlPromptStyleJson = { lists: { placeCommasBeforeItems: true } };
const styleOff: SqlPromptStyleJson = { lists: { placeCommasBeforeItems: false } };
const styleEmpty: SqlPromptStyleJson = {};

describe('applyExecParamFormatting — disabled', () => {
    it('returns sql unchanged when placeCommasBeforeItems is false', () => {
        const sql = 'EXEC p @a = 1,\n@b = 2;';
        assert.equal(applyExecParamFormatting(sql, styleOff), sql);
    });

    it('returns sql unchanged when lists config is absent', () => {
        const sql = 'EXEC p @a = 1,\n@b = 2;';
        assert.equal(applyExecParamFormatting(sql, styleEmpty), sql);
    });
});

describe('applyExecParamFormatting — single parameter', () => {
    it('leaves single-param EXEC unchanged', () => {
        const sql = 'EXEC p @a = 1;';
        assert.equal(applyExecParamFormatting(sql, styleOn), sql);
    });
});

describe('applyExecParamFormatting — multi-parameter', () => {
    it('formats two parameters with comma-first style', () => {
        const sql = 'EXEC mySchema.myProc @a = 1,\n@b = 2;';
        const result = applyExecParamFormatting(sql, styleOn);
        const lines = result.split('\n');
        assert.equal(lines.length, 2);
        assert.ok(lines[0].startsWith('EXEC mySchema.myProc @a = 1'), `got: ${lines[0]}`);
        assert.ok(lines[1].includes(', @b = 2'), `got: ${lines[1]}`);
    });

    it('aligns continuation params to first param column', () => {
        const sql = 'EXEC dbo.Test @first = 1,\n@second = 2,\n@third = 3;';
        const result = applyExecParamFormatting(sql, styleOn);
        const lines = result.split('\n');
        // "EXEC dbo.Test " = 14 chars -> param starts at col 14
        const firstParamCol = lines[0].indexOf('@first');
        const secondParamCol = lines[1].indexOf('@second');
        const thirdParamCol = lines[2].indexOf('@third');
        assert.equal(secondParamCol, firstParamCol, 'second param should align with first');
        assert.equal(thirdParamCol, firstParamCol, 'third param should align with first');
    });

    it('places comma two columns before the param', () => {
        const sql = 'EXEC dbo.Test @a = 1,\n@b = 2;';
        const result = applyExecParamFormatting(sql, styleOn);
        const lines = result.split('\n');
        const paramCol = lines[0].indexOf('@a');
        // Comma should be at paramCol - 2
        assert.equal(lines[1].charAt(paramCol - 2), ',', `expected comma at col ${paramCol - 2}`);
    });

    it('preserves semicolon on the last parameter without doubling', () => {
        const sql = 'EXEC p @a = 1,\n@b = val;';
        const result = applyExecParamFormatting(sql, styleOn);
        assert.ok(result.trimEnd().endsWith(';'), 'should end with semicolon');
        assert.equal((result.match(/;/g) ?? []).length, 1, 'should not duplicate semicolon');
    });

    it('handles EXECUTE keyword', () => {
        const sql = 'EXECUTE dbo.Test @a = 1,\n@b = 2;';
        const result = applyExecParamFormatting(sql, styleOn);
        assert.ok(result.startsWith('EXECUTE dbo.Test @a = 1'), `got: ${result.split('\n')[0]}`);
        assert.ok(result.includes(', @b = 2'), 'should have comma-first second param');
    });

    it('preserves leading indentation from the EXEC line', () => {
        const sql = '    EXEC p @a = 1,\n@b = 2;';
        const result = applyExecParamFormatting(sql, styleOn);
        const lines = result.split('\n');
        assert.ok(lines[0].startsWith('    EXEC'), 'should preserve indentation');
    });
});
