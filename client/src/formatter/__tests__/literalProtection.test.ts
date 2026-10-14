import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatSqlText } from '../formatPipeline.js';
import { describeFormattingRisk } from '../formatGuard.js';
import { extractStringLiterals, withProtectedLiterals } from '../sqlLiterals.js';
import type { SqlPromptStyleJson } from '../styleLoader.js';

// Stili reali degli examples (risolti da src/ anche quando si esegue da out/)
const examplesDir = path.resolve(__dirname, '..', '..', '..', 'src', 'formatter', '__tests__', 'examples');
const exampleStyles: Array<[string, SqlPromptStyleJson]> = fs.readdirSync(examplesDir)
    .filter(group => fs.existsSync(path.join(examplesDir, group, 'config.json')))
    .sort()
    .map(group => [group, JSON.parse(fs.readFileSync(path.join(examplesDir, group, 'config.json'), 'utf8')) as SqlPromptStyleJson]);
const scripting = exampleStyles.find(([name]) => name === '4_Scripting')![1];
const styles: Array<[string, SqlPromptStyleJson]> = [
    ...exampleStyles,
    ['4_Scripting con virgola iniziale', { ...scripting, lists: { ...scripting.lists, placeCommasBeforeItems: true } }],
    ['4_Scripting con spazi nelle parentesi', { ...scripting, parentheses: { ...scripting.parentheses, addSpacesInsideParentheses: true } }],
];

const multilineStrings = [
    'CREATE PROCEDURE dbo.p',
    '    @id INT',
    'AS',
    'BEGIN',
    "    DECLARE @sql NVARCHAR(MAX) = N'SELECT a FROM t;",
    '    SELECT b FROM u;',
    "        WHERE x = 1';",
    "    SET @sql = @sql + N'",
    'SET @y = 1;',
    '',
    "SET @z = 2;';",
    '    IF @id = 1',
    "        SET @sql = 'riga uno;",
    "riga due';",
    "    SELECT 'testo;",
    "    con a capo' AS a, b FROM t WHERE c = 'x;",
    "  y' AND d = 1;",
    "    EXEC dbo.q @a = 'uno;",
    "due', @b = 2, @c = 3;",
    "    INSERT INTO dbo.Log (Testo) VALUES ('a;",
    "b');",
    'END',
].join('\n');

// sql-formatter toglie già l'indentazione delle righe interne dei commenti a
// blocco: il commento di prova non ne ha, così deve restare identico.
const blockComment = '/* blocco;\nSELECT finto FROM commento;\naltro; testo */';
const multilineComment = [
    'SELECT a, b FROM t WHERE x = 1;',
    blockComment,
    'UPDATE t SET a = 1 WHERE id = 2;',
].join('\n');

describe('stringhe e commenti a blocco su più righe: contenuto mai modificato', () => {
    for (const [name, style] of styles) {
        it(`${name}: stringhe con ";" seguito da testo`, () => {
            const out = formatSqlText(multilineStrings, style);
            assert.deepEqual(extractStringLiterals(out), extractStringLiterals(multilineStrings));
            assert.equal(describeFormattingRisk(multilineStrings, out), null);
            assert.equal(formatSqlText(out, style), out);
        });

        it(`${name}: commento a blocco su più righe con ";"`, () => {
            const out = formatSqlText(multilineComment, style);
            assert.ok(out.includes(blockComment), out);
            assert.equal(describeFormattingRisk(multilineComment, out), null);
        });
    }
});

describe('withProtectedLiterals', () => {
    it('il passaggio non vede le stringhe su più righe e il testo torna identico', () => {
        const sql = "SELECT 'a;\nb' AS x;\nSELECT 1;";
        let seen = '';
        const out = withProtectedLiterals(sql, masked => {
            seen = masked;
            return masked.replace(/;\n/g, ';\n\n');
        });
        assert.equal(seen.split('\n').length, 2);
        assert.equal(out, "SELECT 'a;\nb' AS x;\n\nSELECT 1;");
    });

    it('le stringhe su una riga restano visibili al passaggio', () => {
        const sql = "SELECT 'a;b' AS x";
        withProtectedLiterals(sql, masked => {
            assert.equal(masked, sql);
            return masked;
        });
    });

    it('se il passaggio perde un segnaposto restituisce il testo di partenza', () => {
        const sql = "SELECT '\n' AS x";
        assert.equal(withProtectedLiterals(sql, () => 'SELECT 1'), sql);
    });
});
