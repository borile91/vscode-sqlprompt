import { readFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(new URL('./out/formatter/formatOptionsMapper.js', import.meta.url));
const { format } = require('sql-formatter');
const { mapToFormatterOptions } = await import('./out/formatter/formatOptionsMapper.js');

const sql = readFileSync('/tmp/orig_v7.sql', 'utf8').replace(/\r\n/g, '\n');
// Read 4_Scripting original
const { execSync } = await import('child_process');
const origSql = execSync(`cd /tmp/workspace/borile91/vscode-sqlprompt && git show 7e80d54:client/src/formatter/__tests__/examples/4_Scripting/example7.sql`, {encoding: 'utf8'}).replace(/\r\n/g, '\n');
const options = JSON.parse(readFileSync('/tmp/workspace/borile91/vscode-sqlprompt/client/src/formatter/__tests__/examples/4_Scripting/config.json', 'utf8'));

console.log('sql-formatter options:', JSON.stringify(mapToFormatterOptions(options)));
const result = format(origSql, mapToFormatterOptions(options));
const lines = result.split('\n');
console.log('=== First 30 lines of sql-formatter output for 4_Scripting ===');
for (let i = 0; i < 30; i++) {
  console.log(`${(i+1).toString().padStart(3)}: ${JSON.stringify(lines[i])}`);
}
