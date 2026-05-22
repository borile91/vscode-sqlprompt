import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { removeBlankLinesBeforeEnd } from '../controlFlowFormatter.js';

describe('removeBlankLinesBeforeEnd', () => {
    it('removes one blank line before END', () => {
        const sql = 'BEGIN\n    SET @x = 1;\n\n    END;';
        const result = removeBlankLinesBeforeEnd(sql);
        assert.equal(result, 'BEGIN\n    SET @x = 1;\n    END;');
    });

    it('removes multiple blank lines before END', () => {
        const sql = 'BEGIN\n    SET @x = 1;\n\n\n    END;';
        const result = removeBlankLinesBeforeEnd(sql);
        assert.equal(result, 'BEGIN\n    SET @x = 1;\n    END;');
    });

    it('removes blank line before END TRY', () => {
        const sql = 'BEGIN TRY\n    SELECT 1;\n\n    END TRY';
        const result = removeBlankLinesBeforeEnd(sql);
        assert.equal(result, 'BEGIN TRY\n    SELECT 1;\n    END TRY');
    });

    it('removes blank line before END CATCH', () => {
        const sql = 'BEGIN CATCH\n    RETURN -1;\n\nEND CATCH;';
        const result = removeBlankLinesBeforeEnd(sql);
        assert.equal(result, 'BEGIN CATCH\n    RETURN -1;\nEND CATCH;');
    });

    it('preserves blank lines that are NOT before END', () => {
        const sql = 'SET @a = 1;\n\nSET @b = 2;\nEND;';
        const result = removeBlankLinesBeforeEnd(sql);
        // Blank line between SET statements should be preserved
        assert.equal(result, 'SET @a = 1;\n\nSET @b = 2;\nEND;');
    });

    it('does not remove the last non-blank line before END', () => {
        const sql = 'BEGIN\n    SELECT 1;\n    END;';
        const result = removeBlankLinesBeforeEnd(sql);
        assert.equal(result, 'BEGIN\n    SELECT 1;\n    END;');
    });

    it('handles multiple END blocks', () => {
        const sql = 'BEGIN\n    SET @x = 1;\n\n    END;\n\nBEGIN\n    SET @y = 2;\n\n    END;';
        const result = removeBlankLinesBeforeEnd(sql);
        assert.ok(!result.includes(';\n\n    END'), `blank line before END remains: ${result}`);
        assert.ok(result.includes(';\n\nBEGIN'), 'blank line between blocks should be preserved');
    });
});
