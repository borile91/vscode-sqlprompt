import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyLeadingCommaFormat } from '../listFormatter.js';
import type { SqlPromptStyleJson } from '../styleLoader.js';

const styleOn: SqlPromptStyleJson = {
    lists: { placeCommasBeforeItems: true, alignComments: false },
};

const styleOff: SqlPromptStyleJson = {
    lists: { placeCommasBeforeItems: false },
};

describe('applyLeadingCommaFormat — placeCommasBeforeItems: false', () => {
    it('returns sql unchanged when feature is disabled', () => {
        const sql = 'SELECT a,\n       b\nFROM   t';
        assert.equal(applyLeadingCommaFormat(sql, styleOff), sql);
    });
});

describe('applyLeadingCommaFormat — trailing-comma style input', () => {
    it('converts trailing commas to leading commas', () => {
        const input = 'SELECT a,\n       b,\n       c\nFROM   t';
        const result = applyLeadingCommaFormat(input, styleOn);
        assert.equal(
            result,
            'SELECT a\n     , b\n     , c\nFROM   t',
        );
    });

    it('preserves inline comments on items', () => {
        const input = 'SELECT a, -- first\n       b\nFROM   t';
        const result = applyLeadingCommaFormat(input, styleOn);
        assert.ok(result.includes('SELECT a -- first'));
        assert.ok(result.includes(', b'));
    });
});

describe('applyLeadingCommaFormat — alignComments', () => {
    it('aligns trailing comments when alignComments is true', () => {
        const styleAligned: SqlPromptStyleJson = {
            lists: { placeCommasBeforeItems: true, alignComments: true },
        };
        const input = 'SELECT a, -- short\n       longColumnName -- long\nFROM   t';
        const result = applyLeadingCommaFormat(input, styleAligned);
        // 'a' should be padded to match 'longColumnName' length
        const lines = result.split('\n');
        const firstItem = lines[0]; // SELECT line
        const secondItem = lines[1]; // leading comma line
        // both comments should start at the same column
        assert.ok(firstItem.indexOf('--') === secondItem.indexOf('--'));
    });
});

describe('applyLeadingCommaFormat — ORDER BY lists', () => {
    it('applies leading commas to ORDER BY list', () => {
        // sql-formatter tabularLeft output: "ORDER BY col1,\n         col2"
        const input = 'SELECT a\nFROM   t\nORDER BY a,\n         b';
        const result = applyLeadingCommaFormat(input, styleOn);
        const lines = result.split('\n');
        assert.ok(lines[2].startsWith('ORDER BY a'), `line 2: ${lines[2]}`);
        assert.ok(lines[3].includes(', b'), `line 3: ${lines[3]}`);
    });

    it('stops ORDER BY collection at next clause', () => {
        const input = 'ORDER BY a,\n         b\nFROM   t';
        const result = applyLeadingCommaFormat(input, styleOn);
        const lines = result.split('\n');
        // FROM should remain intact
        assert.ok(lines.some(l => l.startsWith('FROM')));
    });
});

describe('applyLeadingCommaFormat — GROUP BY lists', () => {
    it('applies leading commas to GROUP BY list', () => {
        const input = 'SELECT a, b\nFROM   t\nGROUP BY a,\n         b';
        const result = applyLeadingCommaFormat(input, styleOn);
        const lines = result.split('\n');
        const gbLine = lines.findIndex(l => l.startsWith('GROUP BY'));
        assert.ok(gbLine >= 0);
        assert.ok(lines[gbLine].startsWith('GROUP BY a'), `gbLine: ${lines[gbLine]}`);
        assert.ok(lines[gbLine + 1].includes(', b'), `next: ${lines[gbLine + 1]}`);
    });
});

describe('applyLeadingCommaFormat — alignAliases', () => {
    it('aligns AS aliases when alignAliases is true', () => {
        const styleAligned: SqlPromptStyleJson = {
            lists: { placeCommasBeforeItems: true, alignAliases: true },
        };
        const input = 'SELECT TerritoryID AS ID,\n       Name AS TerritoryName,\n       SalesYTD AS YTD\nFROM   t';
        const result = applyLeadingCommaFormat(input, styleAligned);
        const lines = result.split('\n');
        // Find column of 'AS' in each item
        const asPositions = lines
            .filter(l => l.includes(' AS '))
            .map(l => l.indexOf(' AS '));
        // All AS should start at the same column
        assert.ok(asPositions.length >= 2);
        assert.ok(asPositions.every(pos => pos === asPositions[0]), `AS positions: ${asPositions}`);
    });

    it('does not align aliases when alignAliases is false', () => {
        const input = 'SELECT TerritoryID AS ID,\n       Name AS TerritoryName\nFROM   t';
        const result = applyLeadingCommaFormat(input, styleOn);
        // aliases should remain as-is (not padded)
        assert.ok(result.includes('TerritoryID AS ID'));
        assert.ok(result.includes('Name AS TerritoryName'));
    });
});

