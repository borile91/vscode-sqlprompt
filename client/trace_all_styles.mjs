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

function runFullPipeline(sql, options) {
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
  s = applyOuterApplyInlineFormat(s, spacesInside);
  return s;
}

const styles = [
  { name: '1_Vertical', dir: '__tests__/examples/1_Vertical' },
  { name: '2_Inline', dir: '__tests__/examples/2_Inline' },
  { name: '3_Tsqlt', dir: '__tests__/examples/3_Tsqlt' },
  { name: '4_Scripting', dir: '__tests__/examples/4_Scripting' },
];

for (const style of styles) {
  const sqlPath = `./src/formatter/${style.dir}/example7.sql`;
  const cfgPath = `./src/formatter/${style.dir}/config.json`;
  try {
    const origSql = readFileSync(sqlPath.replace('src/', '').replace('__tests__', 'src/formatter/__tests__'), 'utf8').replace(/\r\n/g, '\n');
    // Actually read from git
  } catch(e) {}
}

// Read from git using the file we've already extracted
const BASE = '/tmp/workspace/borile91/vscode-sqlprompt';

for (const style of styles) {
  const sqlFile = `${BASE}/client/src/formatter/__tests__/examples/${style.name}/example7.sql`;
  const cfgFile = `${BASE}/client/src/formatter/__tests__/examples/${style.name}/config.json`;
  const cfgFileStr = cfgFile.replace('client/', '');
  
  // Get original from git (rev 7e80d54)
  const { execSync } = await import('child_process');
  const origSql = execSync(`cd ${BASE} && git show 7e80d54:client/src/formatter/__tests__/examples/${style.name}/example7.sql`, {encoding: 'utf8'}).replace(/\r\n/g, '\n');
  const options = JSON.parse(readFileSync(cfgFile, 'utf8'));
  
  const formatted = runFullPipeline(origSql, options);
  
  const origLines = origSql.split('\n');
  const fmtLines = formatted.split('\n');
  
  let diffCount = 0;
  console.log(`\n=== Style: ${style.name} ===`);
  for (let i = 0; i < Math.max(origLines.length, fmtLines.length); i++) {
    if (origLines[i] !== fmtLines[i]) {
      diffCount++;
      if (diffCount <= 8) {
        console.log(`  Line ${i+1}:`);
        console.log(`    Expected: ${JSON.stringify(origLines[i])}`);
        console.log(`    Got:      ${JSON.stringify(fmtLines[i])}`);
      }
    }
  }
  console.log(`  Total diffs: ${diffCount}`);
}
