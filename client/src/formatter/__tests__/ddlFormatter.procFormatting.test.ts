import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyDdlProcFormatting } from '../ddlFormatter.js';
import type { SqlPromptStyleJson } from '../styleLoader.js';

function style(firstParamOnNewLine: 'always' | 'never'): SqlPromptStyleJson {
    return { ddl: { placeFirstProcedureParameterOnNewLine: firstParamOnNewLine } };
}

describe('applyDdlProcFormatting — disabled', () => {
    it('returns sql unchanged when ddl config is absent', () => {
        const sql = 'CREATE PROCEDURE dbo.P (@a INT) AS';
        assert.equal(applyDdlProcFormatting(sql, {}, 4), sql);
    });
});

describe("applyDdlProcFormatting — placeFirstProcedureParameterOnNewLine: 'never'", () => {
    it('packs params greedy-inline and places AS on its own line', () => {
        const sql = 'CREATE PROCEDURE dbo.P (@a INT, @b VARCHAR(10)) AS';
        const result = applyDdlProcFormatting(sql, style('never'), 4);
        assert.equal(result, 'CREATE PROCEDURE dbo.P (@a INT, @b VARCHAR(10))\nAS');
    });

    it('wraps params at maxLineLen with continuation at lineIndent', () => {
        const longStyle: SqlPromptStyleJson = {
            ddl: { placeFirstProcedureParameterOnNewLine: 'never' },
            whitespace: { wrapLinesLongerThan: 30 },
        };
        const sql = 'CREATE PROCEDURE dbo.P (@a INT, @b VARCHAR(10), @c BIT) AS';
        const result = applyDdlProcFormatting(sql, longStyle, 4);
        const lines = result.split('\n');
        assert.ok(lines[0].startsWith('CREATE PROCEDURE dbo.P ('));
        assert.equal(lines[lines.length - 1], 'AS');
    });
});

describe('applyDdlProcFormatting — placeFirstProcedureParameterOnNewLine: always', () => {
    it('places opening paren and each param on its own line (comma-first)', () => {
        const sql = 'CREATE PROCEDURE dbo.P (@a INT, @b VARCHAR(10)) AS';
        const result = applyDdlProcFormatting(sql, style('always'), 4);
        const lines = result.split('\n');
        assert.equal(lines[0], 'CREATE PROCEDURE dbo.P');
        assert.equal(lines[1], '    (');
        assert.equal(lines[2], '    @a INT');
        assert.equal(lines[3], '  , @b VARCHAR(10)');
        assert.equal(lines[4], '    )');
        assert.equal(lines[5], 'AS');
    });

    it('handles a single parameter', () => {
        const sql = 'CREATE PROCEDURE dbo.P (@a INT) AS';
        const result = applyDdlProcFormatting(sql, style('always'), 4);
        const lines = result.split('\n');
        assert.equal(lines[0], 'CREATE PROCEDURE dbo.P');
        assert.equal(lines[1], '    (');
        assert.equal(lines[2], '    @a INT');
        assert.equal(lines[3], '    )');
        assert.equal(lines[4], 'AS');
    });

    it('handles types with nested parentheses', () => {
        const sql = 'CREATE PROCEDURE dbo.P (@a NUMERIC(12, 3), @b VARCHAR(50)) AS';
        const result = applyDdlProcFormatting(sql, style('always'), 4);
        const lines = result.split('\n');
        assert.equal(lines[2], '    @a NUMERIC(12, 3)');
        assert.equal(lines[3], '  , @b VARCHAR(50)');
    });

    it('handles params with default values containing string literals', () => {
        const sql = "CREATE PROCEDURE dbo.P (@a VARCHAR(50) = 'hello', @b INT = 0) AS";
        const result = applyDdlProcFormatting(sql, style('always'), 4);
        const lines = result.split('\n');
        assert.equal(lines[2], "    @a VARCHAR(50) = 'hello'");
        assert.equal(lines[3], '  , @b INT = 0');
    });

    it('handles FUNCTION keyword', () => {
        const sql = 'CREATE FUNCTION dbo.F (@a INT) RETURNS INT AS';
        const result = applyDdlProcFormatting(sql, style('always'), 4);
        assert.ok(result.startsWith('CREATE FUNCTION dbo.F\n    (\n    @a INT\n    )\nRETURNS INT AS'));
    });

    it('handles multi-line sql-formatter output with comment-bearing param', () => {
        // sql-formatter splits params to multiple lines when there are comments
        const sql = [
            'CREATE PROCEDURE dbo.P (',
            '    @a INT,',
            '    @b BIT -- some flag',
            ',',
            '    @c VARCHAR(10)',
            ') AS',
        ].join('\n');
        const result = applyDdlProcFormatting(sql, style('always'), 4);
        const lines = result.split('\n');
        assert.equal(lines[0], 'CREATE PROCEDURE dbo.P');
        assert.equal(lines[1], '    (');
        assert.equal(lines[2], '    @a INT');
        assert.equal(lines[3], '  , @b BIT -- some flag');
        assert.equal(lines[4], '  , @c VARCHAR(10)');
        assert.equal(lines[5], '    )');
        assert.equal(lines[6], 'AS');
    });

    it('uses tabWidth to compute indentation', () => {
        const sql = 'CREATE PROCEDURE dbo.P (@a INT, @b INT) AS';
        const result2 = applyDdlProcFormatting(sql, style('always'), 2);
        const lines2 = result2.split('\n');
        assert.equal(lines2[1], '  (');   // tabWidth=2
        assert.equal(lines2[2], '  @a INT');
        assert.equal(lines2[3], ', @b INT'); // commaIndent = max(0, 2-2) = 0
    });
});
