import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyProcBodyIndentation } from '../ddlFormatter.js';
import type { SqlPromptStyleJson } from '../styleLoader.js';

const styleOn: SqlPromptStyleJson = { ddl: { indentClauses: true } };
const styleOff: SqlPromptStyleJson = { ddl: { indentClauses: false } };
const styleEmpty: SqlPromptStyleJson = {};

describe('applyProcBodyIndentation — disabled', () => {
    it('returns sql unchanged when indentClauses is false', () => {
        const sql = 'CREATE PROCEDURE dbo.P\n    (\n    @a INT\n    )\nAS\nSET NOCOUNT ON;';
        assert.equal(applyProcBodyIndentation(sql, styleOff, 4), sql);
    });

    it('returns sql unchanged when ddl config is absent', () => {
        const sql = 'CREATE PROCEDURE dbo.P\nAS\nSELECT 1;';
        assert.equal(applyProcBodyIndentation(sql, styleEmpty, 4), sql);
    });

    it('returns sql unchanged when there is no standalone AS', () => {
        const sql = 'SELECT col AS alias\nFROM t;';
        assert.equal(applyProcBodyIndentation(sql, styleOn, 4), sql);
    });
});

describe('applyProcBodyIndentation — indentClauses: true', () => {
    it('indents all lines after standalone AS by tabWidth', () => {
        const sql = 'CREATE PROCEDURE dbo.P\nAS\nSET NOCOUNT ON;\nRETURN 0;';
        const result = applyProcBodyIndentation(sql, styleOn, 4);
        assert.equal(
            result,
            'CREATE PROCEDURE dbo.P\nAS\n    SET NOCOUNT ON;\n    RETURN 0;',
        );
    });

    it('preserves blank lines between body statements', () => {
        const sql = 'CREATE PROCEDURE dbo.P\nAS\nSET NOCOUNT ON;\n\nRETURN 0;';
        const result = applyProcBodyIndentation(sql, styleOn, 4);
        assert.equal(
            result,
            'CREATE PROCEDURE dbo.P\nAS\n    SET NOCOUNT ON;\n\n    RETURN 0;',
        );
    });

    it('respects tabWidth when indenting', () => {
        const sql = 'CREATE PROCEDURE dbo.P\nAS\nSELECT 1;';
        const result = applyProcBodyIndentation(sql, styleOn, 2);
        assert.equal(result, 'CREATE PROCEDURE dbo.P\nAS\n  SELECT 1;');
    });

    it('does not indent the AS line itself', () => {
        const sql = 'PROC dbo.P\nAS\nSELECT 1;';
        const result = applyProcBodyIndentation(sql, styleOn, 4);
        const lines = result.split('\n');
        assert.equal(lines[1], 'AS');
    });

    it('already-indented body content gets additional indentation', () => {
        const sql = 'CREATE PROCEDURE dbo.P\nAS\nBEGIN\n    SELECT 1;\nEND;';
        const result = applyProcBodyIndentation(sql, styleOn, 4);
        assert.equal(
            result,
            'CREATE PROCEDURE dbo.P\nAS\n    BEGIN\n        SELECT 1;\n    END;',
        );
    });

    it('GO batch separator is placed at column 0 and stops body indentation', () => {
        const sql = 'CREATE PROCEDURE dbo.P\nAS\nRETURN 0;\nGO';
        const result = applyProcBodyIndentation(sql, styleOn, 4);
        const lines = result.split('\n');
        const goLine = lines.find(l => /^GO$/i.test(l.trim()));
        assert.ok(goLine !== undefined, 'GO line should be present');
        assert.equal(goLine, 'GO', 'GO must be at column 0');
    });
});
