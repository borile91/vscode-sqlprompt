import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseAlterHeader,
    buildObjectListQuery,
    buildDefinitionQuery,
    toAlterScript,
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

    it('escapes quotes in the definition query', () => {
        const q = buildDefinitionQuery("d'bo", "sp'x");
        assert.match(q, /N'd''bo'/);
        assert.match(q, /N'sp''x'/);
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
