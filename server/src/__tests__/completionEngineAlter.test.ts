import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { resolveContext } from '../cursorContextResolver.js';
import { buildCompletions } from '../completionEngine.js';
import { listModulesFromSnapshot } from '../alterModules.js';
import type { TableInfo, RoutineSnapshot } from '../schemaLoader.js';

const tables: TableInfo[] = [
  { schema: 'ui', name: 'vwOrdini', columns: [], foreignKeys: [] },
];

const routines: RoutineSnapshot = {
  scalarFunctions: [],
  tableValuedFunctions: [],
  storedProcedures: [],
};

function complete(sql: string) {
  const document = TextDocument.create('file:///test.sql', 'sql', 1, sql);
  const position = document.positionAt(sql.length);
  const context = resolveContext(sql, 0, sql.length, tables);
  return buildCompletions(
    context,
    tables,
    routines,
    document,
    position,
    { text: sql, start: 0, end: sql.length, cursorOffset: sql.length },
  );
}

describe('completionEngine — ALTER <object> name', () => {
  it('offers nothing while the name of the object to alter is typed', () => {
    assert.deepEqual(complete('ALTER VIEW ui.vwordi'), []);
    assert.deepEqual(complete('ALTER PROCEDURE '), []);
    assert.deepEqual(complete('alter function dbo.'), []);
    assert.deepEqual(complete('ALTER PROCEDURE [My Proc'), []);
    assert.deepEqual(complete('ALTER VIEW [ui].[vw Ord'), []);
  });

  it('keeps suggesting tables in a FROM after the ALTER header', () => {
    const items = complete('ALTER VIEW ui.vwA AS SELECT * FROM ');
    assert.ok(items.some((i) => String(i.label).includes('vwOrdini')));
  });
});

describe('listModulesFromSnapshot — direct-connection fallback', () => {
  const snapshotTables: TableInfo[] = [
    { database: 'App', schema: 'dbo', name: 'Orders', columns: [], foreignKeys: [] },
    { database: 'App', schema: 'ui', name: 'vwOrders', columns: [], foreignKeys: [], isView: true },
    { database: 'Other', schema: 'dbo', name: 'vwRemote', columns: [], foreignKeys: [], isView: true },
  ];
  const snapshotRoutines: RoutineSnapshot = {
    scalarFunctions: [{ schema: 'dbo', name: 'fnScalar', parameters: [] }],
    tableValuedFunctions: [{ schema: 'dbo', name: 'fnTable', parameters: [] }],
    storedProcedures: [
      { schema: 'sales', name: 'spB', parameters: [] },
      { schema: 'dbo', name: 'spA', parameters: [] },
    ],
  };

  it('lists the views of the connected database only', () => {
    assert.deepEqual(listModulesFromSnapshot('view', snapshotTables, snapshotRoutines, 'app'), [
      { schema: 'ui', name: 'vwOrders' },
    ]);
  });

  it('lists procedures and both kinds of functions, sorted', () => {
    assert.deepEqual(listModulesFromSnapshot('procedure', snapshotTables, snapshotRoutines), [
      { schema: 'dbo', name: 'spA' },
      { schema: 'sales', name: 'spB' },
    ]);
    assert.deepEqual(
      listModulesFromSnapshot('function', snapshotTables, snapshotRoutines).map((m) => m.name),
      ['fnScalar', 'fnTable'],
    );
  });
});
