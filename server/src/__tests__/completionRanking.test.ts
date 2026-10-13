/**
 * Tests for the completion ranking, plus a small ranking eval.
 *
 * The eval at the bottom is the point of this file. Ranking weights are
 * judgement calls, and without a number attached to them every future change is
 * a guess: the fixtures state what the right answer is for a handful of
 * realistic situations and report mean reciprocal rank over them, so a change
 * that helps one case at the cost of three is visible instead of invisible.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ColumnInfo, ForeignKeyInfo, TableInfo } from '../schemaLoader';
import {
    buildObjectRanker,
    encodeSortText,
    looksLikeNoise,
    nameTokens,
    rankingKey,
} from '../completionRanking';

// ── Fixture helpers ───────────────────────────────────────────────────────────

function col(name: string, isPrimaryKey = false): ColumnInfo {
    return { name, dataType: 'int', maxLength: null, isNullable: false, isPrimaryKey };
}

function fk(
    parentTable: string,
    referencedTable: string,
    column: string,
    schema = 'dbo',
): ForeignKeyInfo {
    return {
        name: `FK_${parentTable}_${referencedTable}`,
        parentSchema: schema,
        parentTable,
        referencedSchema: schema,
        referencedTable,
        mappings: [{ column, referencedColumn: 'Id' }],
    };
}

function table(
    name: string,
    options: {
        schema?: string;
        columns?: ColumnInfo[];
        foreignKeys?: ForeignKeyInfo[];
        isView?: boolean;
    } = {},
): TableInfo {
    return {
        schema: options.schema ?? 'dbo',
        name,
        columns: options.columns ?? [col('Id', true)],
        foreignKeys: options.foreignKeys ?? [],
        isView: options.isView,
    };
}

/** Ranks `candidates` best-first, the way VS Code would from `sortText`. */
function rankedNames(
    ranker: { sortText(schema: string, name: string, kind: any): string },
    candidates: TableInfo[],
): string[] {
    return candidates
        .map((t) => ({
            name: t.name,
            sortText: ranker.sortText(t.schema, t.name, t.isView ? 'view' : 'table'),
        }))
        .sort((a, b) => (a.sortText < b.sortText ? -1 : a.sortText > b.sortText ? 1 : 0))
        .map((entry) => entry.name);
}

// ── Name tokens ───────────────────────────────────────────────────────────────

describe('nameTokens', () => {
    test('splits CamelCase', () => {
        assert.deepEqual(nameTokens('OrderDetails'), ['order', 'detail']);
    });

    test('splits underscores', () => {
        assert.deepEqual(nameTokens('PRESTITI_DETTAGLIO'), ['ordini', 'dettaglio']);
    });

    test('a plural parent shares a token with its singular-prefixed child', () => {
        const parent = nameTokens('Orders');
        const child = nameTokens('OrderLines');
        assert.ok(child.some((token) => parent.includes(token)));
    });

    test('splits an acronym followed by a word', () => {
        assert.deepEqual(nameTokens('XMLHttpRequest'), ['xml', 'http', 'request']);
    });

    test('drops tokens too short to mean anything', () => {
        // `Id` and `No` appear in nearly every name; keeping them would make
        // every table look related to every other one.
        assert.deepEqual(nameTokens('OrderIdNo'), ['order']);
    });
});

describe('looksLikeNoise', () => {
    for (const name of [
        'Orders_bak',
        'Orders_OLD',
        'ORDINI_TMP',
        'tmpOrders',
        'z_Orders',
        'Orders_20240131',
        'Orders_copy2',
    ]) {
        test(`flags ${name}`, () => assert.equal(looksLikeNoise(name), true));
    }

    for (const name of [
        'Orders',
        'OrderDetails',
        'Templates', // starts with "temp" but is a real word
        'Bakeries', // starts with "bak"
        'OrderStatus',
    ]) {
        test(`leaves ${name} alone`, () => assert.equal(looksLikeNoise(name), false));
    }
});

describe('encodeSortText', () => {
    test('a higher score sorts earlier', () => {
        assert.ok(encodeSortText('01a', 5000, 'b') < encodeSortText('01a', 100, 'a'));
    });

    test('equal scores fall back to the name', () => {
        assert.ok(encodeSortText('01a', 500, 'alpha') < encodeSortText('01a', 500, 'beta'));
    });

    test('stays within the band, so item classes cannot interleave', () => {
        assert.ok(encodeSortText('01a', 9999, 'a').startsWith('01a_'));
        assert.ok(encodeSortText('01a', 0, 'a').startsWith('01a_'));
    });

    test('statement snippets still outrank every schema object', () => {
        // `01_snippet_ssf` has to beat the best-scoring table: the user typed
        // the snippet's exact name.
        assert.ok('01_snippet_ssf' < encodeSortText('01a', 9999, 'aaa'));
    });
});

// ── Scoring ───────────────────────────────────────────────────────────────────

describe('buildObjectRanker — foreign keys', () => {
    // Orders → Customers directly; Orders → OrderLines → Products at two hops.
    const orders = table('Orders', {
        columns: [col('Id', true), col('CustomerId')],
        foreignKeys: [fk('Orders', 'Customers', 'CustomerId')],
    });
    const customers = table('Customers');
    const orderLines = table('OrderLines', {
        foreignKeys: [fk('OrderLines', 'Orders', 'OrderId'), fk('OrderLines', 'Products', 'ProductId')],
    });
    const products = table('Products');
    const unrelated = table('Aardvark');
    const tables = [orders, customers, orderLines, products, unrelated];

    const ranker = buildObjectRanker({ inScope: [orders], tables });

    test('a directly related table beats one two hops away', () => {
        assert.ok(
            ranker.score('dbo', 'Customers', 'table') > ranker.score('dbo', 'Products', 'table'),
        );
    });

    test('a table two hops away beats an unrelated one', () => {
        assert.ok(
            ranker.score('dbo', 'Products', 'table') > ranker.score('dbo', 'Aardvark', 'table'),
        );
    });

    test('relatedness works in both directions', () => {
        // OrderLines points at Orders, not the other way round; joining from
        // Orders to its lines is just as common.
        assert.ok(
            ranker.score('dbo', 'OrderLines', 'table') > ranker.score('dbo', 'Aardvark', 'table'),
        );
    });

    test('the alphabetically-first table does not win by default', () => {
        assert.notEqual(rankedNames(ranker, tables)[0], 'Aardvark');
    });

    test('a name-related neighbour wins the tie between two direct neighbours', () => {
        // Customers and OrderLines are both one hop from Orders; `OrderLines`
        // shares a name token with it, which is the stronger hint.
        assert.ok(
            ranker.score('dbo', 'OrderLines', 'table') >
            ranker.score('dbo', 'Customers', 'table'),
        );
    });

    test('with nothing in scope, a hub table leads and equals stay alphabetical', () => {
        const cold = buildObjectRanker({ inScope: [], tables });
        const order = rankedNames(cold, tables);

        // Customers, Orders and Products are each referenced once; OrderLines
        // and Aardvark are referenced by nothing, so they come last in
        // alphabetical order.
        assert.deepEqual(order.slice(3), ['Aardvark', 'OrderLines']);
        assert.deepEqual(order.slice(0, 3), ['Customers', 'Orders', 'Products']);
    });
});

describe('buildObjectRanker — name and schema affinity', () => {
    const orders = table('Orders', { schema: 'Sales' });
    const orderLines = table('OrderLines', { schema: 'Staging' });
    const invoices = table('Invoices', { schema: 'Sales' });
    const shipments = table('Shipments', { schema: 'Staging' });
    const tables = [orders, orderLines, invoices, shipments];

    const ranker = buildObjectRanker({ inScope: [orders], tables });

    test('a shared name token counts, across schemas', () => {
        assert.ok(
            ranker.score('Staging', 'OrderLines', 'table') >
            ranker.score('Staging', 'Shipments', 'table'),
        );
    });

    test('the same schema counts', () => {
        assert.ok(
            ranker.score('Sales', 'Invoices', 'table') >
            ranker.score('Staging', 'Shipments', 'table'),
        );
    });

    test('a shared name token outweighs a shared schema', () => {
        // `OrderLines` next to `Orders` is a stronger hint than "some other
        // table in the same schema".
        assert.ok(
            ranker.score('Staging', 'OrderLines', 'table') >
            ranker.score('Sales', 'Invoices', 'table'),
        );
    });
});

describe('buildObjectRanker — object kind', () => {
    const tables = [table('Orders'), table('OrdersView', { isView: true })];
    const ranker = buildObjectRanker({ inScope: [], tables });

    test('a base table outranks a view', () => {
        assert.ok(ranker.score('dbo', 'X', 'table') > ranker.score('dbo', 'X', 'view'));
    });

    test('a view outranks a table-valued function', () => {
        assert.ok(ranker.score('dbo', 'X', 'view') > ranker.score('dbo', 'X', 'tableValuedFunction'));
    });

    test('a CTE outranks any schema object, being local to the statement', () => {
        assert.ok(ranker.score('', 'Recent', 'cte') > ranker.score('dbo', 'Orders', 'table'));
    });
});

describe('buildObjectRanker — noise penalty', () => {
    const live = table('Orders');
    const backup = table('Orders_bak');
    const tables = [backup, live];
    const ranker = buildObjectRanker({ inScope: [], tables });

    test('a backup table sinks below the real one', () => {
        assert.deepEqual(rankedNames(ranker, tables), ['Orders', 'Orders_bak']);
    });

    test('but is still offered, rather than filtered out', () => {
        assert.ok(ranker.score('dbo', 'Orders_bak', 'table') >= 0);
        assert.equal(rankedNames(ranker, tables).length, 2);
    });
});

describe('buildObjectRanker — usage history', () => {
    const tables = [table('Aardvark'), table('Zebra')];

    test('a table the user keeps picking comes first, alphabet or not', () => {
        const usage = new Map([[rankingKey('dbo', 'Zebra'), 8]]);
        const ranker = buildObjectRanker({ inScope: [], tables, usage });

        assert.deepEqual(rankedNames(ranker, tables), ['Zebra', 'Aardvark']);
    });

    test('more uses score higher, with diminishing returns', () => {
        const key = rankingKey('dbo', 'Zebra');
        const scoreWith = (uses: number) =>
            buildObjectRanker({ inScope: [], tables, usage: new Map([[key, uses]]) })
                .score('dbo', 'Zebra', 'table');

        const step1 = scoreWith(3) - scoreWith(1);
        const step2 = scoreWith(23) - scoreWith(21);

        assert.ok(step1 > 0);
        assert.ok(step2 >= 0);
        assert.ok(step1 > step2, 'the curve has to saturate, not grow without bound');
    });

    test('a direct foreign key still beats plain familiarity', () => {
        // Otherwise the ranking stops responding to the query being written.
        const orders = table('Orders', {
            foreignKeys: [fk('Orders', 'Customers', 'CustomerId')],
        });
        const customers = table('Customers');
        const favourite = table('Zebra');
        const all = [orders, customers, favourite];

        const ranker = buildObjectRanker({
            inScope: [orders],
            tables: all,
            usage: new Map([[rankingKey('dbo', 'Zebra'), 50]]),
        });

        assert.ok(
            ranker.score('dbo', 'Customers', 'table') > ranker.score('dbo', 'Zebra', 'table'),
        );
    });

    test('decayed-away history changes nothing', () => {
        const ranker = buildObjectRanker({ inScope: [], tables, usage: new Map() });
        assert.deepEqual(rankedNames(ranker, tables), ['Aardvark', 'Zebra']);
    });
});

// ── Ranking eval ──────────────────────────────────────────────────────────────
//
// A synthetic but realistically shaped schema: a normalised core, a couple of
// views, and the leftovers every long-lived database accumulates.

const EVAL_SCHEMA: TableInfo[] = [
    table('Orders', {
        columns: [col('Id', true), col('CustomerId'), col('WarehouseId')],
        foreignKeys: [
            fk('Orders', 'Customers', 'CustomerId'),
            fk('Orders', 'Warehouses', 'WarehouseId'),
        ],
    }),
    table('OrderLines', {
        columns: [col('Id', true), col('OrderId'), col('ArticleId')],
        foreignKeys: [fk('OrderLines', 'Orders', 'OrderId'), fk('OrderLines', 'Articles', 'ArticleId')],
    }),
    table('Customers'),
    table('Warehouses'),
    table('Articles'),
    table('ArticleBarcodes', {
        columns: [col('Id', true), col('ArticleId')],
        foreignKeys: [fk('ArticleBarcodes', 'Articles', 'ArticleId')],
    }),
    table('Movements', {
        columns: [col('Id', true), col('ArticleId')],
        foreignKeys: [fk('Movements', 'Articles', 'ArticleId')],
    }),
    table('OrdersView', { isView: true }),
    table('CustomersView', { isView: true }),
    table('Orders_bak'),
    table('Orders_20240131'),
    table('tmpImport'),
    table('Aardvark'),
    table('Accounts'),
    table('AuditLog'),
];

interface EvalCase {
    what: string;
    /** Tables already written in the statement. */
    inScope: string[];
    /** Usage counts, by table name. */
    usage?: Record<string, number>;
    /** The table that should be ranked first. */
    expected: string;
}

const EVAL_CASES: EvalCase[] = [
    {
        what: 'joining from Orders offers its line table first',
        inScope: ['Orders'],
        expected: 'OrderLines',
    },
    {
        what: 'joining from OrderLines prefers Orders over an unrelated table',
        inScope: ['OrderLines'],
        expected: 'Orders',
    },
    {
        what: 'joining from Articles prefers a table that points at it',
        inScope: ['Articles'],
        expected: 'ArticleBarcodes',
    },
    {
        what: 'with nothing in scope, familiarity decides',
        inScope: [],
        usage: { Movements: 12 },
        expected: 'Movements',
    },
    {
        what: 'familiarity beats the alphabet',
        inScope: [],
        usage: { Warehouses: 6, Aardvark: 1 },
        expected: 'Warehouses',
    },
    {
        what: 'a leftover table in scope still points at the real one',
        inScope: ['Orders_bak'],
        expected: 'Orders',
    },
];

/**
 * Rank of `expected` among every candidate, 1-based.
 *
 * `Orders_bak` is the awkward case in the fixture list: it is in scope in one
 * of the cases, and a table in scope is not a candidate for itself.
 */
function rankOf(testCase: EvalCase): number {
    const inScope = EVAL_SCHEMA.filter((t) => testCase.inScope.includes(t.name));
    const usage = new Map(
        Object.entries(testCase.usage ?? {}).map(([name, uses]) => [
            rankingKey('dbo', name),
            uses,
        ]),
    );

    const ranker = buildObjectRanker({ inScope, tables: EVAL_SCHEMA, usage });
    const candidates = EVAL_SCHEMA.filter((t) => !testCase.inScope.includes(t.name));

    return rankedNames(ranker, candidates).indexOf(testCase.expected) + 1;
}

describe('ranking eval', () => {
    for (const testCase of EVAL_CASES) {
        test(testCase.what, () => {
            const rank = rankOf(testCase);
            assert.ok(rank > 0, `${testCase.expected} was not among the candidates`);
            assert.equal(
                rank,
                1,
                `expected ${testCase.expected} first, it came ${rank}th`,
            );
        });
    }

    test('mean reciprocal rank over the fixtures', () => {
        const reciprocals = EVAL_CASES.map((testCase) => {
            const rank = rankOf(testCase);
            return rank > 0 ? 1 / rank : 0;
        });
        const mrr = reciprocals.reduce((sum, r) => sum + r, 0) / reciprocals.length;

        // The floor is what protects the ranking from a change that trades one
        // case for another; raise it when the ranking genuinely improves.
        assert.ok(mrr >= 0.9, `MRR regressed to ${mrr.toFixed(3)}`);
    });
});
