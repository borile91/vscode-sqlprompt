import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  collidesWithExistingAlias,
  findAliasRenameTarget,
  formatAliasName,
} from '../aliasRename.js';

/** Renames every occurrence, to make the expected result readable. */
function rename(sql: string, cursor: number, newName: string): string | null {
  const target = findAliasRenameTarget(sql, cursor);
  if (!target) return null;

  let result = sql;
  for (const occurrence of [...target.occurrences].reverse()) {
    result = result.slice(0, occurrence.start) + newName + result.slice(occurrence.end);
  }
  return result;
}

describe('findAliasRenameTarget — detection', () => {
  it('finds the alias from its definition', () => {
    const sql = 'SELECT o.Id FROM dbo.Orders o WHERE o.Id = 1';
    const target = findAliasRenameTarget(sql, sql.lastIndexOf('Orders o') + 'Orders o'.length);

    assert.ok(target);
    assert.equal(target?.alias, 'o');
    assert.equal(target?.occurrences.length, 3);
  });

  it('finds the alias from a usage', () => {
    const sql = 'SELECT o.Id FROM dbo.Orders o';
    const target = findAliasRenameTarget(sql, 8); // on the "o" of "o.Id"

    assert.ok(target);
    assert.equal(target?.alias, 'o');
  });

  it('returns null on a column', () => {
    const sql = 'SELECT o.Id FROM dbo.Orders o';
    assert.equal(findAliasRenameTarget(sql, sql.indexOf('Id') + 1), null);
  });

  it('returns null on the table name', () => {
    const sql = 'SELECT o.Id FROM dbo.Orders o';
    assert.equal(findAliasRenameTarget(sql, sql.indexOf('Orders') + 2), null);
  });

  it('returns null on a keyword', () => {
    const sql = 'SELECT o.Id FROM dbo.Orders o';
    assert.equal(findAliasRenameTarget(sql, 2), null);
  });

  it('returns null when the statement declares no alias', () => {
    const sql = 'SELECT Id FROM dbo.Orders';
    assert.equal(findAliasRenameTarget(sql, sql.indexOf('Orders') + 2), null);
  });
});

describe('findAliasRenameTarget — rename', () => {
  it('renames the definition and every usage', () => {
    const sql = 'SELECT o.Id, o.Total FROM dbo.Orders o WHERE o.Id = 1 ORDER BY o.Total';
    assert.equal(
      rename(sql, sql.indexOf('o.Id'), 'ord'),
      'SELECT ord.Id, ord.Total FROM dbo.Orders ord WHERE ord.Id = 1 ORDER BY ord.Total',
    );
  });

  it('renames an AS alias', () => {
    const sql = 'SELECT o.Id FROM dbo.Orders AS o JOIN dbo.Rows AS r ON r.OrderId = o.Id';
    assert.equal(
      rename(sql, sql.indexOf('AS o') + 3, 'ord'),
      'SELECT ord.Id FROM dbo.Orders AS ord JOIN dbo.Rows AS r ON r.OrderId = ord.Id',
    );
  });

  it('leaves the other aliases alone', () => {
    const sql = 'SELECT o.Id, r.Qty FROM dbo.Orders o JOIN dbo.Rows r ON r.OrderId = o.Id';
    assert.equal(
      rename(sql, sql.indexOf('r.Qty'), 'rows'),
      'SELECT o.Id, rows.Qty FROM dbo.Orders o JOIN dbo.Rows rows ON rows.OrderId = o.Id',
    );
  });

  it('does not touch a column that has the same name as the alias', () => {
    const sql = 'SELECT t.Id, Total FROM dbo.Totals t WHERE t.Total > 0';
    assert.equal(
      rename(sql, sql.indexOf('t.Id'), 'x'),
      'SELECT x.Id, Total FROM dbo.Totals x WHERE x.Total > 0',
    );
  });

  it('renames the bare alias of an UPDATE', () => {
    const sql = 'UPDATE o SET o.Total = 1 FROM dbo.Orders o WHERE o.Id = 2';
    assert.equal(
      rename(sql, sql.indexOf('FROM dbo.Orders o') + 'FROM dbo.Orders '.length, 'ord'),
      'UPDATE ord SET ord.Total = 1 FROM dbo.Orders ord WHERE ord.Id = 2',
    );
  });

  it('renames a bracketed alias', () => {
    const sql = 'SELECT [my alias].Id FROM dbo.Orders AS [my alias]';
    assert.equal(
      rename(sql, sql.indexOf('[my alias].Id') + 2, '[o]'),
      'SELECT [o].Id FROM dbo.Orders AS [o]',
    );
  });

  it('renames the alias of a CTE reference', () => {
    const sql = 'WITH c AS (SELECT 1 AS x) SELECT k.x FROM c k WHERE k.x = 1';
    assert.equal(
      rename(sql, sql.indexOf('k.x'), 'cte'),
      'WITH c AS (SELECT 1 AS x) SELECT cte.x FROM c cte WHERE cte.x = 1',
    );
  });
});

describe('formatAliasName', () => {
  it('keeps a plain identifier', () => {
    assert.equal(formatAliasName('ord'), 'ord');
  });

  it('brackets a name with spaces', () => {
    assert.equal(formatAliasName('my alias'), '[my alias]');
  });

  it('unwraps an already bracketed name', () => {
    assert.equal(formatAliasName('[ord]'), 'ord');
  });

  it('rejects an empty name', () => {
    assert.equal(formatAliasName('   '), null);
  });

  it('rejects a reserved keyword', () => {
    assert.equal(formatAliasName('select'), null);
  });
});

describe('collidesWithExistingAlias', () => {
  const sql = 'SELECT ot.STAB FROM dbo.ORDINI_TESTATA ot JOIN dbo.ORDINI_DETTAGLIO od ON od.STAB = ot.STAB';
  const onOd = sql.indexOf('od ON');

  it('lists the aliases of the other table references', () => {
    const target = findAliasRenameTarget(sql, onOd);
    assert.deepEqual(target?.otherAliases, ['ot']);
  });

  it('detects a rename onto an alias already used in the statement', () => {
    const target = findAliasRenameTarget(sql, onOd);
    assert.equal(collidesWithExistingAlias(target!, 'ot'), true);
  });

  it('ignores case when comparing', () => {
    const target = findAliasRenameTarget(sql, onOd);
    assert.equal(collidesWithExistingAlias(target!, 'OT'), true);
  });

  it('sees through the brackets of a delimited name', () => {
    const target = findAliasRenameTarget(sql, onOd);
    assert.equal(collidesWithExistingAlias(target!, '[ot]'), true);
  });

  it('allows a name no other table uses', () => {
    const target = findAliasRenameTarget(sql, onOd);
    assert.equal(collidesWithExistingAlias(target!, 'det'), false);
  });

  it('allows renaming an alias onto itself', () => {
    const target = findAliasRenameTarget(sql, onOd);
    assert.equal(collidesWithExistingAlias(target!, 'od'), false);
  });

  it('reports no other aliases for a single-table statement', () => {
    const single = 'SELECT a.ARTI FROM dbo.ARTICOLI a';
    const target = findAliasRenameTarget(single, single.indexOf('ARTICOLI a') + 'ARTICOLI '.length);
    assert.deepEqual(target?.otherAliases, []);
  });
});
