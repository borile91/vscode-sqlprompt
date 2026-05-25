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

// Replace the STUFF call with a placeholder 
// The STUFF item in example7 is:
// "                  , STUFF(( SELECT ... FOR XML PATH('')), 1, 1, '') AS H_NOTE"
// Replace with just the placeholder 
const stuffPlaceholder = 'SQLFMT_SF_PLACEHOLDER_0';
const textWithPlaceholder = text.replace(
    /STUFF\(\( SELECT CHAR\(10\)[^)]*(?:\([^)]*\))*.*?FOR XML PATH\(''\)\), 1, 1, ''\) AS H_NOTE/s,
    `${stuffPlaceholder} AS H_NOTE`
);

console.log('=== Input with placeholder ===');
textWithPlaceholder.split('\n').slice(18, 25).forEach((l,i) => console.log(`${18+i+1}: ${JSON.stringify(l)}`));

function formatSql(t, opts) {
    const tw = opts.whitespace?.numberOfSpacesInTabs ?? 4;
    const si = opts.parentheses?.addSpacesInsideParentheses ?? false;
    const ut = opts.joinStatements?.join?.keywordAlignment === 'toTable' && opts.lists?.placeCommasBeforeItems === true;
    let f = format(t, mapToFormatterOptions(opts));
    f = applySetLineJoining(f);
    f = f.replace(/^([ \t]*GO\b)[ \t]+(?=[^\s\n])/gim, '$1\n\n');
    f = applyKeywordRePadding(f, ut);
    f = applyDeclareFormatting(f, opts);
    f = applyDdlProcFormatting(f, opts, tw);
    f = applyDdlParameterlessProcAsFormatting(f, opts);
    f = applyDdlViewFormatting(f, opts);
    f = applyDdlTableFormatting(f, opts);
    f = applyLeadingCommaFormat(f, opts);
    f = collapseCaseToSingleLine(f, opts);
    f = applyJoinOnFormatting(f, opts, tw);
    f = applyCaseFormatting(f, opts, tw);
    f = applyDdlFormatting(f, opts);
    f = applyControlFlowIndentation(f, opts, tw);
    f = applySemicolonFormatting(f, opts);
    f = applyProcBodyIndentation(f, opts, tw);
    f = applyOuterApplyInlineFormat(f, si);
    return f;
}

const result = formatSql(textWithPlaceholder, options);

console.log('\n=== Pipeline output around placeholder ===');
result.split('\n').forEach((l, i) => {
    if (l.includes(stuffPlaceholder) || l.includes('H_NOTE') || (i >= 16 && i <= 26)) {
        console.log(`${i+1}: ${JSON.stringify(l)}`);
    }
});
