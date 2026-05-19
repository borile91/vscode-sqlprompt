import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveContext } from '../cursorContextResolver.js';
import type { TableInfo } from '../schemaLoader.js';

// ── fixture ───────────────────────────────────────────────────────────────────

const orders: TableInfo = {
  schema: 'dbo',
  name: 'Orders',
  columns: [
    { name: 'OrderID', dataType: 'int', maxLength: null, isNullable: false, isPrimaryKey: true },
    { name: 'CustomerID', dataType: 'int', maxLength: null, isNullable: false, isPrimaryKey: false },
    { name: 'OrderDate', dataType: 'datetime', maxLength: null, isNullable: true, isPrimaryKey: false },
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
  foreignKeys: [
    {
      name: 'FK_Orders_Customers',
      parentSchema: 'dbo',
      parentTable: 'Orders',
      referencedSchema: 'dbo',
      referencedTable: 'Customers',
      mappings: [{ column: 'CustomerID', referencedColumn: 'CustomerID' }],
    },
  ],
};

const tables: TableInfo[] = [orders, customers];

// ── helpers ───────────────────────────────────────────────────────────────────

function ctx(sql: string) {
  return resolveContext(sql, 0, sql.length, tables);
}

function ctxAt(sql: string, marker: string) {
  const pos = sql.indexOf(marker);
  assert.ok(pos !== -1, `Marker "${marker}" not found in sql`);
  return resolveContext(sql.slice(0, pos), 0, pos, tables);
}

// ── statement kind ────────────────────────────────────────────────────────────

describe('resolveContext — statementKind', () => {
  it('detects SELECT', () => {
    assert.equal(ctx('SELECT 1').statementKind, 'select');
  });

  it('detects INSERT', () => {
    assert.equal(ctx('INSERT INTO dbo.Orders').statementKind, 'insert');
  });

  it('detects UPDATE', () => {
    assert.equal(ctx('UPDATE dbo.Orders SET OrderDate = ').statementKind, 'update');
  });

  it('detects DELETE', () => {
    assert.equal(ctx('DELETE FROM dbo.Orders').statementKind, 'delete');
  });

  it('detects CTE (WITH)', () => {
    assert.equal(ctx('WITH cte AS (SELECT 1)').statementKind, 'cte');
  });

  it('returns unknown for empty statement', () => {
    assert.equal(ctx('').statementKind, 'unknown');
  });
});

// ── clause detection ──────────────────────────────────────────────────────────

describe('resolveContext — clause', () => {
  it('detects select clause', () => {
    const c = ctx('SELECT ');
    assert.equal(c.clause, 'select');
  });

  it('detects from clause', () => {
    const c = ctx('SELECT * FROM ');
    assert.equal(c.clause, 'from');
  });

  it('detects join clause (after JOIN tableName)', () => {
    const c = ctx('SELECT * FROM dbo.Orders o INNER JOIN ');
    assert.equal(c.clause, 'join');
  });

  it('detects on clause', () => {
    const c = ctx('SELECT * FROM dbo.Orders o JOIN dbo.Customers c ON ');
    assert.equal(c.clause, 'on');
  });

  it('detects where clause', () => {
    const c = ctx('SELECT * FROM dbo.Orders o WHERE ');
    assert.equal(c.clause, 'where');
  });

  it('detects groupBy clause', () => {
    const c = ctx('SELECT * FROM dbo.Orders o GROUP BY ');
    assert.equal(c.clause, 'groupBy');
  });

  it('detects orderBy clause', () => {
    const c = ctx('SELECT * FROM dbo.Orders o ORDER BY ');
    assert.equal(c.clause, 'orderBy');
  });

  it('detects having clause', () => {
    const c = ctx('SELECT COUNT(*) FROM dbo.Orders o GROUP BY CustomerID HAVING ');
    assert.equal(c.clause, 'having');
  });

  it('detects updateSet clause', () => {
    const c = ctx('UPDATE dbo.Orders SET ');
    assert.equal(c.clause, 'updateSet');
  });

  it('detects select inside subquery', () => {
    // Cursor is inside the subquery parentheses → inner clause should be 'select'
    const sql = 'SELECT * FROM (SELECT ';
    const c = resolveContext(sql, 0, sql.length, tables);
    assert.equal(c.clause, 'select');
  });
});

// ── dot qualifier ─────────────────────────────────────────────────────────────

describe('resolveContext — dot qualifier', () => {
  it('detects alias dot (isAfterDot)', () => {
    const c = ctx('SELECT * FROM dbo.Orders o WHERE o.');
    assert.equal(c.isAfterDot, true);
    assert.deepEqual(c.qualifierChain, ['o']);
  });

  it('detects schema dot in FROM', () => {
    const c = ctx('SELECT * FROM dbo.');
    assert.equal(c.isAfterDot, true);
    assert.deepEqual(c.qualifierChain, ['dbo']);
  });

  it('not isAfterDot when no trailing dot', () => {
    const c = ctx('SELECT * FROM dbo.Orders ');
    assert.equal(c.isAfterDot, false);
  });

  it('detects two-level qualifier chain', () => {
    const c = ctx('SELECT mydb.dbo.');
    assert.equal(c.isAfterDot, true);
    assert.deepEqual(c.qualifierChain, ['mydb', 'dbo']);
  });
});

// ── visible scope ─────────────────────────────────────────────────────────────

describe('resolveContext — visibleSources', () => {
  it('extracts a FROM table with alias', () => {
    const c = ctx('SELECT * FROM dbo.Orders o ');
    const src = c.visibleSources.find((s) => s.objectName === 'Orders');
    assert.ok(src, 'Orders should be in visibleSources');
    assert.equal(src!.alias, 'o');
    assert.equal(src!.schema, 'dbo');
  });

  it('extracts two tables from FROM + JOIN', () => {
    const c = ctx('SELECT * FROM dbo.Orders o INNER JOIN dbo.Customers c ON ');
    assert.ok(c.visibleSources.some((s) => s.objectName === 'Orders'));
    assert.ok(c.visibleSources.some((s) => s.objectName === 'Customers'));
  });

  it('includes column names for resolved tables', () => {
    const c = ctx('SELECT * FROM dbo.Orders o WHERE ');
    const src = c.visibleSources.find((s) => s.objectName === 'Orders');
    assert.ok(src?.columns?.includes('OrderID'));
  });

  it('extracts CTE name', () => {
    const c = ctx('WITH cte AS (SELECT 1) SELECT * FROM cte ');
    assert.ok(c.visibleCtes.includes('cte'));
  });
});

// ── function call context ─────────────────────────────────────────────────────

describe('resolveContext — function call', () => {
  it('detects inside COUNT(', () => {
    const c = ctx('SELECT COUNT(');
    assert.equal(c.isInFunctionCall, true);
    assert.equal(c.functionName?.toUpperCase(), 'COUNT');
    assert.equal(c.parameterIndex, 0);
  });

  it('detects second parameter', () => {
    const c = ctx('SELECT SUBSTRING(col, ');
    assert.equal(c.isInFunctionCall, true);
    assert.equal(c.parameterIndex, 1);
  });

  it('not in function call at top level', () => {
    const c = ctx('SELECT col FROM ');
    assert.equal(c.isInFunctionCall, false);
  });
});

// ── currentWord ───────────────────────────────────────────────────────────────

describe('resolveContext — currentWord', () => {
  it('returns partial word at cursor', () => {
    const sql = 'SELECT Ord';
    const c = resolveContext(sql, 0, sql.length, tables);
    assert.equal(c.currentWord, 'Ord');
  });

  it('returns undefined when cursor is after a space', () => {
    const c = ctx('SELECT ');
    assert.equal(c.currentWord, undefined);
  });
});

// ── expectedKinds ─────────────────────────────────────────────────────────────

describe('resolveContext — expectedKinds', () => {
  it('select clause expects columns and functions', () => {
    const c = ctx('SELECT ');
    assert.ok(c.expectedKinds.includes('column'));
    assert.ok(c.expectedKinds.includes('function'));
  });

  it('from clause expects tables', () => {
    const c = ctx('SELECT * FROM ');
    assert.ok(c.expectedKinds.includes('table'));
  });

  it('after alias dot expects columns', () => {
    const c = ctx('SELECT * FROM dbo.Orders o WHERE o.');
    assert.deepEqual(c.expectedKinds, ['column']);
  });
});

// ── robustness ────────────────────────────────────────────────────────────────

describe('resolveContext — robustness', () => {
  it('does not throw on empty input', () => {
    assert.doesNotThrow(() => resolveContext('', 0, 0, tables));
  });

  it('does not throw on incomplete SQL', () => {
    assert.doesNotThrow(() => resolveContext('SELECT * FROM dbo.Orders WHERE o.', 0, 34, tables));
  });

  it('does not throw on deeply nested parens', () => {
    assert.doesNotThrow(() =>
      resolveContext('SELECT (((SELECT (', 0, 18, tables),
    );
  });

  it('handles statement with multiple JOINs', () => {
    const sql =
      'SELECT * FROM dbo.Orders o INNER JOIN dbo.Customers c ON o.CustomerID = c.CustomerID WHERE ';
    assert.doesNotThrow(() => resolveContext(sql, 0, sql.length, tables));
    const c = resolveContext(sql, 0, sql.length, tables);
    assert.equal(c.clause, 'where');
    assert.equal(c.visibleSources.length, 2);
  });
});
