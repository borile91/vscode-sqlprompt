import { format } from 'sql-formatter';
import { mapToFormatterOptions } from './out/formatter/formatOptionsMapper.js';
import { applySetLineJoining, applyKeywordRePadding } from './out/formatter/keywordPaddingFormatter.js';
import { applyDeclareFormatting } from './out/formatter/declareFormatter.js';
import { applyDdlProcFormatting, applyDdlParameterlessProcAsFormatting, applyDdlViewFormatting, applyDdlFormatting, applyDdlTableFormatting, applyProcBodyIndentation } from './out/formatter/ddlFormatter.js';
import { collapseCaseToSingleLine, applyCaseFormatting } from './out/formatter/caseFormatter.js';
import { applyLeadingCommaFormat } from './out/formatter/listFormatter.js';
import { applyJoinOnFormatting, applyOuterApplyInlineFormat } from './out/formatter/joinFormatter.js';
import { applyControlFlowIndentation } from './out/formatter/controlFlowFormatter.js';
import { applySemicolonFormatting } from './out/formatter/semicolonFormatter.js';
import * as fs from 'node:fs';

const configPath = './src/formatter/__tests__/examples/1_Vertical/config.json';
const sqlPath = '/tmp/orig_example7_vertical.sql';

const options = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const text = fs.readFileSync(sqlPath, 'utf8').trimEnd().replace(/\r\n/g, '\n');

const tabWidth = options.whitespace?.numberOfSpacesInTabs ?? 4;
const spacesInside = options.parentheses?.addSpacesInsideParentheses ?? false;
const useTabular = options.joinStatements?.join?.keywordAlignment === 'toTable' && options.lists?.placeCommasBeforeItems === true;

let formatted = format(text, mapToFormatterOptions(options));
formatted = applySetLineJoining(formatted);
formatted = formatted.replace(/^([ \t]*GO\b)[ \t]+(?=[^\s\n])/gim, '$1\n\n');
formatted = applyKeywordRePadding(formatted, useTabular);
if (spacesInside) {
    formatted = formatted.replace(/\b((?:NOT\s+)?IN|TOP|(?:NOT\s+)?EXISTS|ANY|ALL|SOME)\s*\(([^()\n]+)\)/gi,(_m, kw, content) => `${kw} ( ${content.trim()} )`);
    formatted = formatted.replace(/\b(IF|WHILE)\b(\s+)\(([^()\n]+)\)/gi,(_m, kw, sp, content) => `${kw}${sp}( ${content.trim()} )`);
}
if (!options.controlFlow?.collapseShortStatements) {
    formatted = formatted.replace(/^([ \t]*)(IF|WHILE)\b(.*?)[ \t]+((?:COMMIT|ROLLBACK|RETURN|BREAK|CONTINUE|RAISERROR|EXEC|INSERT|UPDATE|DELETE|SELECT|SET\s+@)[^;\n]*;)$/gim,(_, indent, kw, condition, body) => `${indent}${kw}${condition}\n${indent}${body}`);
}
formatted = applyDeclareFormatting(formatted, options);
formatted = applyDdlProcFormatting(formatted, options, tabWidth);
formatted = applyDdlParameterlessProcAsFormatting(formatted, options);
formatted = applyDdlViewFormatting(formatted, options);
formatted = applyDdlTableFormatting(formatted, options);
formatted = applyLeadingCommaFormat(formatted, options);
formatted = collapseCaseToSingleLine(formatted, options);
formatted = applyJoinOnFormatting(formatted, options, tabWidth);
formatted = applyCaseFormatting(formatted, options, tabWidth);
formatted = applyDdlFormatting(formatted, options);
formatted = applyControlFlowIndentation(formatted, options, tabWidth);
formatted = applySemicolonFormatting(formatted, options);
formatted = applyProcBodyIndentation(formatted, options, tabWidth);
formatted = applyOuterApplyInlineFormat(formatted, spacesInside);

const expected = text;
if (formatted === expected) {
    console.log('✅ IDEMPOTENT');
} else {
    console.log('❌ NOT IDEMPOTENT');
    // Show diff
    const expectedLines = expected.split('\n');
    const formattedLines = formatted.split('\n');
    const maxLines = Math.max(expectedLines.length, formattedLines.length);
    for (let i = 0; i < maxLines; i++) {
        if (expectedLines[i] !== formattedLines[i]) {
            console.log(`Line ${i+1}:`);
            console.log(`  EXPECTED: ${JSON.stringify(expectedLines[i])}`);
            console.log(`  GOT:      ${JSON.stringify(formattedLines[i])}`);
        }
    }
}
