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

    it('accepts comments moved around, also with quotes and nested block comments', () => {
        const before = "SELECT a, -- c'è, ancora\n /* x /* y */ z */ b FROM [t--1] WHERE s = '--no'";
        const after = "SELECT\n    a -- c'è, ancora\n  , /* x /* y */ z */ b\nFROM\n    [t--1]\nWHERE\n    s = '--no'";
        assert.equal(describeFormattingRisk(before, after), null);
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

    // Osservato con gli stili 2_Inline/3_Tsqlt: la colonna b finiva nel commento
    it('refuses code moved into a line comment', () => {
        const before = 'SELECT a -- primo\n, b -- secondo\nFROM t';
        const after = 'SELECT   a -- primo, b -- secondo\nFROM     t';
        const risk = describeFormattingRisk(before, after);
        assert.ok(risk, 'expected the guard to refuse this result');
        assert.match(risk!, /comment/);
        assert.match(risk!, /removed 1 "b"/);
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

describe('describeFormattingRisk — stringhe letterali identiche byte per byte', () => {
    it('rifiuta una riga di una stringa su più righe reindentata', () => {
        const before = "SET @s = 'riga uno;\nriga due';";
        const after = "SET @s = 'riga uno;\n    riga due';";
        assert.match(describeFormattingRisk(before, after) ?? '', /string literal 1 changed/);
    });

    it('rifiuta due righe di una stringa unite', () => {
        const before = "SELECT 'a;\nb' AS x";
        const after = "SELECT 'a; b' AS x";
        assert.match(describeFormattingRisk(before, after) ?? '', /string literal 1 changed/);
    });

    it("rifiuta un letterale N'…' con spazi interni cambiati", () => {
        const before = "DECLARE @s NVARCHAR(10) = N'a  b';";
        const after = "DECLARE @s NVARCHAR(10) = N'a b';";
        assert.match(describeFormattingRisk(before, after) ?? '', /string literal 1 changed/);
    });

    it("accetta la riformattazione intorno a stringhe intatte, anche con l'escape ''", () => {
        const before = "select 'it''s;\n  ok' as a, 'x' from t where b = 'y  z'";
        const after = "SELECT\n    'it''s;\n  ok' AS a,\n    'x'\nFROM t\nWHERE b = 'y  z'";
        assert.equal(describeFormattingRisk(before, after), null);
    });

    it('ignora gli apici dentro commenti e identificatori delimitati', () => {
        const before = "SELECT [it's] -- l'apice\nFROM t /* d'esempio */";
        const after = "SELECT [it's] -- l'apice\n  FROM t /* d'esempio */";
        assert.equal(describeFormattingRisk(before, after), null);
    });
});
