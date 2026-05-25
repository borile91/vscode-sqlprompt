import { format } from 'sql-formatter';
import * as fs from 'node:fs';

const configPath = './src/formatter/__tests__/examples/1_Vertical/config.json';
const options = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Test: compact STUFF call with tabularLeft + expressionWidth:9999
const sql = `SELECT ad.ARTI AS H_ARTI, a.DSCR AS H_DSCR, STUFF((SELECT CHAR(10)+qry.NOTE AS [text()] FROM (SELECT DISTINCT ad2.NOTE FROM dbo.ACEMA_DETTAGLIO AS ad2 WHERE ad2.STAB=act.STAB AND ISNULL(ad2.NOTE,'') <> '') AS qry FOR XML PATH('')),1,1,'') AS H_NOTE, ad.ARTI FROM dbo.TEST`;

const result = format(sql, {
    language: 'tsql',
    tabWidth: 4,
    indentStyle: 'tabularLeft',
    expressionWidth: 9999,
    keywordCase: 'upper',
});

console.log(result);
