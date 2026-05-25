import { format } from 'sql-formatter';
import { mapToFormatterOptions } from './out/formatter/formatOptionsMapper.js';
import * as fs from 'node:fs';

const configPath = './src/formatter/__tests__/examples/1_Vertical/config.json';
const options = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const fmtOpts = mapToFormatterOptions(options);

// Test 1: STUFF with FOR XML as in example7 (already formatted)
const sql1 = `SELECT STUFF(( SELECT CHAR(10) + qry.NOTE AS [text()]
                            FROM   ( SELECT DISTINCT ad2.NOTE
                                     FROM   dbo.ACEMA_DETTAGLIO AS ad2
                                     WHERE  ad2.STAB = act.STAB ) AS qry
                          FOR XML PATH('')), 1, 1, '') AS H_NOTE`;

// Test 2: compact version
const sql2 = `SELECT STUFF(( SELECT CHAR(10)+qry.NOTE AS [text()] FROM (SELECT DISTINCT ad2.NOTE FROM dbo.ACEMA_DETTAGLIO AS ad2 WHERE ad2.STAB=act.STAB) AS qry FOR XML PATH('')),1,1,'') AS H_NOTE`;

console.log('=== Already formatted ===');
console.log(format(sql1, fmtOpts));
console.log('\n=== Compact ===');
console.log(format(sql2, fmtOpts));
