import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CompletionItemKind } from 'vscode-languageserver/node';

import { resolveContext } from '../cursorContextResolver.js';
import { buildCompletions } from '../completionEngine.js';
import type { TableInfo, RoutineSnapshot } from '../schemaLoader.js';

const tables: TableInfo[] = [
  {
    schema: 'dbo',
    name: 'Orders',
    columns: [
      { name: 'OrderId', dataType: 'int', maxLength: null, isNullable: false, isPrimaryKey: true },
      { name: 'CustomerId', dataType: 'int', maxLength: null, isNullable: false, isPrimaryKey: false },
    ],
    foreignKeys: [],
  },
];

const routines: RoutineSnapshot = {
  scalarFunctions: [
    {
      schema: 'dbo',
      name: 'fn_OrderTotal',
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
  tableValuedFunctions: [
    {
      schema: 'dbo',
      name: 'fn_OpenOrders',
      parameters: [
        {
          name: '@CustomerId',
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
  storedProcedures: [
    {
      schema: 'dbo',
      name: 'usp_RebuildTotals',
      parameters: [
        {
          name: '@CustomerId',
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

function getItems(sql: string) {
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

describe('completionEngine — routines by clause', () => {
  it('SELECT proposes scalar functions with invocation placeholders', () => {
    const items = getItems('SELECT ');
    const scalar = items.find((i) => i.label === 'dbo.fn_OrderTotal');

    assert.ok(scalar, 'Expected scalar function completion in SELECT clause');
    assert.equal(scalar?.detail, 'Scalar function');
    assert.match(String(scalar?.insertText), /dbo\.fn_OrderTotal\(\$\{1:0\}\)/);
  });

  it('inside a function call proposes parameter names', () => {
    const items = getItems('SELECT dbo.fn_OrderTotal(');
    const parameter = items.find((i) => i.label === '@OrderId');

    assert.ok(parameter, 'Expected parameter completion inside function call');
    assert.equal(parameter?.kind, CompletionItemKind.Variable);
    assert.equal(parameter?.insertText, '0');
  });

  it('FROM proposes table-valued functions', () => {
    const items = getItems('SELECT * FROM ');
    const tvf = items.find((i) => i.label === 'dbo.fn_OpenOrders');

    assert.ok(tvf, 'Expected table-valued function completion in FROM clause');
    const newText = typeof tvf?.textEdit === 'object' ? (tvf?.textEdit as any).newText : '';
    assert.match(String(newText), /dbo\.fn_OpenOrders\(\$\{1:0\}\) AS /);
  });

  it('EXEC proposes stored procedures with named parameter placeholders', () => {
    const items = getItems('EXEC ');
    const proc = items.find((i) => i.label === 'dbo.usp_RebuildTotals');

    assert.ok(proc, 'Expected stored procedure completion in EXEC clause');
    assert.match(String(proc?.insertText), /dbo\.usp_RebuildTotals @CustomerId = \$\{1:0\}/);
  });
});
