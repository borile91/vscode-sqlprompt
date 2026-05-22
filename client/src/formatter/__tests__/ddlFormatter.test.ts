import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyDdlFormatting } from '../ddlFormatter.js';
import type { SqlPromptStyleJson } from '../styleLoader.js';

function style(alignDataTypes: boolean): SqlPromptStyleJson {
    return { ddl: { verticallyAlignDataTypes: alignDataTypes } };
}

describe('applyDdlFormatting — verticallyAlignDataTypes: false', () => {
    it('returns sql unchanged when feature is disabled', () => {
        const sql = 'CREATE TABLE dbo.T\n(\nOrderID INT NOT NULL\n, OrderDate DATETIME NOT NULL\n)';
        assert.equal(applyDdlFormatting(sql, style(false)), sql);
    });

    it('returns sql unchanged when ddl config is absent', () => {
        const sql = 'CREATE TABLE dbo.T\n(\nOrderID INT NOT NULL\n)';
        assert.equal(applyDdlFormatting(sql, {}), sql);
    });
});

describe('applyDdlFormatting — verticallyAlignDataTypes: true', () => {
    it('aligns data types to the longest column name', () => {
        // All defs use leading-comma style (consistent prefix width)
        const input = [
            'CREATE TABLE dbo.T',
            '      (',
            '      OrderID INT NOT NULL',
            '    , OrderDate DATETIME NOT NULL',
            '    , Note VARCHAR(100) NULL',
            '      )',
        ].join('\n');

        const result = applyDdlFormatting(input, style(true));
        const lines = result.split('\n');

        // The data type column = max(prefix + name) + 1 space across all defs.
        // prefix lengths: '      ' = 6, '    , ' = 6
        // name lengths: 'OrderID'=7, 'OrderDate'=9, 'Note'=4
        // max(6+7, 6+9, 6+4) = 15; data type col = 16
        const intLine = lines.find(l => /INT\b/.test(l) && l.includes('OrderID'));
        const dtLine = lines.find(l => /DATETIME/.test(l));
        const varLine = lines.find(l => /VARCHAR/.test(l));

        assert.ok(intLine && dtLine && varLine, 'should have all three definition lines');
        const intCol = intLine!.indexOf('INT');
        const dtCol = dtLine!.indexOf('DATETIME');
        const varCol = varLine!.indexOf('VARCHAR');
        assert.equal(intCol, dtCol, `INT at ${intCol}, DATETIME at ${dtCol}`);
        assert.equal(dtCol, varCol, `DATETIME at ${dtCol}, VARCHAR at ${varCol}`);
    });

    it('handles leading-comma style column definitions', () => {
        const input = [
            'CREATE TABLE dbo.T',
            '      (',
            '      OrderID   INT      NOT NULL',
            '    , OrderDate DATETIME NOT NULL',
            '      )',
        ].join('\n');

        const result = applyDdlFormatting(input, style(true));
        const lines = result.split('\n');

        // Both INT and DATETIME should start at the same column
        const intLine = lines.find(l => l.includes('INT'));
        const dtLine = lines.find(l => l.includes('DATETIME'));
        assert.ok(intLine && dtLine);

        const intCol = intLine!.indexOf('INT');
        const dtCol = dtLine!.indexOf('DATETIME');
        assert.equal(intCol, dtCol, `INT at ${intCol}, DATETIME at ${dtCol}`);
    });

    it('leaves constraint lines unchanged', () => {
        const input = [
            'CREATE TABLE dbo.T',
            '    (',
            '    ID INT NOT NULL',
            '    CONSTRAINT PK_T PRIMARY KEY (ID)',
            '    )',
        ].join('\n');

        const result = applyDdlFormatting(input, style(true));
        assert.ok(result.includes('CONSTRAINT PK_T PRIMARY KEY (ID)'), 'constraint line should be unchanged');
    });

    it('only processes CREATE TABLE blocks, not SELECT', () => {
        const input = 'SELECT a INT FROM t';
        const result = applyDdlFormatting(input, style(true));
        assert.equal(result, input);
    });
});
