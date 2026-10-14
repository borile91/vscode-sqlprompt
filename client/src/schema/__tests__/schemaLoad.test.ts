import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    QueryRunner,
    isAggregationUnsupportedError,
    loadColumns,
    loadDatabases,
} from '../schemaLoad.js';

/** Result set nel formato di SQL Tools Service: celle `{ displayValue, isNull }`. */
function resultSet(columns: string[], rows: Array<Array<string | number | null>>) {
    return {
        columnInfo: columns.map((columnName) => ({ columnName })),
        rows: rows.map((row) =>
            row.map((v) => (v === null ? { isNull: true } : { displayValue: String(v), isNull: false })),
        ),
    };
}

/** Runner finto: ogni query passa a `handler`, che risponde o lancia. */
function fakeRunner(handler: (sql: string) => any): QueryRunner & { queries: string[] } {
    const queries: string[] = [];
    return {
        queries,
        async executeSimpleQuery(_uri: string, sql: string) {
            queries.push(sql);
            return handler(sql);
        },
    };
}

const isAggregating = (sql: string) => sql.includes('STRING_AGG');

const LEGACY_COLUMN_NAMES = [
    'schema_name', 'object_name', 'column_name', 'data_type', 'max_length',
    'is_nullable', 'is_identity', 'is_computed', 'has_default', 'is_primary_key',
];

describe('isAggregationUnsupportedError', () => {
    it('riconosce STRING_AGG non supportato', () => {
        assert.equal(
            isAggregationUnsupportedError(
                new Error("'STRING_AGG' is not a recognized built-in function name."),
            ),
            true,
        );
    });

    it('riconosce il numero di errore 195', () => {
        assert.equal(isAggregationUnsupportedError({ number: 195, message: 'x' }), true);
    });

    it('riconosce WITHIN GROUP non supportato e il livello di compatibilità', () => {
        assert.equal(isAggregationUnsupportedError(new Error("Incorrect syntax near 'WITHIN'.")), true);
        assert.equal(
            isAggregationUnsupportedError(new Error('... requires database compatibility level 110')),
            true,
        );
    });

    it('non riconosce timeout, connessione persa e permessi', () => {
        assert.equal(isAggregationUnsupportedError(new Error('Execution Timeout Expired.')), false);
        assert.equal(
            isAggregationUnsupportedError(new Error('A transport-level error has occurred')),
            false,
        );
        assert.equal(
            isAggregationUnsupportedError(new Error('The SELECT permission was denied')),
            false,
        );
        assert.equal(isAggregationUnsupportedError(undefined), false);
    });
});

describe('loadColumns: fallback legacy', () => {
    it('ripiega sulla query per-riga quando STRING_AGG non è supportato', async () => {
        const runner = fakeRunner((sql) => {
            if (isAggregating(sql)) {
                throw new Error("'STRING_AGG' is not a recognized built-in function name.");
            }
            return resultSet(LEGACY_COLUMN_NAMES, [
                ['dbo', 'T', 'Id', 'int', 4, 0, 1, 0, 0, 1],
                ['dbo', 'T', 'Name', 'nvarchar', 100, 1, 0, 0, 0, 0],
            ]);
        });

        const columns = await loadColumns(runner, 'uri');
        assert.equal(runner.queries.length, 2);
        assert.equal(columns.length, 1);
        assert.equal(columns[0].s, 'dbo');
        assert.equal(columns[0].n, 'T');
        assert.equal(columns[0].c, 'Id\u001fint\u001f4\u001f6\u001eName\u001fnvarchar\u001f100\u001f1');
    });

    it('rilancia un timeout senza tentare la query per-riga', async () => {
        const runner = fakeRunner(() => {
            throw new Error('Execution Timeout Expired.');
        });

        await assert.rejects(() => loadColumns(runner, 'uri'), /Timeout/);
        assert.equal(runner.queries.length, 1);
    });
});

describe('loadDatabases', () => {
    it('usa sys.databases filtrato ONLINE e non listDatabases', async () => {
        let listCalled = false;
        const runner: QueryRunner = {
            async executeSimpleQuery(_uri, sql) {
                assert.match(sql, /state_desc = 'ONLINE'/);
                return resultSet(['name'], [['master'], ['Prod']]);
            },
            async listDatabases() {
                listCalled = true;
                return ['master', 'Prod', 'Offline'];
            },
        };

        assert.deepEqual(await loadDatabases(runner, 'uri'), ['master', 'Prod']);
        assert.equal(listCalled, false);
    });

    it('ripiega su listDatabases se la query fallisce', async () => {
        const runner: QueryRunner = {
            async executeSimpleQuery() {
                throw new Error('permission denied');
            },
            async listDatabases() {
                return ['master', '', 'Prod'];
            },
        };

        assert.deepEqual(await loadDatabases(runner, 'uri'), ['master', 'Prod']);
    });

    it('restituisce un elenco vuoto se entrambe le fonti falliscono', async () => {
        const runner: QueryRunner = {
            async executeSimpleQuery() {
                throw new Error('down');
            },
        };

        assert.deepEqual(await loadDatabases(runner, 'uri'), []);
    });
});
