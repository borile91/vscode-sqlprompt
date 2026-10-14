/**
 * Tests for the packed schema wire format.
 *
 * This is the new critical path: everything the completion engine knows about
 * the database now comes through these four functions, so a mistake here is a
 * silently wrong schema rather than a visible error.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { RoutineSnapshot, TableInfo } from '../schemaLoader';
import {
    WireColumns,
    WireForeignKey,
    WireObject,
    WireRoutine,
    mergeColumns,
    mergeForeignKeys,
    mergeRoutineParameters,
    splitWireObjects,
} from '../schemaWire';

const RS = '\u001e';
const US = '\u001f';

/** Builds a packed column record the way `STRING_AGG` does on the server. */
function column(
    name: string,
    dataType: string,
    maxLength: number | '' = '',
    flags = 0,
): string {
    return [name, dataType, maxLength, flags].join(US);
}

function packed(...records: string[]): string {
    return records.join(RS);
}

describe('splitWireObjects', () => {
    test('routes each sys.objects type to the right list', () => {
        const objects: WireObject[] = [
            { s: 'dbo', n: 'Orders', t: 'U' },
            { s: 'dbo', n: 'vwOrders', t: 'V' },
            { s: 'dbo', n: 'fnTotal', t: 'FN' },
            { s: 'dbo', n: 'fnClrTotal', t: 'FS' },
            { s: 'dbo', n: 'tvfLines', t: 'IF' },
            { s: 'dbo', n: 'tvfMultiLines', t: 'TF' },
            { s: 'dbo', n: 'uspSave', t: 'P' },
            { s: 'dbo', n: 'uspClrSave', t: 'PC' },
        ];

        const { tables, routines } = splitWireObjects(objects);

        assert.deepEqual(
            tables.map((t) => t.name),
            ['Orders', 'vwOrders'],
        );
        assert.deepEqual(
            routines.scalarFunctions.map((f) => f.name),
            ['fnTotal', 'fnClrTotal'],
        );
        assert.deepEqual(
            routines.tableValuedFunctions.map((f) => f.name),
            ['tvfLines', 'tvfMultiLines'],
        );
        assert.deepEqual(
            routines.storedProcedures.map((p) => p.name),
            ['uspSave', 'uspClrSave'],
        );
    });

    test('objects start out with empty details, which is what stage 0 means', () => {
        const { tables, routines } = splitWireObjects([
            { s: 'dbo', n: 'Orders', t: 'U' },
            { s: 'dbo', n: 'uspSave', t: 'P' },
        ]);

        assert.deepEqual(tables[0].columns, []);
        assert.deepEqual(tables[0].foreignKeys, []);
        assert.deepEqual(routines.storedProcedures[0].parameters, []);
    });

    test('tags tables with the database, so demand-loaded schemas stay distinct', () => {
        const { tables } = splitWireObjects([{ s: 'dbo', n: 'Orders', t: 'U' }], 'EasyStock');
        assert.equal(tables[0].database, 'EasyStock');
    });

    test('skips entries without a schema or a name, and unknown types', () => {
        const { tables, routines } = splitWireObjects([
            { s: '', n: 'Orders', t: 'U' },
            { s: 'dbo', n: '   ', t: 'U' },
            { s: 'dbo', n: 'SomeTrigger', t: 'TR' },
        ] as WireObject[]);

        assert.deepEqual(tables, []);
        assert.deepEqual(routines.storedProcedures, []);
    });

    test('trims the padding SQL Server leaves on char(2) type codes', () => {
        const { tables } = splitWireObjects([{ s: ' dbo ', n: ' Orders ', t: 'U ' }]);
        assert.deepEqual(
            tables.map((t) => [t.schema, t.name]),
            [['dbo', 'Orders']],
        );
    });
});

describe('mergeColumns', () => {
    function tableList(): TableInfo[] {
        return splitWireObjects([
            { s: 'dbo', n: 'Orders', t: 'U' },
            { s: 'Sales', n: 'Orders', t: 'U' },
        ]).tables;
    }

    test('unpacks every field and flag of a column', () => {
        const tables = tableList();
        const payload: WireColumns[] = [
            {
                s: 'dbo',
                n: 'Orders',
                c: packed(
                    column('OrderId', 'int', '', 2 | 4),
                    column('Code', 'nvarchar', 80, 1),
                    column('Total', 'decimal', 9, 8),
                    column('CreatedAt', 'datetime2', 8, 1 | 16),
                ),
            },
        ];

        assert.equal(mergeColumns(tables, payload), 4);

        const columns = tables[0].columns;
        assert.deepEqual(columns.map((c) => c.name), [
            'OrderId',
            'Code',
            'Total',
            'CreatedAt',
        ]);

        assert.deepEqual(columns[0], {
            name: 'OrderId',
            dataType: 'int',
            maxLength: null,
            isNullable: false,
            isPrimaryKey: true,
            isIdentity: true,
            isComputed: false,
            hasDefault: false,
        });

        assert.equal(columns[1].maxLength, 80);
        assert.equal(columns[1].isNullable, true);
        assert.equal(columns[2].isComputed, true);
        assert.equal(columns[3].hasDefault, true);
        assert.equal(columns[3].isNullable, true);
    });

    test('matches the table case-insensitively but keeps schemas apart', () => {
        const tables = tableList();
        mergeColumns(tables, [{ s: 'DBO', n: 'ORDERS', c: column('OrderId', 'int') }]);

        assert.equal(tables[0].columns.length, 1);
        assert.equal(tables[1].columns.length, 0, 'Sales.Orders must be untouched');
    });

    test('ignores a payload entry for a table stage 0 did not report', () => {
        const tables = tableList();
        const attached = mergeColumns(tables, [
            { s: 'dbo', n: 'Dropped', c: column('Id', 'int') },
        ]);

        assert.equal(attached, 0);
        assert.equal(tables.length, 2, 'no table may be invented by a merge');
    });

    test('replaces columns instead of appending, so a re-merge is idempotent', () => {
        const tables = tableList();
        const payload: WireColumns[] = [{ s: 'dbo', n: 'Orders', c: column('OrderId', 'int') }];

        mergeColumns(tables, payload);
        mergeColumns(tables, payload);

        assert.equal(tables[0].columns.length, 1);
    });

    test('handles a table with no columns', () => {
        const tables = tableList();
        assert.equal(mergeColumns(tables, [{ s: 'dbo', n: 'Orders', c: '' }]), 0);
        assert.deepEqual(tables[0].columns, []);
    });

    test('defaults an unreadable data type rather than dropping the column', () => {
        const tables = tableList();
        mergeColumns(tables, [{ s: 'dbo', n: 'Orders', c: ['Weird', '', '', ''].join(US) }]);

        assert.equal(tables[0].columns[0].dataType, 'unknown');
    });

    test('leaves same-named tables of other databases alone', () => {
        const connected = splitWireObjects([{ s: 'dbo', n: 'Orders', t: 'U' }], 'EasyStock').tables;
        const other = splitWireObjects([{ s: 'dbo', n: 'Orders', t: 'U' }], 'EasyMexs').tables;
        const all = [...connected, ...other];

        mergeColumns(all, [{ s: 'dbo', n: 'Orders', c: column('OrderId', 'int') }], 'EasyStock');

        assert.equal(connected[0].columns.length, 1);
        assert.equal(other[0].columns.length, 0, 'EasyMexs.dbo.Orders must be untouched');
    });
});

describe('mergeForeignKeys', () => {
    function tableList(): TableInfo[] {
        return splitWireObjects([
            { s: 'dbo', n: 'Orders', t: 'U' },
            { s: 'dbo', n: 'Customers', t: 'U' },
        ]).tables;
    }

    test('attaches a composite key with its mappings in order', () => {
        const tables = tableList();
        const payload: WireForeignKey[] = [
            {
                k: 'FK_Orders_Customers',
                ps: 'dbo',
                pt: 'Orders',
                rs: 'dbo',
                rt: 'Customers',
                m: packed(['CustomerId', 'Id'].join(US), ['TenantId', 'TenantId'].join(US)),
            },
        ];

        assert.equal(mergeForeignKeys(tables, payload), 1);
        assert.deepEqual(tables[0].foreignKeys[0], {
            name: 'FK_Orders_Customers',
            parentSchema: 'dbo',
            parentTable: 'Orders',
            referencedSchema: 'dbo',
            referencedTable: 'Customers',
            mappings: [
                { column: 'CustomerId', referencedColumn: 'Id' },
                { column: 'TenantId', referencedColumn: 'TenantId' },
            ],
        });
    });

    test('re-merging does not duplicate a constraint', () => {
        const tables = tableList();
        const payload: WireForeignKey[] = [
            {
                k: 'FK_Orders_Customers',
                ps: 'dbo',
                pt: 'Orders',
                rs: 'dbo',
                rt: 'Customers',
                m: ['CustomerId', 'Id'].join(US),
            },
        ];

        mergeForeignKeys(tables, payload);
        mergeForeignKeys(tables, payload);

        assert.equal(tables[0].foreignKeys.length, 1);
    });

    test('skips an entry missing the referenced side', () => {
        const tables = tableList();
        const attached = mergeForeignKeys(tables, [
            { k: 'FK', ps: 'dbo', pt: 'Orders', rs: '', rt: '', m: '' },
        ]);

        assert.equal(attached, 0);
        assert.deepEqual(tables[0].foreignKeys, []);
    });
});

describe('mergeRoutineParameters', () => {
    function routineList(): RoutineSnapshot {
        return splitWireObjects([
            { s: 'dbo', n: 'uspSave', t: 'P' },
            { s: 'dbo', n: 'fnTotal', t: 'FN' },
            { s: 'dbo', n: 'tvfLines', t: 'IF' },
        ]).routines;
    }

    test('unpacks parameters with precision, scale and flags', () => {
        const routines = routineList();
        const payload: WireRoutine[] = [
            {
                s: 'dbo',
                n: 'uspSave',
                t: 'P',
                p: packed(
                    ['@Id', 'int', '4', '10', '0', '0'].join(US),
                    ['@Name', 'nvarchar', '100', '0', '0', '2'].join(US),
                    ['@Result', 'int', '4', '10', '0', '1'].join(US),
                ),
            },
        ];

        assert.equal(mergeRoutineParameters(routines, payload), 1);

        const parameters = routines.storedProcedures[0].parameters;
        assert.equal(parameters.length, 3);
        assert.deepEqual(parameters[0], {
            name: '@Id',
            dataType: 'int',
            maxLength: 4,
            precision: 10,
            scale: 0,
            isOutput: false,
            hasDefaultValue: false,
        });
        assert.equal(parameters[1].hasDefaultValue, true);
        assert.equal(parameters[1].isOutput, false);
        assert.equal(parameters[2].isOutput, true);
    });

    test('a procedure and a function of the same name do not collide', () => {
        const routines = splitWireObjects([
            { s: 'dbo', n: 'Total', t: 'P' },
            { s: 'dbo', n: 'Total', t: 'FN' },
        ]).routines;

        mergeRoutineParameters(routines, [
            { s: 'dbo', n: 'Total', t: 'FN', p: ['@x', 'int', '4', '10', '0', '0'].join(US) },
        ]);

        assert.equal(routines.scalarFunctions[0].parameters.length, 1);
        assert.equal(
            routines.storedProcedures[0].parameters.length,
            0,
            'the procedure of the same name must be untouched',
        );
    });

    test('a parameterless routine stays in the snapshot with an empty list', () => {
        const routines = routineList();
        assert.equal(mergeRoutineParameters(routines, [{ s: 'dbo', n: 'fnTotal', t: 'FN', p: '' }]), 1);
        assert.deepEqual(routines.scalarFunctions[0].parameters, []);
    });

    test('ignores a routine stage 0 did not report', () => {
        const routines = routineList();
        assert.equal(
            mergeRoutineParameters(routines, [{ s: 'dbo', n: 'uspGone', t: 'P', p: '' }]),
            0,
        );
    });
});
