/**
 * Estrae lo schema reale da localhost e lo salva come snapshot JSON, nella
 * stessa forma che il client invia al server LSP (`sqlPrompt/updateSchemaSnapshot`).
 *
 * Uso:  SA_PW=... node dump-schema.mjs EasyStock_Master EasyMexs_Master
 */
import sql from 'mssql';
import { writeFileSync, mkdirSync } from 'node:fs';

import { fileURLToPath } from 'node:url';
import * as nodePath from 'node:path';
const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.resolve(HERE, '..', '..', '..', '..');
const DIR = process.env.SQLPROMPT_LIVE_SCHEMA || nodePath.join(REPO, '.live-schema');
const OUT = nodePath.join(DIR, 'schema');
const dbs = process.argv.slice(2);
if (!dbs.length) throw new Error('passa almeno un nome di database');
if (!process.env.SA_PW) throw new Error('SA_PW non impostata');
mkdirSync(DIR, { recursive: true });

const TABLES_SQL = `
SELECT s.name AS [schema], o.name AS [table], o.type AS objType,
       c.name AS col, ty.name AS dataType, c.max_length AS maxLength,
       c.is_nullable AS isNullable, c.column_id AS colId,
       CASE WHEN ic.column_id IS NOT NULL THEN 1 ELSE 0 END AS isPk
FROM sys.objects o
JOIN sys.schemas s ON s.schema_id = o.schema_id
JOIN sys.columns c ON c.object_id = o.object_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
LEFT JOIN sys.indexes i ON i.object_id = o.object_id AND i.is_primary_key = 1
LEFT JOIN sys.index_columns ic ON ic.object_id = o.object_id
     AND ic.index_id = i.index_id AND ic.column_id = c.column_id
WHERE o.type IN ('U','V')
ORDER BY s.name, o.name, c.column_id;`;

const FK_SQL = `
SELECT fk.name AS fkName,
       ps.name AS parentSchema, pt.name AS parentTable,
       rs.name AS refSchema,    rt.name AS refTable,
       pc.name AS parentCol,    rc.name AS refCol
FROM sys.foreign_keys fk
JOIN sys.tables pt ON pt.object_id = fk.parent_object_id
JOIN sys.schemas ps ON ps.schema_id = pt.schema_id
JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id;`;

const ROUTINES_SQL = `
SELECT s.name AS [schema], o.name AS [name], o.type AS objType,
       p.name AS paramName, ty.name AS dataType, p.max_length AS maxLength,
       p.precision, p.scale, p.is_output AS isOutput, p.has_default_value AS hasDefault
FROM sys.objects o
JOIN sys.schemas s ON s.schema_id = o.schema_id
LEFT JOIN sys.parameters p ON p.object_id = o.object_id
LEFT JOIN sys.types ty ON ty.user_type_id = p.user_type_id
WHERE o.type IN ('P','FN','IF','TF')
ORDER BY s.name, o.name, p.parameter_id;`;

for (const db of dbs) {
  const pool = await sql.connect({
    server: 'localhost', database: db, user: 'sa', password: process.env.SA_PW,
    options: { encrypt: true, trustServerCertificate: true },
    requestTimeout: 120000,
  });

  // ── tabelle + colonne ──────────────────────────────────────────────────────
  const byKey = new Map();
  for (const r of (await pool.request().query(TABLES_SQL)).recordset) {
    const key = `${r.schema}.${r.table}`;
    if (!byKey.has(key)) byKey.set(key, { schema: r.schema, name: r.table, columns: [], foreignKeys: [] });
    byKey.get(key).columns.push({
      name: r.col, dataType: r.dataType, maxLength: r.maxLength,
      isNullable: !!r.isNullable, isPrimaryKey: !!r.isPk,
    });
  }

  // ── foreign key ────────────────────────────────────────────────────────────
  const fkByTable = new Map();
  for (const r of (await pool.request().query(FK_SQL)).recordset) {
    const key = `${r.parentSchema}.${r.parentTable}`;
    if (!fkByTable.has(key)) fkByTable.set(key, new Map());
    const perFk = fkByTable.get(key);
    if (!perFk.has(r.fkName)) {
      perFk.set(r.fkName, {
        name: r.fkName, parentSchema: r.parentSchema, parentTable: r.parentTable,
        referencedSchema: r.refSchema, referencedTable: r.refTable, mappings: [],
      });
    }
    perFk.get(r.fkName).mappings.push({ column: r.parentCol, referencedColumn: r.refCol });
  }
  for (const [key, perFk] of fkByTable) {
    if (byKey.has(key)) byKey.get(key).foreignKeys = [...perFk.values()];
  }

  // ── routine ────────────────────────────────────────────────────────────────
  const routines = { scalarFunctions: [], tableValuedFunctions: [], storedProcedures: [] };
  const rByKey = new Map();
  for (const r of (await pool.request().query(ROUTINES_SQL)).recordset) {
    const key = `${r.objType.trim()}|${r.schema}.${r.name}`;
    if (!rByKey.has(key)) rByKey.set(key, { type: r.objType.trim(), schema: r.schema, name: r.name, parameters: [] });
    if (r.paramName) {
      rByKey.get(key).parameters.push({
        name: r.paramName, dataType: r.dataType, maxLength: r.maxLength,
        precision: r.precision, scale: r.scale,
        isOutput: !!r.isOutput, hasDefaultValue: !!r.hasDefault,
      });
    }
  }
  for (const r of rByKey.values()) {
    const entry = { schema: r.schema, name: r.name, parameters: r.parameters };
    if (r.type === 'P') routines.storedProcedures.push(entry);
    else if (r.type === 'FN') routines.scalarFunctions.push(entry);
    else routines.tableValuedFunctions.push(entry);
  }

  const databases = (await pool.request()
    .query(`SELECT name FROM sys.databases WHERE state_desc = 'ONLINE' ORDER BY name`))
    .recordset.map((r) => r.name);

  const snapshot = { database: db, tables: [...byKey.values()], routines, databases };
  writeFileSync(`${OUT}-${db}.json`, JSON.stringify(snapshot));
  console.log(
    `${db}: ${snapshot.tables.length} tabelle/viste, ` +
    `${snapshot.tables.reduce((n, t) => n + t.columns.length, 0)} colonne, ` +
    `${routines.storedProcedures.length} proc, ${routines.scalarFunctions.length} fn scalari, ` +
    `${routines.tableValuedFunctions.length} tvf`,
  );
  await pool.close();
}
