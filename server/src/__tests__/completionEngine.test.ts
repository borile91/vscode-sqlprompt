import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CompletionItemKind } from 'vscode-languageserver/node';

import { resolveContext } from '../cursorContextResolver.js';
import { buildCompletions, quoteIdentifier } from '../completionEngine.js';
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
  {
    schema: 'dbo',
    name: 'OrderSummaryView',
    columns: [
      { name: 'OrderId', dataType: 'int', maxLength: null, isNullable: false, isPrimaryKey: false },
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

  it('FROM proposes views', () => {
    const items = getItems('SELECT * FROM ');
    const view = items.find((i) => i.label === 'dbo.OrderSummaryView');

    assert.ok(view, 'Expected view completion in FROM clause');
    const newText = typeof view?.textEdit === 'object' ? (view?.textEdit as any).newText : '';
    assert.match(String(newText), /dbo\.OrderSummaryView AS /);
  });

  it('EXEC proposes stored procedures with named parameter placeholders', () => {
    const items = getItems('EXEC ');
    const proc = items.find((i) => i.label === 'dbo.usp_RebuildTotals');

    assert.ok(proc, 'Expected stored procedure completion in EXEC clause');
    assert.match(String(proc?.insertText), /dbo\.usp_RebuildTotals @CustomerId = \$\{1:0\}/);
  });
});

// ── quoteIdentifier unit tests ────────────────────────────────────────────────

describe('quoteIdentifier', () => {
  it('leaves plain identifiers unchanged', () => {
    assert.equal(quoteIdentifier('OrderId'), 'OrderId');
    assert.equal(quoteIdentifier('_priv'), '_priv');
    assert.equal(quoteIdentifier('@var'), '@var');
    assert.equal(quoteIdentifier('#tmp'), '#tmp');
  });

  it('wraps identifiers with spaces in square brackets', () => {
    assert.equal(quoteIdentifier('Rag Soc Dest.'), '[Rag Soc Dest.]');
    assert.equal(quoteIdentifier('test fnAcemaListaArticoliCheckLotto'), '[test fnAcemaListaArticoliCheckLotto]');
  });

  it('wraps identifiers starting with a digit', () => {
    assert.equal(quoteIdentifier('1stCol'), '[1stCol]');
  });

  it('wraps identifiers with special characters', () => {
    assert.equal(quoteIdentifier('col-name'), '[col-name]');
    assert.equal(quoteIdentifier('col.name'), '[col.name]');
  });

  it('does not double-wrap already-bracketed identifiers', () => {
    assert.equal(quoteIdentifier('[Already Quoted]'), '[Already Quoted]');
  });
});

// ── bracket-quoting in expansion / dot completions ────────────────────────────

const specialTables: TableInfo[] = [
  {
    schema: 'tAcema',
    name: 'test fnAcemaListaArticoliCheckLotto',
    columns: [
      { name: 'Id', dataType: 'int', maxLength: null, isNullable: false, isPrimaryKey: true },
      { name: 'Rag Soc Dest.', dataType: 'nvarchar', maxLength: 100, isNullable: true, isPrimaryKey: false },
      { name: 'NormalCol', dataType: 'int', maxLength: null, isNullable: false, isPrimaryKey: false },
    ],
    foreignKeys: [],
  },
];

const emptyRoutines: RoutineSnapshot = {
  scalarFunctions: [],
  tableValuedFunctions: [],
  storedProcedures: [],
};

function getSpecialItems(sql: string) {
  const document = TextDocument.create('file:///test.sql', 'sql', 1, sql);
  const position = document.positionAt(sql.length);
  const context = resolveContext(sql, 0, sql.length, specialTables);
  return buildCompletions(
    context,
    specialTables,
    emptyRoutines,
    document,
    position,
    { text: sql, start: 0, end: sql.length, cursorOffset: sql.length },
  );
}

describe('completionEngine — bracket-quoting for special identifiers', () => {
  it('wraps table name with spaces in brackets when completing after schema dot', () => {
    const sql = 'SELECT * FROM tAcema.';
    const items = getSpecialItems(sql);
    const table = items.find((i) => i.label === 'test fnAcemaListaArticoliCheckLotto');
    assert.ok(table, 'Expected table with spaces in completion list');
    const newText = typeof table?.textEdit === 'object' ? (table?.textEdit as any).newText : '';
    assert.ok(
      String(newText).includes('[test fnAcemaListaArticoliCheckLotto]'),
      `Expected brackets in table insertion, got: ${newText}`,
    );
  });

  it('wraps column name with spaces in brackets when expanding alias.*', () => {
    const expandSql = 'SELECT t.* FROM tAcema.[test fnAcemaListaArticoliCheckLotto] AS t';
    const cursorOffset = expandSql.indexOf('*') + 1;
    const doc = TextDocument.create('file:///test.sql', 'sql', 1, expandSql);
    const pos = doc.positionAt(cursorOffset);
    const ctx = resolveContext(expandSql, 0, cursorOffset, specialTables);
    const expandItems = buildCompletions(
      ctx,
      specialTables,
      emptyRoutines,
      doc,
      pos,
      { text: expandSql, start: 0, end: expandSql.length, cursorOffset },
    );
    const expandItem = expandItems.find((i) => i.label === 'Expand wildcard to columns');
    assert.ok(expandItem, 'Expected star expansion completion');
    const newText = typeof expandItem?.textEdit === 'object' ? (expandItem?.textEdit as any).newText : '';
    assert.ok(
      String(newText).includes('[Rag Soc Dest.]'),
      `Expected brackets around column with spaces, got: ${newText}`,
    );
    assert.ok(
      String(newText).includes('t.NormalCol'),
      'NormalCol should not be bracketed (plain identifier)',
    );
  });

  it('wraps column name with spaces when completing after table.', () => {
    const sql = 'SELECT od. FROM tAcema.[test fnAcemaListaArticoliCheckLotto] AS od';
    const doc = TextDocument.create('file:///test.sql', 'sql', 1, sql);
    const dotPos = sql.indexOf('od.') + 3;
    const pos = doc.positionAt(dotPos);
    const ctx = resolveContext(sql, 0, dotPos, specialTables);
    const items = buildCompletions(
      ctx,
      specialTables,
      emptyRoutines,
      doc,
      pos,
      { text: sql, start: 0, end: sql.length, cursorOffset: dotPos },
    );
    const col = items.find((i) => i.label === 'Rag Soc Dest.');
    assert.ok(col, 'Expected column with spaces in completion list');
    const insertText = col?.insertText ?? (col?.textEdit as any)?.newText ?? '';
    assert.equal(insertText, '[Rag Soc Dest.]', `Expected bracket-quoted column, got: ${insertText}`);
  });

  it('does not bracket plain column names', () => {
    const sql = 'SELECT od. FROM tAcema.[test fnAcemaListaArticoliCheckLotto] AS od';
    const doc = TextDocument.create('file:///test.sql', 'sql', 1, sql);
    const dotPos = sql.indexOf('od.') + 3;
    const pos = doc.positionAt(dotPos);
    const ctx = resolveContext(sql, 0, dotPos, specialTables);
    const items = buildCompletions(
      ctx,
      specialTables,
      emptyRoutines,
      doc,
      pos,
      { text: sql, start: 0, end: sql.length, cursorOffset: dotPos },
    );
    const col = items.find((i) => i.label === 'NormalCol');
    assert.ok(col, 'Expected NormalCol in completion list');
    const insertText = col?.insertText ?? (col?.textEdit as any)?.newText ?? '';
    assert.equal(insertText, 'NormalCol', `Plain column should not be bracketed, got: ${insertText}`);
  });
});

// ── EXEC with space in procedure name ─────────────────────────────────────────

const specialRoutines: RoutineSnapshot = {
  scalarFunctions: [],
  tableValuedFunctions: [],
  storedProcedures: [
    {
      schema: 'tAcema',
      name: 'test fnAcemaListaArticoliCheckLotto',
      parameters: [
        {
          name: '@Lotto',
          dataType: 'nvarchar',
          maxLength: 50,
          precision: null,
          scale: null,
          isOutput: false,
          hasDefaultValue: false,
        },
      ],
    },
  ],
};

describe('completionEngine — bracket-quoting for stored procedure names', () => {
  it('wraps procedure name with spaces in brackets in EXEC completion', () => {
    const sql = 'EXEC ';
    const document = TextDocument.create('file:///test.sql', 'sql', 1, sql);
    const position = document.positionAt(sql.length);
    const context = resolveContext(sql, 0, sql.length, []);
    const items = buildCompletions(
      context,
      [],
      specialRoutines,
      document,
      position,
      { text: sql, start: 0, end: sql.length, cursorOffset: sql.length },
    );

    const proc = items.find((i) => i.label === 'tAcema.test fnAcemaListaArticoliCheckLotto');
    assert.ok(proc, 'Expected procedure in EXEC completion list');
    const insertText = String(proc?.insertText ?? '');
    assert.ok(
      insertText.includes('tAcema.[test fnAcemaListaArticoliCheckLotto]'),
      `Expected brackets around procedure name with spaces, got: ${insertText}`,
    );
  });

  it('wraps procedure name with spaces in brackets when completing after schema dot in EXEC', () => {
    const sql = 'EXEC tAcema.';
    const document = TextDocument.create('file:///test.sql', 'sql', 1, sql);
    const position = document.positionAt(sql.length);
    const context = resolveContext(sql, 0, sql.length, []);
    const items = buildCompletions(
      context,
      [],
      specialRoutines,
      document,
      position,
      { text: sql, start: 0, end: sql.length, cursorOffset: sql.length },
    );

    const proc = items.find((i) => i.label === 'test fnAcemaListaArticoliCheckLotto');
    assert.ok(proc, 'Expected procedure in EXEC schema-dot completion list');
    const newText = typeof proc?.textEdit === 'object' ? (proc?.textEdit as any).newText : '';
    assert.ok(
      String(newText).includes('[test fnAcemaListaArticoliCheckLotto]'),
      `Expected brackets around procedure name, got: ${newText}`,
    );
  });
});
