import { readFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(new URL('./out/formatter/formatOptionsMapper.js', import.meta.url));
const { format } = require('sql-formatter');
const { applySetLineJoining, applyKeywordRePadding } = await import('./out/formatter/keywordPaddingFormatter.js');
const { applyLeadingCommaFormat } = await import('./out/formatter/listFormatter.js');
const { applyJoinOnFormatting, applyOuterApplyInlineFormat } = await import('./out/formatter/joinFormatter.js');
const { applyDdlProcFormatting, applyDdlParameterlessProcAsFormatting, applyDdlViewFormatting, applyDdlTableFormatting, applyDdlFormatting, applyProcBodyIndentation } = await import('./out/formatter/ddlFormatter.js');
const { applyDeclareFormatting } = await import('./out/formatter/declareFormatter.js');
const { collapseCaseToSingleLine, applyCaseFormatting } = await import('./out/formatter/caseFormatter.js');
const { applyControlFlowIndentation } = await import('./out/formatter/controlFlowFormatter.js');
const { applySemicolonFormatting } = await import('./out/formatter/semicolonFormatter.js');
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
if (spacesInside) {
  s = s.replace(/\b((?:NOT\s+)?IN|TOP|(?:NOT\s+)?EXISTS|ANY|ALL|SOME)\s*\(([^()\n]+)\)/gi, (_m, kw, content) => `${kw} ( ${content.trim()} )`);
  s = s.replace(/\b(IF|WHILE)\b(\s+)\(([^()\n]+)\)/gi, (_m, kw, sp, content) => `${kw}${sp}( ${content.trim()} )`);
}
s = applyDeclareFormatting(s, options);
s = applyDdlProcFormatting(s, options, tabWidth);
s = applyDdlParameterlessProcAsFormatting(s, options);
s = applyDdlViewFormatting(s, options);
s = applyDdlTableFormatting(s, options);
s = applyLeadingCommaFormat(s, options);
s = collapseCaseToSingleLine(s, options);
s = applyJoinOnFormatting(s, options, tabWidth);
s = applyCaseFormatting(s, options, tabWidth);
s = applyDdlFormatting(s, options);
s = applyControlFlowIndentation(s, options, tabWidth);
s = applySemicolonFormatting(s, options);
s = applyProcBodyIndentation(s, options, tabWidth);

// Show state BEFORE applyOuterApplyInlineFormat, focusing on OUTER APPLY area
const lines = s.split('\n');
const oaIdx = lines.findIndex(l => /OUTER\s+APPLY/i.test(l));
console.log('=== State JUST BEFORE applyOuterApplyInlineFormat ===');
for (let i = Math.max(0, oaIdx-2); i < Math.min(lines.length, oaIdx+35); i++) {
  const indent = lines[i].length - lines[i].trimStart().length;
  console.log(`${(i+1).toString().padStart(3)}: [${indent}] ${JSON.stringify(lines[i])}`);
}

// Now apply and show final output around OUTER APPLY area
s = applyOuterApplyInlineFormat(s, spacesInside);
const lines2 = s.split('\n');
const oaIdx2 = lines2.findIndex(l => /OUTER\s+APPLY/i.test(l));
console.log('\n=== Final output around OUTER APPLY ===');
for (let i = Math.max(0, oaIdx2-1); i < Math.min(lines2.length, oaIdx2+10); i++) {
  const indent = lines2[i].length - lines2[i].trimStart().length;
  console.log(`${(i+1).toString().padStart(3)}: [${indent}] ${JSON.stringify(lines2[i])}`);
}
