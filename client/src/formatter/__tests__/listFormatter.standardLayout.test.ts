import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatSqlText } from '../formatPipeline.js';
import { describeFormattingRisk } from '../formatGuard.js';
import type { SqlPromptStyleJson } from '../styleLoader.js';

// Stile della issue #28: virgola iniziale senza tabularLeft (keyword su riga propria)
const issueStyle: SqlPromptStyleJson = {
    lists: {
        placeSubsequentItemsOnNewLines: 'always',
        placeCommasBeforeItems: true,
        addSpaceBeforeComma: true,
        commaAlignment: 'beforeItem',
    },
};

function withLists(lists: SqlPromptStyleJson['lists']): SqlPromptStyleJson {
    return { lists: { ...issueStyle.lists, ...lists } };
}

/** Formatta come l'estensione e verifica guard e idempotenza. */
function fmt(sql: string, style: SqlPromptStyleJson = issueStyle): string {
    const out = formatSqlText(sql, style);
    assert.equal(describeFormattingRisk(sql, out), null, 'il guard non deve bloccare il risultato');
    assert.equal(formatSqlText(out, style), out, 'la formattazione deve essere idempotente');
    return out;
}

const issueInput = [
    'SELECT foo, bar, baz, min(bat)',
    'FROM   FooBar',
    'GROUP BY foo, bar, baz',
    'ORDER BY foo, bar, baz',
].join('\n');

describe('virgola iniziale con keyword su riga propria (#28)', () => {
    it('esempio della issue: SELECT, GROUP BY, ORDER BY', () => {
        assert.equal(fmt(issueInput), [
            'SELECT',
            '    foo',
            '  , bar',
            '  , baz',
            '  , min(bat)',
            'FROM',
            '    FooBar',
            'GROUP BY',
            '    foo',
            '  , bar',
            '  , baz',
            'ORDER BY',
            '    foo',
            '  , bar',
            '  , baz',
        ].join('\n'));
    });

    it('addSpaceBeforeComma false: ",bar" allineato al primo elemento', () => {
        const out = fmt('SELECT foo, bar FROM t', withLists({ addSpaceBeforeComma: false }));
        assert.equal(out, 'SELECT\n    foo\n   ,bar\nFROM\n    t');
    });

    it('commaAlignment toList e toStatement', () => {
        assert.equal(
            fmt('SELECT foo, bar FROM t', withLists({ commaAlignment: 'toList' })),
            'SELECT\n    foo\n    , bar\nFROM\n    t',
        );
        assert.equal(
            fmt('SELECT foo, bar FROM t', withLists({ commaAlignment: 'toStatement' })),
            'SELECT\n    foo\n,   bar\nFROM\n    t',
        );
    });

    it('virgole dentro funzioni, stringhe e identificatori non separano elementi', () => {
        const out = fmt("SELECT COALESCE(a, b, 'x, y') AS c, [col, strana], dbo.f(1, 2) FROM t");
        assert.equal(out, [
            'SELECT',
            "    COALESCE(a, b, 'x, y') AS c",
            '  , [col, strana]',
            '  , dbo.f(1, 2)',
            'FROM',
            '    t',
        ].join('\n'));
    });

    it('CASE, subquery e OVER su più righe restano un solo elemento; liste annidate convertite', () => {
        const out = fmt(
            'SELECT a, CASE WHEN c = 1 THEN 2 ELSE 3 END AS cc, ' +
            '(SELECT q, r FROM s ORDER BY q, r) AS sub, ' +
            'ROW_NUMBER() OVER (PARTITION BY a, b ORDER BY c) AS rn FROM t',
        );
        assert.equal(out, [
            'SELECT',
            '    a',
            '  , CASE',
            '        WHEN c = 1 THEN 2',
            '        ELSE 3',
            '    END AS cc',
            '  , (',
            '        SELECT',
            '            q',
            '          , r',
            '        FROM',
            '            s',
            '        ORDER BY',
            '            q',
            '          , r',
            '    ) AS sub',
            '  , ROW_NUMBER() OVER (',
            '        PARTITION BY',
            '            a',
            '          , b',
            '        ORDER BY',
            '            c',
            '    ) AS rn',
            'FROM',
            '    t',
        ].join('\n'));
    });

    it('CTE con più colonne', () => {
        const out = fmt('WITH cte (a, b) AS (SELECT x, y FROM t) SELECT a, b FROM cte');
        assert.equal(out, [
            'WITH',
            '    cte (a, b) AS (',
            '        SELECT',
            '            x',
            '          , y',
            '        FROM',
            '            t',
            '    )',
            'SELECT',
            '    a',
            '  , b',
            'FROM',
            '    cte',
        ].join('\n'));
    });

    it('commenti di riga sugli elementi restano in coda all\'elemento', () => {
        const out = fmt('SELECT a, -- primo, con virgola\n b -- secondo\n, c FROM t');
        assert.equal(out, [
            'SELECT',
            '    a -- primo, con virgola',
            '  , b -- secondo',
            '  , c',
            'FROM',
            '    t',
        ].join('\n'));
    });

    it('UPDATE ... SET con più assegnazioni e VALUES con più righe', () => {
        assert.equal(fmt("UPDATE t SET a = 1, b = 'x,y' WHERE id = 5;"), [
            'UPDATE t',
            'SET',
            '    a = 1',
            "  , b = 'x,y'",
            'WHERE',
            '    id = 5;',
        ].join('\n'));
        assert.equal(fmt('INSERT INTO t (a, b) VALUES (1, 2), (3, 4);'), [
            'INSERT INTO',
            '    t (a, b)',
            'VALUES',
            '    (1, 2)',
            '  , (3, 4);',
        ].join('\n'));
    });

    it('SET con una sola assegnazione e SET @variabile restano su una riga', () => {
        assert.equal(fmt('UPDATE t SET a = 1 WHERE id = 2;'), 'UPDATE t\nSET a = 1\nWHERE\n    id = 2;');
        assert.equal(fmt('SET @x = 1;'), 'SET @x = 1;');
    });

    it('stringa su più righe: stringa intatta, virgola iniziale applicata', () => {
        // La pipeline maschera le stringhe su più righe: la lista le vede come
        // un solo elemento e può applicare la virgola iniziale senza toccarle.
        const sql = "SELECT 'riga\nmultipla, con virgola' AS a, b FROM t";
        assert.ok(fmt(sql).includes("'riga\nmultipla, con virgola' AS a\n  , b"));
    });
});
