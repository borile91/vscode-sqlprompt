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

const { execSync } = await import('child_process');
const origSql = execSync(`cd /tmp/workspace/borile91/vscode-sqlprompt && git show 7e80d54:client/src/formatter/__tests__/examples/4_Scripting/example7.sql`, {encoding: 'utf8'}).replace(/\r\n/g, '\n');
const options = JSON.parse(readFileSync('/tmp/workspace/borile91/vscode-sqlprompt/client/src/formatter/__tests__/examples/4_Scripting/config.json', 'utf8'));
const tabWidth = options.whitespace?.numberOfSpacesInTabs ?? 4;
const spacesInside = options.parentheses?.addSpacesInsideParentheses ?? false;
const useTabular = options.joinStatements?.join?.keywordAlignment === 'toTable' && options.lists?.placeCommasBeforeItems === true;
console.log('useTabular:', useTabular, 'spacesInside:', spacesInside);

let s = format(origSql, mapToFormatterOptions(options));
s = applySetLineJoining(s);
s = s.replace(/^([ \t]*GO\b)[ \t]+(?=[^\s\n])/gim, '$1\n\n');
s = applyKeywordRePadding(s, useTabular);
s = applyDeclareFormatting(s, options);
s = applyDdlProcFormatting(s, options, tabWidth);

// Show after applyDdlProcFormatting - first 30 lines
console.log('=== After applyDdlProcFormatting (first 30 lines) ===');
const lines = s.split('\n');
for (let i = 0; i < 30; i++) {
  console.log(`${(i+1).toString().padStart(3)}: ${JSON.stringify(lines[i])}`);
}
