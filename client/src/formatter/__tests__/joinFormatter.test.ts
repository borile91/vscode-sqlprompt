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
