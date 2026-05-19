import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildScope } from '../scopeBuilder.js';
import { tokenize } from '../sqlLexer.js';
import type { TableInfo } from '../schemaLoader.js';

// ── fixtures ──────────────────────────────────────────────────────────────────

const orders: TableInfo = {
  schema: 'dbo',
  name: 'Orders',
  columns: [
    { name: 'OrderID', dataType: 'int', maxLength: null, isNullable: false, isPrimaryKey: true },
    { name: 'CustomerID', dataType: 'int', maxLength: null, isNullable: false, isPrimaryKey: false },
  ],
  foreignKeys: [],
};

const customers: TableInfo = {
  schema: 'dbo',
  name: 'Customers',
  columns: [
    { name: 'CustomerID', dataType: 'int', maxLength: null, isNullable: false, isPrimaryKey: true },
    { name: 'Name', dataType: 'varchar', maxLength: 100, isNullable: true, isPrimaryKey: false },
  ],
  foreignKeys: [],
};

const tables: TableInfo[] = [orders, customers];

function scope(sql: string) {
  const tokens = tokenize(sql);
  return buildScope(tokens, sql.length, tables);
}

// ── FROM extraction ───────────────────────────────────────────────────────────

describe('buildScope — FROM extraction', () => {
  it('extracts a single FROM table with explicit alias', () => {
    const { visibleSources } = scope('SELECT * FROM dbo.Orders o ');
    assert.equal(visibleSources.length, 1);
    assert.equal(visibleSources[0].objectName, 'Orders');
    assert.equal(visibleSources[0].alias, 'o');
    assert.equal(visibleSources[0].schema, 'dbo');
  });

  it('extracts a table with AS alias', () => {
    const { visibleSources } = scope('SELECT * FROM dbo.Orders AS ord ');
    assert.equal(visibleSources[0].alias, 'ord');
  });

  it('generates auto-alias when no alias given', () => {
    const { visibleSources } = scope('SELECT * FROM dbo.Orders WHERE ');
    assert.ok(visibleSources[0].alias, 'should generate alias');
  });

  it('extracts two tables from FROM + JOIN', () => {
    const { visibleSources } = scope(
      'SELECT * FROM dbo.Orders o INNER JOIN dbo.Customers c ON o.CustomerID = c.CustomerID',
    );
    assert.equal(visibleSources.length, 2);
    const names = visibleSources.map((s) => s.objectName);
    assert.ok(names.includes('Orders'));
    assert.ok(names.includes('Customers'));
  });

  it('populates columns from schema', () => {
    const { visibleSources } = scope('SELECT * FROM dbo.Orders o ');
    const colNames = visibleSources[0].columns;
    assert.ok(colNames?.includes('OrderID'));
    assert.ok(colNames?.includes('CustomerID'));
  });
});

// ── CTE extraction ────────────────────────────────────────────────────────────

describe('buildScope — CTE extraction', () => {
  it('detects a single CTE', () => {
    const { visibleCtes } = scope('WITH cte AS (SELECT 1) SELECT * FROM cte ');
    assert.ok(visibleCtes.includes('cte'));
  });

  it('detects multiple CTEs', () => {
    const { visibleCtes } = scope(
      'WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a ',
    );
    assert.ok(visibleCtes.includes('a'));
    assert.ok(visibleCtes.includes('b'));
  });

  it('CTE appears in visibleSources after FROM', () => {
    const { visibleSources } = scope(
      'WITH cte AS (SELECT 1) SELECT * FROM cte ',
    );
    assert.ok(
      visibleSources.some((s) => s.objectName === 'cte'),
      'cte should appear in visibleSources',
    );
  });

  it('extracts column names from CTE SELECT list', () => {
    const { visibleSources } = scope(
      'WITH cte AS (SELECT o.OrderID, o.CustomerID AS Cust FROM dbo.Orders o) SELECT * FROM cte c ',
    );
    const cteSrc = visibleSources.find((s) => s.objectName === 'cte');
    assert.ok(cteSrc, 'cte should be in visibleSources');
    assert.ok(cteSrc?.columns?.includes('OrderID'), 'should extract OrderID');
    assert.ok(cteSrc?.columns?.includes('Cust'), 'should extract AS alias Cust');
  });
});

// ── alias list ────────────────────────────────────────────────────────────────

describe('buildScope — visibleAliases', () => {
  it('lists aliases for all resolved sources', () => {
    const { visibleAliases } = scope(
      'SELECT * FROM dbo.Orders o INNER JOIN dbo.Customers c ON o.CustomerID = c.CustomerID ',
    );
    assert.ok(visibleAliases.includes('o'));
    assert.ok(visibleAliases.includes('c'));
  });
});

// ── quoted identifiers ────────────────────────────────────────────────────────

describe('buildScope — quoted identifiers', () => {
  it('resolves bracket-quoted table name', () => {
    const { visibleSources } = scope('SELECT * FROM dbo.[Orders] o ');
    assert.equal(visibleSources.length, 1);
    assert.equal(visibleSources[0].objectName, 'Orders');
  });

  it('resolves bracket-quoted schema', () => {
    const { visibleSources } = scope('SELECT * FROM [dbo].[Orders] o ');
    assert.equal(visibleSources.length, 1);
    assert.equal(visibleSources[0].schema, 'dbo');
  });
});

// ── edge cases ────────────────────────────────────────────────────────────────

describe('buildScope — edge cases', () => {
  it('returns empty scope for empty input', () => {
    const { visibleSources, visibleCtes, visibleAliases } = scope('');
    assert.equal(visibleSources.length, 0);
    assert.equal(visibleCtes.length, 0);
    assert.equal(visibleAliases.length, 0);
  });

  it('does not resolve unknown table', () => {
    const { visibleSources } = scope('SELECT * FROM dbo.NonExistentTable n ');
    const resolved = visibleSources.filter((s) => s.columns?.length);
    assert.equal(resolved.length, 0);
  });

  it('includes all table references in the statement regardless of cursor position', () => {
    // The scope builder uses the full token stream so that tables declared
    // in the FROM/JOIN clause are visible even when the cursor is earlier in
    // the statement (e.g. typing in SELECT before FROM is written).
    const sql = 'SELECT * FROM dbo.Orders o INNER JOIN dbo.Customers c ON o.CustomerID = c.CustomerID';
    const tokens = tokenize(sql);
    // Cursor is inside "SELECT *" — both tables must still be visible.
    const { visibleSources } = buildScope(tokens, 9, tables);
    assert.equal(visibleSources.length, 2);
    const names = visibleSources.map((s) => s.objectName);
    assert.ok(names.includes('Orders'));
    assert.ok(names.includes('Customers'));
  });

  it('scopes table refs to cursor depth — outer SELECT sees CTE alias, not inner base table', () => {
    // Cursor is in the outer SELECT (depth 0).
    // Only depth-0 FROM/JOIN should be visible (the CTE alias).
    // The inner base table (dbo.Orders) is at depth 1 and must NOT appear.
    const sql = 'WITH cte AS (SELECT o.OrderID FROM dbo.Orders o) SELECT * FROM cte c WHERE ';
    const tokens = tokenize(sql);
    const cursorOffset = sql.length; // end of statement = outer SELECT level (depth 0)
    const { visibleSources } = buildScope(tokens, cursorOffset, tables);
    const names = visibleSources.map((s) => s.objectName);
    // The CTE alias is visible; the inner dbo.Orders must NOT be at depth 0
    assert.ok(names.includes('cte'), 'cte alias should be visible at depth 0');
    assert.ok(!names.includes('Orders'), 'inner base table must not leak to depth-0 scope');
  });

  it('scopes table refs to cursor depth — cursor inside CTE body sees inner base table', () => {
    // Cursor is inside the CTE body (depth 1).
    // The inner dbo.Orders table should be visible; the CTE alias (depth 0) must not.
    const sql = 'WITH cte AS (SELECT o.OrderID FROM dbo.Orders o WHERE ';
    const tokens = tokenize(sql);
    const cursorOffset = sql.length; // cursor is inside the CTE parens (depth 1)
    const { visibleSources } = buildScope(tokens, cursorOffset, tables);
    const names = visibleSources.map((s) => s.objectName);
    assert.ok(names.includes('Orders'), 'inner base table should be visible at depth 1');
  });
});
