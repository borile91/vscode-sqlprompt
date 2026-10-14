import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseAlterHeader,
    buildObjectListQuery,
    toAlterScript,
    bracketQualifiedName,
} from '../alterScaffold.js';

describe('parseAlterHeader', () => {
    it('detects ALTER PROCEDURE with nothing typed yet', () => {
        const header = parseAlterHeader('ALTER PROCEDURE ');
        assert.deepEqual(header, { kind: 'procedure', alterStart: 0, nameStart: 16, typed: '' });
    });

    it('detects the partial name and its start column', () => {
        const header = parseAlterHeader('  alter proc dbo.spSim');
        assert.equal(header?.kind, 'procedure');
        assert.equal(header?.alterStart, 2);
        assert.equal(header?.typed, 'dbo.spSim');
        assert.equal(header?.nameStart, 13);
    });

    it('maps VIEW and FUNCTION', () => {
        assert.equal(parseAlterHeader('ALTER VIEW vw')?.kind, 'view');
        assert.equal(parseAlterHeader('ALTER FUNCTION fn')?.kind, 'function');
    });

    it('accepts CREATE OR ALTER', () => {
        const header = parseAlterHeader('CREATE OR ALTER VIEW ');
        assert.equal(header?.kind, 'view');
        assert.equal(header?.alterStart, 10);
    });

    it('ignores other statements and names that are already complete', () => {
        assert.equal(parseAlterHeader('ALTER TABLE dbo.T'), undefined);
        assert.equal(parseAlterHeader('SELECT * FROM dbo.T'), undefined);
        assert.equal(parseAlterHeader('ALTER PROCEDURE dbo.sp AS'), undefined);
    });
});

describe('queries', () => {
    it('lists only user objects of the requested kind', () => {
        const q = buildObjectListQuery('view');
        assert.match(q, /o\.type IN \('V'\)/);
        assert.match(q, /is_ms_shipped = 0/);
        assert.match(buildObjectListQuery('procedure'), /'P', 'PC'/);
        assert.match(buildObjectListQuery('function'), /'FN', 'IF', 'TF', 'FS', 'FT'/);
    });
});

describe('toAlterScript', () => {
    it('rewrites CREATE PROCEDURE into ALTER PROCEDURE', () => {
        const out = toAlterScript('CREATE PROCEDURE [dbo].[spX]\r\nAS\r\nSELECT 1');
        assert.equal(out, 'ALTER PROCEDURE [dbo].[spX]\nAS\nSELECT 1');
    });

    it('handles CREATE OR ALTER and keeps leading comments', () => {
        const out = toAlterScript('-- note\nCREATE OR ALTER VIEW dbo.vw AS SELECT 1 AS a');
        assert.equal(out, '-- note\nALTER VIEW dbo.vw AS SELECT 1 AS a');
    });

    it('only rewrites the first header', () => {
        const out = toAlterScript('CREATE FUNCTION dbo.f() RETURNS int AS BEGIN RETURN 1 END -- CREATE VIEW');
        assert.match(out ?? '', /^ALTER FUNCTION/);
        assert.match(out ?? '', /CREATE VIEW$/);
    });

    it('ignores a CREATE inside a leading comment', () => {
        const out = toAlterScript('-- Description: create view for orders\n/* CREATE PROCEDURE dbo.old */\nCREATE VIEW ui.vwOrdini AS SELECT 1 AS a');
        assert.equal(out, '-- Description: create view for orders\n/* CREATE PROCEDURE dbo.old */\nALTER VIEW ui.vwOrdini AS SELECT 1 AS a');
    });

    it('returns undefined when there is no header (e.g. encrypted object)', () => {
        assert.equal(toAlterScript('-- encrypted'), undefined);
    });
});

describe('parseAlterHeader — comments, strings and delimited names', () => {
    it('ignores ALTER in a line comment, an open block comment or a string', () => {
        assert.equal(parseAlterHeader('-- ALTER PROCEDURE '), undefined);
        assert.equal(parseAlterHeader('SELECT 1 -- alter view vw'), undefined);
        assert.equal(parseAlterHeader('/* ALTER FUNCTION fn'), undefined);
        assert.equal(parseAlterHeader("SELECT 'ALTER VIEW "), undefined);
        assert.equal(parseAlterHeader("SELECT N'it''s ALTER VIEW "), undefined);
    });

    it('still detects a header after a closed comment or string', () => {
        const header = parseAlterHeader('/* note */ ALTER VIEW ');
        assert.equal(header?.kind, 'view');
        assert.equal(header?.alterStart, 11);
        assert.equal(parseAlterHeader("SELECT 'x'; ALTER PROC sp")?.typed, 'sp');
    });

    it('accepts comments between the keywords', () => {
        assert.equal(parseAlterHeader('ALTER /*c*/ PROCEDURE ')?.kind, 'procedure');
        assert.equal(parseAlterHeader('CREATE /*c*/ OR ALTER /*d*/ VIEW vw')?.typed, 'vw');
    });

    it('accepts bracketed and quoted names, also with spaces and unclosed', () => {
        assert.equal(parseAlterHeader('ALTER PROCEDURE [My Proc')?.typed, '[My Proc');
        assert.equal(parseAlterHeader('ALTER PROCEDURE [dbo].[My Proc')?.typed, '[dbo].[My Proc');
        assert.equal(parseAlterHeader('ALTER VIEW "ui"."vw Or')?.typed, '"ui"."vw Or');
        assert.equal(parseAlterHeader('ALTER VIEW [a]]b')?.typed, '[a]]b');
        assert.equal(parseAlterHeader('ALTER PROCEDURE [dbo].[My Proc')?.nameStart, 16);
    });

    it('accepts names with non-ASCII letters', () => {
        assert.equal(parseAlterHeader('ALTER PROC dbo.spQuantità')?.typed, 'dbo.spQuantità');
    });

    it('stops at text that follows a complete delimited name', () => {
        assert.equal(parseAlterHeader('ALTER PROCEDURE [dbo].[sp] AS'), undefined);
    });
});

describe('bracketQualifiedName', () => {
    it('always brackets and escapes closing brackets', () => {
        assert.equal(bracketQualifiedName('dbo', 'spX'), '[dbo].[spX]');
        assert.equal(bracketQualifiedName('my schema', 'a]b'), '[my schema].[a]]b]');
    });
});

describe('toAlterScript — header name and comments', () => {
    const target = { schema: 'sales', name: 'spNew' };

    it('replaces a stale name with the [schema].[name] of the object', () => {
        assert.equal(
            toAlterScript('CREATE PROCEDURE spOld\nAS SELECT 1', target),
            'ALTER PROCEDURE [sales].[spNew]\nAS SELECT 1',
        );
        assert.equal(
            toAlterScript('CREATE PROC [dbo].[spOld] @a int AS SELECT @a', target),
            'ALTER PROC [sales].[spNew] @a int AS SELECT @a',
        );
    });

    it('handles three-part, quoted and spaced names', () => {
        assert.equal(
            toAlterScript('CREATE VIEW db.dbo.vwOld AS SELECT 1 AS a', target),
            'ALTER VIEW [sales].[spNew] AS SELECT 1 AS a',
        );
        assert.equal(
            toAlterScript('CREATE VIEW "dbo"."vw Old" AS SELECT 1 AS a', target),
            'ALTER VIEW [sales].[spNew] AS SELECT 1 AS a',
        );
        assert.equal(
            toAlterScript('CREATE VIEW [dbo] . [vw]]Old] AS SELECT 1 AS a', target),
            'ALTER VIEW [sales].[spNew] AS SELECT 1 AS a',
        );
    });

    it('keeps the parameter list of a function', () => {
        assert.equal(
            toAlterScript('CREATE FUNCTION dbo.fOld(@x int) RETURNS int AS BEGIN RETURN @x END', target),
            'ALTER FUNCTION [sales].[spNew](@x int) RETURNS int AS BEGIN RETURN @x END',
        );
    });

    it('recognises comments between the keywords and keeps them', () => {
        assert.equal(
            toAlterScript('CREATE /*c*/ PROCEDURE dbo.sp AS SELECT 1'),
            'ALTER /*c*/ PROCEDURE dbo.sp AS SELECT 1',
        );
        assert.equal(
            toAlterScript('CREATE --c\nOR ALTER /*d*/ VIEW /*e*/ dbo.vw AS SELECT 1 AS a', target),
            'ALTER /*d*/ VIEW /*e*/ [sales].[spNew] AS SELECT 1 AS a',
        );
    });

    it('is not fooled by a bracketed name containing comment or quote characters', () => {
        assert.equal(
            toAlterScript("CREATE VIEW [dbo].[v--x'] AS SELECT 1 AS a", target),
            'ALTER VIEW [sales].[spNew] AS SELECT 1 AS a',
        );
    });

    it('skips a CREATE that is not a module header (nested comment too)', () => {
        assert.equal(
            toAlterScript('/* outer /* CREATE VIEW x */ still comment */\nCREATE PROC dbo.p AS SELECT 1', target),
            '/* outer /* CREATE VIEW x */ still comment */\nALTER PROC [sales].[spNew] AS SELECT 1',
        );
    });
});
