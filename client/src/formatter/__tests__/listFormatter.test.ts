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
