import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyControlFlowIndentation } from '../controlFlowFormatter.js';
import type { SqlPromptStyleJson } from '../styleLoader.js';

const style: SqlPromptStyleJson = {
    casing: { reservedKeywords: 'uppercase' },
    controlFlow: {
        indentBeginAndEndKeywords: true,
        indentContentsOfStatements: true,
    },
};

const tabWidth = 4;

describe('applyControlFlowIndentation', () => {
    it('returns sql unchanged when indentBeginAndEndKeywords is false', () => {
        const styleOff: SqlPromptStyleJson = {
            controlFlow: { indentBeginAndEndKeywords: false },
        };
        const sql = 'IF @x > 0\nBEGIN\nPRINT 1\nEND';
        assert.equal(applyControlFlowIndentation(sql, styleOff, 4), sql);
    });

    it('indents bare BEGIN one level beyond owning statement', () => {
        const sql = 'IF @x > 0\nBEGIN\nPRINT 1;\nEND;';
        const result = applyControlFlowIndentation(sql, style, tabWidth);
        const lines = result.split('\n');
        // BEGIN should be at 4 spaces (tabWidth)
        assert.ok(lines[1].startsWith('    BEGIN'), `got: ${JSON.stringify(lines[1])}`);
    });

    it('indents body content inside BEGIN/END', () => {
        const sql = 'IF @x > 0\nBEGIN\nPRINT 1;\nEND;';
        const result = applyControlFlowIndentation(sql, style, tabWidth);
        const lines = result.split('\n');
        // body at 8 spaces (BEGIN at 4, content at 4+4=8)
        assert.ok(lines[2].startsWith('        PRINT'), `got: ${JSON.stringify(lines[2])}`);
    });

    it('handles BEGIN TRY / END TRY blocks', () => {
        const sql = 'BEGIN TRY\nSELECT 1;\nEND TRY';
        const result = applyControlFlowIndentation(sql, style, tabWidth);
        const lines = result.split('\n');
        assert.ok(lines[0].trim() === 'BEGIN TRY');
        // content indented
        assert.ok(lines[1].startsWith('    '));
        assert.ok(lines[2].trim() === 'END TRY');
    });

    it('handles nested BEGIN/END', () => {
        const sql = 'IF @a = 1\nBEGIN\nIF @b = 2\nBEGIN\nPRINT 2;\nEND;\nEND;';
        const result = applyControlFlowIndentation(sql, style, tabWidth);
        const lines = result.split('\n');
        // Outer BEGIN at 4 spaces
        assert.ok(lines[1].startsWith('    BEGIN'));
        // Inner BEGIN at 4+4+4 = 12? Actually: outer body at 8, inner BEGIN at 8+4=12
        const innerBeginIdx = lines.findIndex((l, i) => i > 1 && l.trim() === 'BEGIN');
        assert.ok(innerBeginIdx > -1);
        assert.ok(lines[innerBeginIdx].startsWith('            BEGIN'), `got: ${JSON.stringify(lines[innerBeginIdx])}`);
    });
});
