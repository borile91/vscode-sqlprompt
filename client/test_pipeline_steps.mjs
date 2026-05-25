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
const options = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const text = fs.readFileSync('/tmp/orig_example7_vertical.sql', 'utf8').trimEnd().replace(/\r\n/g, '\n');
const tabWidth = options.whitespace?.numberOfSpacesInTabs ?? 4;
const spacesInside = options.parentheses?.addSpacesInsideParentheses ?? false;
const useTabular = options.joinStatements?.join?.keywordAlignment === 'toTable' && options.lists?.placeCommasBeforeItems === true;

let formatted = format(text, mapToFormatterOptions(options));
formatted = applySetLineJoining(formatted);
formatted = formatted.replace(/^([ \t]*GO\b)[ \t]+(?=[^\s\n])/gim, '$1\n\n');
formatted = applyKeywordRePadding(formatted, useTabular);

// Show state after keyword re-padding
console.log('=== AFTER applyKeywordRePadding ===');
const lines = formatted.split('\n');
// Show lines around STUFF
for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('STUFF') || (i > 14 && i < 65)) {
        console.log(`${i+1}: ${JSON.stringify(lines[i])}`);
    }
}
