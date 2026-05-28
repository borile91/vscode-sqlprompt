import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyJoinOnFormatting } from '../joinFormatter.js';
import type { SqlPromptStyleJson } from '../styleLoader.js';

const TAB = 4;

function style(
    placeOnNewLine: boolean,
    keywordAlignment: 'indented' | 'toJoin' | 'toTable' = 'indented',
): SqlPromptStyleJson {
    return {
        joinStatements: {
            on: { placeOnNewLine, keywordAlignment },
        },
    };
}

describe('applyJoinOnFormatting — placeOnNewLine: false', () => {
    it('returns sql unchanged', () => {
        const sql = 'FROM t\nINNER JOIN u ON t.id = u.id';
        assert.equal(applyJoinOnFormatting(sql, style(false), TAB), sql);
    });
});

describe('applyJoinOnFormatting — placeOnNewLine: true, keywordAlignment: indented', () => {
    it('splits inline ON onto a new indented line', () => {
        const input = 'FROM t\nINNER JOIN u ON t.id = u.id';
        const result = applyJoinOnFormatting(input, style(true, 'indented'), TAB);
        const lines = result.split('\n');
        assert.equal(lines[0], 'FROM t');
        assert.equal(lines[1], 'INNER JOIN u');
        // ON at indent 0 + tabWidth = 4
        assert.equal(lines[2], '    ON t.id = u.id');
    });

    it('handles JOIN with leading indent', () => {
        const input = '    INNER JOIN u ON t.id = u.id';
        const result = applyJoinOnFormatting(input, style(true, 'indented'), TAB);
        const lines = result.split('\n');
        assert.equal(lines[0], '    INNER JOIN u');
        // ON at 4 (joinIndent) + 4 (tabWidth) = 8
        assert.equal(lines[1], '        ON t.id = u.id');
    });

    it('leaves existing ON-on-new-line at correct indent', () => {
        const input = 'INNER JOIN u\n   ON t.id = u.id';
        const result = applyJoinOnFormatting(input, style(true, 'indented'), TAB);
        const lines = result.split('\n');
        assert.equal(lines[0], 'INNER JOIN u');
        // ON re-placed at 0 + 4 = 4
        assert.equal(lines[1], '    ON t.id = u.id');
    });
});

describe('applyJoinOnFormatting — keywordAlignment: toJoin', () => {
    it('places ON at the same indent as JOIN keyword', () => {
        const input = 'INNER JOIN u ON t.id = u.id';
        const result = applyJoinOnFormatting(input, style(true, 'toJoin'), TAB);
        const lines = result.split('\n');
        // JOIN at indent 0 → ON at 0
        assert.equal(lines[1], 'ON t.id = u.id');
    });
});

describe('applyJoinOnFormatting — keywordAlignment: toTable', () => {
    it('places ON at JOIN indent + keyword length + 1', () => {
        const input = 'INNER JOIN u ON t.id = u.id';
        const result = applyJoinOnFormatting(input, style(true, 'toTable'), TAB);
        const lines = result.split('\n');
        // "INNER JOIN" is 10 chars, so ON at 0 + 10 + 1 = 11
        assert.equal(lines[1], '           ON t.id = u.id');
    });
});

describe('applyJoinOnFormatting — multiple JOINs', () => {
    it('handles multiple consecutive JOINs', () => {
        const input = [
            'FROM a',
            'INNER JOIN b ON a.id = b.id',
            'LEFT JOIN c ON b.ref = c.ref',
        ].join('\n');
        const result = applyJoinOnFormatting(input, style(true, 'indented'), TAB);
        const lines = result.split('\n');
        assert.equal(lines[0], 'FROM a');
        assert.equal(lines[1], 'INNER JOIN b');
        assert.equal(lines[2], '    ON a.id = b.id');
        assert.equal(lines[3], 'LEFT JOIN c');
        assert.equal(lines[4], '    ON b.ref = c.ref');
    });
});

// ---------------------------------------------------------------------------
// join.keywordAlignment: "toTable"
// ---------------------------------------------------------------------------

function styleToTable(
    onKeywordAlignment: 'indented' | 'toJoin' | 'toTable' = 'indented',
): SqlPromptStyleJson {
    return {
        joinStatements: {
            join: { keywordAlignment: 'toTable' },
            on: { keywordAlignment: onKeywordAlignment },
        },
    };
}

describe('applyJoinOnFormatting — join.keywordAlignment: toTable', () => {
    it('indents INNER JOIN to table column and splits ON (indented)', () => {
        // Simulates post-keywordPaddingFormatter output where keyword column = 7
        const input = [
            'SELECT *',
            'FROM   t1',
            'INNER  JOIN t2 ON t1.id = t2.id',
        ].join('\n');
        const result = applyJoinOnFormatting(input, styleToTable('indented'), TAB);
        const lines = result.split('\n');
        assert.equal(lines[0], 'SELECT *');
        assert.equal(lines[1], 'FROM   t1');
        // JOIN indented to column 7 (= keyword column width inferred from FROM)
        assert.equal(lines[2], '       INNER JOIN t2');
        // ON at effectiveIndent(7) + tabWidth(4) = 11
        assert.equal(lines[3], '           ON t1.id = t2.id');
    });

    it('places ON at toJoin alignment (effectiveIndent)', () => {
        const input = 'SELECT *\nFROM   t1\nINNER  JOIN t2 ON t1.id = t2.id';
        const result = applyJoinOnFormatting(input, styleToTable('toJoin'), TAB);
        const lines = result.split('\n');
        assert.equal(lines[2], '       INNER JOIN t2');
        // ON at effectiveIndent(7)
        assert.equal(lines[3], '       ON t1.id = t2.id');
    });

    it('places ON at toTable alignment (effectiveIndent + keyword + 1)', () => {
        const input = 'SELECT *\nFROM   t1\nINNER  JOIN t2 ON t1.id = t2.id';
        const result = applyJoinOnFormatting(input, styleToTable('toTable'), TAB);
        const lines = result.split('\n');
        assert.equal(lines[2], '       INNER JOIN t2');
        // ON at 7 + len("INNER JOIN") + 1 = 7 + 10 + 1 = 18
        assert.equal(lines[3], '                  ON t1.id = t2.id');
    });

    it('handles multiple JOINs with toTable', () => {
        const input = [
            'SELECT *',
            'FROM   t1',
            'INNER  JOIN t2 ON t1.id = t2.id',
            'LEFT   JOIN t3 ON t2.ref = t3.ref',
        ].join('\n');
        const result = applyJoinOnFormatting(input, styleToTable('indented'), TAB);
        const lines = result.split('\n');
        assert.equal(lines[2], '       INNER JOIN t2');
        assert.equal(lines[3], '           ON t1.id = t2.id');
        assert.equal(lines[4], '       LEFT JOIN t3');
        assert.equal(lines[5], '           ON t2.ref = t3.ref');
    });
});

describe('applyJoinOnFormatting — on.keywordAlignment implies placeOnNewLine', () => {
    it('splits ON to new line when only on.keywordAlignment is configured', () => {
        const sql: SqlPromptStyleJson = {
            joinStatements: {
                on: { keywordAlignment: 'indented' },
            },
        };
        const input = 'FROM t\nINNER JOIN u ON t.id = u.id';
        const result = applyJoinOnFormatting(input, sql, TAB);
        const lines = result.split('\n');
        assert.equal(lines[1], 'INNER JOIN u');
        assert.equal(lines[2], '    ON t.id = u.id');
    });
});
