import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatSqlText } from '../formatPipeline.js';
import { describeFormattingRisk } from '../formatGuard.js';
import type { SqlPromptStyleJson } from '../styleLoader.js';

// Stili reali degli examples (risolti da src/ anche quando si esegue da out/)
const examplesDir = path.resolve(__dirname, '..', '..', '..', 'src', 'formatter', '__tests__', 'examples');
function exampleStyle(group: string): SqlPromptStyleJson {
    return JSON.parse(fs.readFileSync(path.join(examplesDir, group, 'config.json'), 'utf8')) as SqlPromptStyleJson;
}

const issue28Style: SqlPromptStyleJson = {
    lists: {
        placeSubsequentItemsOnNewLines: 'always',
        placeCommasBeforeItems: true,
        addSpaceBeforeComma: true,
        commaAlignment: 'beforeItem',
    },
};

const styles: Array<[string, SqlPromptStyleJson]> = [
    ['2_Inline', exampleStyle('2_Inline')],
    ['3_Tsqlt', exampleStyle('3_Tsqlt')],
    ['virgola iniziale #28', issue28Style],
];

/** Righe con il commento rimosso: il codice che resta deve contenere `needle`. */
function codeOutsideComments(sql: string): string {
    return sql.split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
}

describe('elementi di lista con commento `--`: mai inghiottiti dal commento', () => {
    for (const [name, style] of styles) {
        it(`${name}: SELECT con commenti sugli elementi`, () => {
            const sql = 'SELECT a -- primo\n, b -- secondo\nFROM t';
            const out = formatSqlText(sql, style);
            assert.equal(describeFormattingRisk(sql, out), null);
            assert.match(codeOutsideComments(out), /,\s*b\b/, `b deve restare codice:\n${out}`);
            assert.ok(!/-- primo,/.test(out), `nessun elemento accodato al commento:\n${out}`);
            assert.equal(formatSqlText(out, style), out, 'idempotenza');
        });

        it(`${name}: ORDER BY e INSERT … SELECT con commento`, () => {
            const sql = 'SELECT a FROM t ORDER BY a -- x\n, b;\n\nINSERT INTO t (a, b)\nSELECT x, -- commento\ny\nFROM u;';
            const out = formatSqlText(sql, style);
            assert.equal(describeFormattingRisk(sql, out), null);
            const code = codeOutsideComments(out);
            assert.match(code, /,\s*b;/, `b deve restare codice:\n${out}`);
            assert.match(code, /,\s*y\b/, `y deve restare codice:\n${out}`);
            assert.equal(formatSqlText(out, style), out, 'idempotenza');
        });
    }

    it('2_Inline: risultato atteso', () => {
        const out = formatSqlText('SELECT a -- primo\n, b -- secondo\nFROM t', exampleStyle('2_Inline'));
        assert.equal(out, 'SELECT a -- primo\n     , b -- secondo\nFROM   t');
    });

    it('stile tabulare: una riga di solo commento non diventa un elemento con virgola', () => {
        const sql = 'SELECT a\n-- commento isolato\n, b FROM t';
        const out = formatSqlText(sql, exampleStyle('1_Vertical'));
        assert.equal(describeFormattingRisk(sql, out), null);
        assert.equal(out, 'SELECT a -- commento isolato\n     , b\nFROM   t');
    });
});
