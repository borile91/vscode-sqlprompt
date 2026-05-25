import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyDeclareFormatting } from '../declareFormatter.js';
import type { SqlPromptStyleJson } from '../styleLoader.js';

const styleOn: SqlPromptStyleJson = { lists: { placeCommasBeforeItems: true } };
const styleOff: SqlPromptStyleJson = { lists: { placeCommasBeforeItems: false } };
const styleEmpty: SqlPromptStyleJson = {};

describe('applyDeclareFormatting — disabled', () => {
    it('returns sql unchanged when placeCommasBeforeItems is false', () => {
        const sql = 'DECLARE @a INT,\n@b BIT;';
        assert.equal(applyDeclareFormatting(sql, styleOff), sql);
    });

    it('returns sql unchanged when lists config is absent', () => {
        const sql = 'DECLARE @a INT,\n@b BIT;';
        assert.equal(applyDeclareFormatting(sql, styleEmpty), sql);
    });
});

describe('applyDeclareFormatting — single variable', () => {
    it('leaves single-variable DECLARE unchanged', () => {
        const sql = 'DECLARE @msg VARCHAR(2048);';
        assert.equal(applyDeclareFormatting(sql, styleOn), sql);
    });
});

describe('applyDeclareFormatting — multi-variable', () => {
    it('formats two variables with comma-first style', () => {
        const sql = 'DECLARE @a INT,\n@b BIT;';
        const result = applyDeclareFormatting(sql, styleOn);
        const lines = result.split('\n');
        assert.equal(lines.length, 2);
        assert.match(lines[0], /^DECLARE @a /);
        assert.match(lines[1], /^\s+, @b /);
    });

    it('terminates last variable with semicolon', () => {
        const sql = 'DECLARE @a INT,\n@b BIT;';
        const result = applyDeclareFormatting(sql, styleOn);
        assert.ok(result.trimEnd().endsWith(';'), `expected semicolon at end, got: ${result}`);
        assert.equal((result.match(/;/g) ?? []).length, 1);
    });

    it('aligns type expressions of variables with different name lengths', () => {
        const sql = 'DECLARE @short INT,\n@longerName VARCHAR(10);';
        const result = applyDeclareFormatting(sql, styleOn);
        const lines = result.split('\n');
        // Find column where type starts on each line
        const typeColFirst = lines[0].indexOf('INT');
        const typeColSecond = lines[1].indexOf('VARCHAR');
        assert.equal(typeColFirst, typeColSecond, 'type columns should be aligned');
    });

    it('handles three variables and preserves default values', () => {
        const sql = 'DECLARE @a BIT = 0,\n@b INT,\n@c VARCHAR(5);';
        const result = applyDeclareFormatting(sql, styleOn);
        const lines = result.split('\n');
        assert.equal(lines.length, 3);
        // Default value must be present; type is padded for alignment so check
        // type and value separately.
        assert.ok(lines[0].includes('BIT') && lines[0].includes('= 0'));
        assert.ok(lines[1].includes('INT'));
        assert.ok(lines[2].includes('VARCHAR(5);'));
    });

    it('preserves leading indentation of DECLARE line', () => {
        const sql = '    DECLARE @a INT,\n@b BIT;';
        const result = applyDeclareFormatting(sql, styleOn);
        const lines = result.split('\n');
        assert.ok(lines[0].startsWith('    DECLARE'), 'first line should preserve indentation');
        assert.ok(lines[1].startsWith('    '), 'continuation should have matching indent');
    });

    it('does not produce double semicolons', () => {
        const sql = 'DECLARE @a INT,\n@b VARCHAR(5);';
        const result = applyDeclareFormatting(sql, styleOn);
        assert.ok(!result.includes(';;'), 'should not have double semicolons');
    });
});
