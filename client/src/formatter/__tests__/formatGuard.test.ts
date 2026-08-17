import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeFormattingRisk } from '../formatGuard.js';

describe('describeFormattingRisk — formattings that must be allowed', () => {
    it('accepts pure re-indentation', () => {
        const before = 'SELECT a, b FROM dbo.T WHERE a = 1';
        const after = 'SELECT\n    a\n  , b\nFROM dbo.T\nWHERE a = 1';
        assert.equal(describeFormattingRisk(before, after), null);
    });

    it('accepts keyword casing changes', () => {
        assert.equal(
            describeFormattingRisk('select a from dbo.T', 'SELECT a\nFROM dbo.T'),
            null,
        );
    });

    it('accepts a moved comma (leading-comma style)', () => {
        assert.equal(
            describeFormattingRisk('SELECT a,\n b\nFROM t', 'SELECT a\n     , b\nFROM t'),
            null,
        );
    });

    it('accepts an added semicolon', () => {
        assert.equal(describeFormattingRisk('SELECT 1', 'SELECT 1;'), null);
    });

    it('accepts a removed semicolon', () => {
        assert.equal(describeFormattingRisk('SELECT 1;', 'SELECT 1'), null);
    });

    it('accepts collapsing a statement onto one line', () => {
        const before = 'SELECT\n    a\n  , b\nFROM dbo.T';
        assert.equal(describeFormattingRisk(before, 'SELECT a, b FROM dbo.T'), null);
    });

    it('accepts an empty document', () => {
        assert.equal(describeFormattingRisk('', ''), null);
    });
});

describe('describeFormattingRisk — results that must be refused', () => {
    // Observed on ui.PrenotaView: the leading-comma pass inserted a comma after
    // DECLARE because a comment followed it on the next line.
    it('refuses a comma inserted after DECLARE', () => {
        const before = "SET @errore = ''\nDECLARE\n-- Indica se c'è una transazione\n@Bln BIT";
        const after = "SET @errore = ''\nDECLARE,\n-- Indica se c'è una transazione\n, @Bln BIT";
        const risk = describeFormattingRisk(before, after);
        assert.ok(risk, 'expected the guard to refuse this result');
        assert.match(risk!, /added 2 ","/);
    });

    // Observed on the 4_Scripting style: a multi-line AND ( … ) condition was
    // collapsed using the comma as separator, producing "AND (, … , )".
    it('refuses commas injected into a parenthesised condition', () => {
        const before = 'WHERE x IS NULL AND (\n    a IS NOT NULL\n    OR b IS NOT NULL\n);';
        const after = 'WHERE x IS NULL AND (, a IS NOT NULL OR b IS NOT NULL, );';
        const risk = describeFormattingRisk(before, after);
        assert.ok(risk);
        assert.match(risk!, /added 2 ","/);
    });

    it('refuses a dropped statement', () => {
        const risk = describeFormattingRisk('SELECT a FROM t\nSELECT b FROM u', 'SELECT a FROM t');
        assert.ok(risk);
    });

    it('refuses a lost closing parenthesis', () => {
        const risk = describeFormattingRisk('SELECT ISNULL(a, 0) FROM t', 'SELECT ISNULL(a, 0 FROM t');
        assert.ok(risk);
        assert.match(risk!, /removed 1 "\)"/);
    });

    it('refuses altered string content', () => {
        const risk = describeFormattingRisk("SELECT 'abc'", "SELECT 'abd'");
        assert.ok(risk);
    });

    it('reports each changed character', () => {
        const risk = describeFormattingRisk('SELECT (a)', 'SELECT ((a),');
        assert.ok(risk);
        assert.match(risk!, /added 1 "\("/);
        assert.match(risk!, /added 1 ","/);
    });

    it('summarises when many characters changed', () => {
        const risk = describeFormattingRisk('SELECT a FROM t', 'DROP TABLE x; -- gone');
        assert.ok(risk);
        assert.match(risk!, /and \d+ more/);
    });
});
