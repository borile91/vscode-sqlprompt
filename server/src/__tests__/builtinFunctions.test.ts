import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TextDocument } from 'vscode-languageserver-textdocument';

import {
  BUILTIN_FUNCTIONS,
  builtinSignature,
  builtinSnippet,
  builtinsForClause,
  findBuiltin,
} from '../builtinFunctions.js';
import { resolveContext } from '../cursorContextResolver.js';
import { buildCompletions, buildSignatureHelp } from '../completionEngine.js';
import type { RoutineSnapshot, TableInfo } from '../schemaLoader.js';

const tables: TableInfo[] = [
  {
    schema: 'dbo',
    name: 'Orders',
    columns: [
      { name: 'OrderId', dataType: 'int', maxLength: null, isNullable: false, isPrimaryKey: true },
      { name: 'OrderDate', dataType: 'datetime', maxLength: null, isNullable: true, isPrimaryKey: false },
    ],
    foreignKeys: [],
  },
];
const routines: RoutineSnapshot = {
  scalarFunctions: [
    {
      schema: 'dbo',
      name: 'fnTotal',
      parameters: [
        { name: '@OrderId', dataType: 'int', maxLength: null, precision: null, scale: null, isOutput: false, hasDefaultValue: false },
      ],
    },
  ],
  tableValuedFunctions: [],
  storedProcedures: [],
};

function complete(sql: string) {
  const document = TextDocument.create('file:///t.sql', 'sql', 1, sql);
  const context = resolveContext(sql, 0, sql.length, tables);
  return buildCompletions(context, tables, routines, document, document.positionAt(sql.length), {
    text: sql, start: 0, end: sql.length, cursorOffset: sql.length,
  });
}

function signature(sql: string) {
  const context = resolveContext(sql, 0, sql.length, tables);
  return buildSignatureHelp(context, routines, sql);
}

const labels = (sql: string) => complete(sql).map((i) => String(i.label));

describe('builtinFunctions — catalogo', () => {
  it('nomi unici e in maiuscolo', () => {
    const names = BUILTIN_FUNCTIONS.map((fn) => fn.name);
    assert.equal(new Set(names).size, names.length);
    assert.ok(names.every((name) => name === name.toUpperCase()));
  });

  it('snippet con i soli parametri obbligatori, firma con i facoltativi tra []', () => {
    const charindex = findBuiltin('charindex')!;
    assert.equal(builtinSnippet(charindex), 'CHARINDEX(${1:search}, ${2:string})');
    assert.equal(builtinSignature(charindex), 'CHARINDEX(search, string, [start])');
    assert.equal(builtinSnippet(findBuiltin('GETDATE')!), 'GETDATE()');
  });

  it('aggregate solo dove valgono, funzioni di finestra solo in SELECT e ORDER BY', () => {
    const where = builtinsForClause('where').map((fn) => fn.name);
    assert.ok(!where.includes('MAX'));
    assert.ok(!where.includes('ROW_NUMBER'));
    assert.ok(where.includes('ISNULL'));
    assert.ok(builtinsForClause('select').some((fn) => fn.name === 'ROW_NUMBER'));
    assert.ok(builtinsForClause('having').some((fn) => fn.name === 'MAX'));
  });
});

describe('builtinFunctions — completamento', () => {
  it('in SELECT propone MIN, MAX, AVG con il segnaposto', () => {
    const min = complete('SELECT MI').find((i) => i.label === 'MIN');
    assert.equal((min?.textEdit as any)?.newText, 'MIN(${1:expression})');
    assert.equal(min?.detail, 'MIN(expression)');
    assert.ok(labels('SELECT ').includes('AVG'));
  });

  it('in WHERE propone ISNULL ma non le aggregate', () => {
    const out = labels('SELECT * FROM dbo.Orders o WHERE ');
    assert.ok(out.includes('ISNULL'));
    assert.ok(!out.includes('MAX'));
  });

  it('dentro gli argomenti di una funzione: colonne e funzioni, non statement', () => {
    const out = labels('SELECT ISNULL(o.OrderDate, ) FROM dbo.Orders o'.slice(0, 26));
    assert.ok(out.includes('GETDATE'));
    assert.ok(!out.includes('SELECT'));
    assert.ok(!out.includes('ssf'));
  });

  it('primo argomento di DATEADD: le datepart', () => {
    assert.deepEqual(labels('SELECT DATEADD(').slice(0, 3), ['year', 'quarter', 'month']);
  });

  it('CAST(x AS e CONVERT(: i tipi di dato', () => {
    assert.ok(labels('SELECT CAST(1 AS ').includes('varchar(50)'));
    assert.ok(labels('SELECT CONVERT(').includes('int'));
  });

  it('dentro VALUES ( niente parole chiave di inizio statement', () => {
    assert.ok(!labels('INSERT INTO dbo.Orders (OrderId) VALUES (').includes('SELECT'));
  });

  it('dentro IN ( resta proponibile una sottoquery', () => {
    assert.ok(labels('SELECT * FROM dbo.Orders o WHERE o.OrderId IN (').includes('SELECT'));
  });
});

describe('builtinFunctions — signature help', () => {
  it('evidenzia il parametro sotto il cursore', () => {
    const help = signature('SELECT DATEADD(day, 1, ');
    assert.equal(help?.signatures[0].label, 'DATEADD(datepart, number, date)');
    assert.equal(help?.activeParameter, 2);
    const [start, end] = help!.signatures[0].parameters![2].label as [number, number];
    assert.equal(help!.signatures[0].label.slice(start, end), 'date');
  });

  it('CAST: dopo AS il parametro attivo è il tipo', () => {
    assert.equal(signature('SELECT CAST(o.OrderId AS ')?.activeParameter, 1);
    assert.equal(signature('SELECT CAST(o.Order')?.activeParameter, 0);
  });

  it('funzioni dello schema: parametri con il tipo', () => {
    const help = signature('SELECT dbo.fnTotal(');
    assert.equal(help?.signatures[0].label, 'dbo.fnTotal(@OrderId int)');
  });

  it('fuori da una chiamata nessuna firma', () => {
    assert.equal(signature('SELECT o.OrderId FROM dbo.Orders o'), null);
  });
});
