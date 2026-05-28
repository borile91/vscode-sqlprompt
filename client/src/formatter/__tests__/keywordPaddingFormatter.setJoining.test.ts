import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applySetLineJoining } from '../keywordPaddingFormatter.js';

describe('applySetLineJoining', () => {
    it('joins SET ANSI_NULLS split by sql-formatter', () => {
        const input = 'SET\nANSI_NULLS ON;';
        assert.equal(applySetLineJoining(input), 'SET ANSI_NULLS ON;');
    });

    it('joins SET NOCOUNT split by sql-formatter', () => {
        const input = 'SET\nNOCOUNT ON;';
        assert.equal(applySetLineJoining(input), 'SET NOCOUNT ON;');
    });

    it('joins SET @var assignment split by sql-formatter (with extra indent)', () => {
        // sql-formatter indents the content with tabWidth spaces
        const input = 'SET\n    @Errore = \'\';';
        assert.equal(applySetLineJoining(input), 'SET @Errore = \'\';');
    });

    it('leaves already-inline SET unchanged', () => {
        const input = 'SET ANSI_NULLS ON;';
        assert.equal(applySetLineJoining(input), 'SET ANSI_NULLS ON;');
    });

    it('preserves leading indentation on the SET line', () => {
        const input = '    SET\n    NOCOUNT ON;';
        assert.equal(applySetLineJoining(input), '    SET NOCOUNT ON;');
    });

    it('handles multiple split SET statements', () => {
        const input = 'SET\nANSI_NULLS ON;\n\nSET\nNOCOUNT ON;';
        assert.equal(applySetLineJoining(input), 'SET ANSI_NULLS ON;\n\nSET NOCOUNT ON;');
    });
});
