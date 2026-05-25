import { readFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(new URL('./out/formatter/formatOptionsMapper.js', import.meta.url));
const { format } = require('sql-formatter');
const { applySetLineJoining, applyKeywordRePadding } = await import('./out/formatter/keywordPaddingFormatter.js');
const { applyLeadingCommaFormat } = await import('./out/formatter/listFormatter.js');
const { applyJoinOnFormatting, applyOuterApplyInlineFormat } = await import('./out/formatter/joinFormatter.js');
const { mapToFormatterOptions } = await import('./out/formatter/formatOptionsMapper.js');

const sql = readFileSync('/tmp/orig_v7.sql', 'utf8').replace(/\r\n/g, '\n');
const options = JSON.parse(readFileSync('/tmp/v1_config.json', 'utf8'));
const tabWidth = options.whitespace?.numberOfSpacesInTabs ?? 4;
const spacesInside = options.parentheses?.addSpacesInsideParentheses ?? false;
const useTabular = options.joinStatements?.join?.keywordAlignment === 'toTable' && options.lists?.placeCommasBeforeItems === true;

let s = format(sql, mapToFormatterOptions(options));
s = applySetLineJoining(s);
s = s.replace(/^([ \t]*GO\b)[ \t]+(?=[^\s\n])/gim, '$1\n\n');
s = applyKeywordRePadding(s, useTabular);
s = applyLeadingCommaFormat(s, options);

// Show state BEFORE applyOuterApplyInlineFormat, focusing on OUTER APPLY area
const lines = s.split('\n');
const oaIdx = lines.findIndex(l => /OUTER\s+APPLY/i.test(l));
console.log('=== State before applyOuterApplyInlineFormat (OUTER APPLY + WHERE area) ===');
for (let i = Math.max(0, oaIdx-2); i < Math.min(lines.length, oaIdx+35); i++) {
  const indent = lines[i].length - lines[i].trimStart().length;
  console.log(`${(i+1).toString().padStart(3)}: [${indent}] ${JSON.stringify(lines[i])}`);
}
