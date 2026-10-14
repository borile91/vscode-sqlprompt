import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatSqlText } from '../formatPipeline.js';
import { describeFormattingRisk } from '../formatGuard.js';
import { hasLineComment } from '../scriptingFormatter.js';
import type { SqlPromptStyleJson } from '../styleLoader.js';

// Stile compatto reale degli examples (risolto da src/ anche quando si esegue da out/)
const examplesDir = path.resolve(__dirname, '..', '..', '..', 'src', 'formatter', '__tests__', 'examples');
const scripting = JSON.parse(
    fs.readFileSync(path.join(examplesDir, '4_Scripting', 'config.json'), 'utf8'),
) as SqlPromptStyleJson;
const scriptingCommaFirst: SqlPromptStyleJson = {
    ...scripting,
    lists: { ...scripting.lists, placeCommasBeforeItems: true },
};

/** Formatta, verifica il guard e la convergenza, restituisce il risultato. */
function formatSafely(sql: string, style: SqlPromptStyleJson = scripting): string {
    const out = formatSqlText(sql, style);
    assert.equal(describeFormattingRisk(sql, out), null);
    assert.equal(formatSqlText(out, style), out);
    return out;
}

describe('stile compatto: clausole su una riga senza virgole inventate', () => {
    it('AND ( … ) su più righe: nessuna virgola dentro le parentesi (PR #24)', () => {
        const sql = [
            'SELECT ofa.Id',
            'FROM dbo.Ofa ofa',
            'WHERE ofa.Ordinamento IS NULL AND (',
            '        ofa.DataConsegnaImminente IS NOT NULL',
            '        OR ofa.DataPianificata IS NOT NULL',
            '    );',
        ].join('\n');
        const out = formatSafely(sql);
        assert.match(out, /WHERE ofa\.Ordinamento IS NULL AND \(ofa\.DataConsegnaImminente IS NOT NULL OR ofa\.DataPianificata IS NOT NULL\);/);
        assert.doesNotMatch(out, /\(,|, \)/);
    });

    it('condizione lunga: va a capo prima di OR, senza virgola', () => {
        const conditions = Array.from({ length: 8 }, (_, i) => `ofa.Colonna${i} IS NOT NULL`).join(' OR ');
        const sql = `SELECT ofa.Id FROM dbo.Ofa ofa WHERE ofa.Id = @id AND (${conditions});`;
        const out = formatSafely(sql);
        assert.doesNotMatch(out, /,\s*OR\b|\(,/);
    });

    it('subquery in IN: unita con spazi', () => {
        const sql = 'DELETE FROM dbo.T WHERE Id IN (SELECT Id FROM dbo.U WHERE U.Flag = 1 AND (U.A = 1 OR U.B = 2));';
        const out = formatSafely(sql);
        assert.match(out, /WHERE Id IN \(SELECT Id FROM dbo\.U WHERE U\.Flag = 1 AND \(U\.A = 1 OR U\.B = 2\)\);/);
    });

    it('lista SELECT: resta separata da virgole', () => {
        const out = formatSafely('SELECT a, b, c FROM t ORDER BY a, b;');
        assert.match(out, /^SELECT a, b, c$/m);
        assert.match(out, /^ORDER BY a, b;$/m);
    });
});

describe('stile compatto: un commento `--` non inghiotte il codice che segue', () => {
    const cases: Array<[string, string]> = [
        ['IF con commento e corpo breve', 'IF @id = 1 -- commento\n    SET @codice = \'x\';'],
        ['INSERT con commento prima di VALUES', 'INSERT INTO dbo.Log (Id, Testo) -- log\nVALUES (@id, \'ok\');'],
        ['WHERE con commento su una condizione', 'SELECT a FROM t WHERE a = 1 -- filtro\n    AND b = 2;'],
        ['SELECT con commento su un elemento', 'SELECT a, -- primo\n    b, c FROM t;'],
        ['UPDATE con commento su una assegnazione', 'UPDATE t SET a = 1, -- nuovo\n    b = 2 WHERE id = 1;'],
        ['EXEC con commento su un parametro', 'EXEC dbo.p @a = 1, -- primo\n    @b = 2, @c = 3;'],
    ];
    for (const [name, sql] of cases) {
        for (const [styleName, style] of [['compatto', scripting], ['compatto con virgola iniziale', scriptingCommaFirst]] as const) {
            it(`${name} (${styleName})`, () => {
                formatSafely(sql, style);
            });
        }
    }
});

describe('hasLineComment', () => {
    it('riconosce il commento di riga', () => {
        assert.equal(hasLineComment('a = 1 -- nota'), true);
    });
    it('ignora -- dentro stringhe e identificatori delimitati', () => {
        assert.equal(hasLineComment("a = 'x -- y'"), false);
        assert.equal(hasLineComment('[col--1] = 1'), false);
        assert.equal(hasLineComment("a = 'it''s' -- nota"), true);
    });
});
