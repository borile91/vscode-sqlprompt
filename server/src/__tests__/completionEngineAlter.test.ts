import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { resolveContext } from '../cursorContextResolver.js';
import { buildCompletions } from '../completionEngine.js';
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
  });

  it('keeps suggesting tables in a FROM after the ALTER header', () => {
    const items = complete('ALTER VIEW ui.vwA AS SELECT * FROM ');
    assert.ok(items.some((i) => String(i.label).includes('vwOrdini')));
  });
});
