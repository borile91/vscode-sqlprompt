import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { resolveContext } from '../cursorContextResolver.js';
import { buildCompletions } from '../completionEngine.js';
import type { TableInfo, RoutineSnapshot } from '../schemaLoader.js';

const noRoutines: RoutineSnapshot = {
  scalarFunctions: [],
  tableValuedFunctions: [],
  storedProcedures: [],
};

const tables: TableInfo[] = [
  {
    schema: 'dbo',
    name: 'Righe',
    foreignKeys: [],
    columns: [
      { name: 'Id', dataType: 'int', maxLength: 4, isNullable: false, isPrimaryKey: true, isIdentity: true },
      { name: 'Totale', dataType: 'int', maxLength: 4, isNullable: false, isPrimaryKey: false, isComputed: true },
      { name: 'Codice', dataType: 'varchar', maxLength: 20, isNullable: false, isPrimaryKey: false },
      { name: 'Nome', dataType: 'nvarchar', maxLength: 100, isNullable: false, isPrimaryKey: false },
      { name: 'Note', dataType: 'varchar', maxLength: -1, isNullable: true, isPrimaryKey: false },
      { name: 'Creato', dataType: 'datetime', maxLength: 8, isNullable: false, isPrimaryKey: false, hasDefault: true },
    ],
  },
];

function itemsFor(sql: string, schema: TableInfo[] = tables) {
  const document = TextDocument.create('file:///ins.sql', 'sql', 1, sql);
  const context = resolveContext(sql, 0, sql.length, schema);
  return buildCompletions(
    context,
    schema,
    noRoutines,
    document,
    document.positionAt(sql.length),
    { text: sql, start: 0, end: sql.length, cursorOffset: sql.length },
  );
}

const snippets = (sql: string, schema?: TableInfo[]) =>
  itemsFor(sql, schema).filter((i) => String(i.label).startsWith('★'));

describe('INSERT column list and VALUES', () => {
  const both = () => snippets('INSERT INTO dbo.Righe ');

  it('offers both variants once the target table is written', () => {
    assert.deepEqual(both().map((i) => i.label), [
      '★ Columns + VALUES (all)',
      '★ Columns + VALUES (required only)',
    ]);
  });

  it('leaves IDENTITY and computed columns out', () => {
    const text = both()[0].textEdit!.newText;
    assert.match(text, /^\(Codice, Nome, Note, Creato\)/, text);
  });

  it('emits one tab stop per column, labelled with its type', () => {
    const text = both()[0].textEdit!.newText;
    assert.match(
      text,
      /VALUES \(\$\{1:varchar\(20\)\}, \$\{2:nvarchar\(50\)\}, \$\{3:varchar\(max\)\}, \$\{4:datetime\}\)\$0/,
      text,
    );
  });

  it('keeps only NOT NULL columns without a default in the required variant', () => {
    const text = both()[1].textEdit!.newText;
    assert.match(text, /^\(Codice, Nome\)\nVALUES \(\$\{1:varchar\(20\)\}, \$\{2:nvarchar\(50\)\}\)\$0$/, text);
  });

  it('reports how many columns were skipped', () => {
    assert.match(both()[0].detail!, /4 column\(s\) of dbo\.Righe, 2 skipped/);
    assert.match(both()[1].detail!, /2 column\(s\) of dbo\.Righe, 4 skipped/);
  });

  it('inserts as a snippet, so the tab stops are live', () => {
    assert.equal(both()[0].insertTextFormat, 2 /* InsertTextFormat.Snippet */);
  });

  it('omits the required variant when it would repeat the full list', () => {
    const oneColumn: TableInfo[] = [{
      schema: 'dbo', name: 'T', foreignKeys: [],
      columns: [{ name: 'A', dataType: 'int', maxLength: 4, isNullable: false, isPrimaryKey: false }],
    }];
    assert.equal(snippets('INSERT INTO dbo.T ', oneColumn).length, 1);
  });

  it('offers nothing for a table whose every column is generated', () => {
    const generated: TableInfo[] = [{
      schema: 'dbo', name: 'G', foreignKeys: [],
      columns: [{ name: 'Id', dataType: 'int', maxLength: 4, isNullable: false, isPrimaryKey: true, isIdentity: true }],
    }];
    assert.equal(snippets('INSERT INTO dbo.G ', generated).length, 0);
  });

  it('keeps IDENTITY out of the list inside the parentheses too', () => {
    const expand = itemsFor('INSERT INTO dbo.Righe (').find((i) => i.label === '★ Expand all columns');
    assert.ok(expand);
    assert.equal(expand!.textEdit!.newText, 'Codice, Nome, Note, Creato');
  });

  it('falls back to every column when the snapshot carries no metadata', () => {
    // An older client sends columns without isIdentity/hasDefault: absent reads
    // as false, so the list is complete rather than wrong.
    const legacy: TableInfo[] = [{
      schema: 'dbo', name: 'L', foreignKeys: [],
      columns: [
        { name: 'Id', dataType: 'int', maxLength: 4, isNullable: false, isPrimaryKey: true },
        { name: 'Nome', dataType: 'varchar', maxLength: 10, isNullable: false, isPrimaryKey: false },
      ],
    }];
    const items = snippets('INSERT INTO dbo.L ', legacy);
    assert.equal(items.length, 1);
    assert.match(items[0].textEdit!.newText, /^\(Id, Nome\)/);
  });
});
