import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { resolveContext } from '../cursorContextResolver.js';
import { buildCompletions } from '../completionEngine.js';
import type { TableInfo, RoutineSnapshot } from '../schemaLoader.js';

const tables: TableInfo[] = [];

const routines: RoutineSnapshot = {
  scalarFunctions: [],
  tableValuedFunctions: [],
  storedProcedures: [
    {
      schema: 'dbo',
      name: 'usp_ProcessOrder',
      parameters: [
        {
          name: '@OrderId',
          dataType: 'int',
          maxLength: null,
          precision: null,
          scale: null,
          isOutput: false,
          hasDefaultValue: false,
        },
      ],
    },
  ],
};

describe('completionEngine — EXEC schema dot completions', () => {
  it('proposes stored procedures after EXEC schema dot', () => {
    const sql = 'EXEC dbo.';
    const document = TextDocument.create('file:///test.sql', 'sql', 1, sql);
    const position = document.positionAt(sql.length);
    const context = resolveContext(sql, 0, sql.length, tables);

    const items = buildCompletions(
      context,
      tables,
      routines,
      document,
      position,
      { text: sql, start: 0, end: sql.length, cursorOffset: sql.length },
    );

    const proc = items.find((i) => i.label === 'usp_ProcessOrder');
    assert.ok(proc, 'Expected stored procedure in EXEC dbo. completion list');

    const newText = typeof proc?.textEdit === 'object' ? (proc?.textEdit as any).newText : '';
    assert.match(String(newText), /usp_ProcessOrder @OrderId = \$\{1:0\}/);
  });
});
