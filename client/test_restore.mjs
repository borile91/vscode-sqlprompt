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

// Extract STUFF call from the original text
// Pattern: the complete STUFF item in a SELECT list
const stuffPattern = /( *), (STUFF\(\( SELECT[\s\S]*?FOR XML PATH\(''\)\), 1, 1, ''\) AS H_NOTE)/;
const stuffMatch = text.match(stuffPattern);
if (!stuffMatch) { console.log('STUFF NOT FOUND'); process.exit(1); }

const stuffPrefix = stuffMatch[1]; // leading spaces before comma
const stuffContent = stuffMatch[2]; // the STUFF(...) AS H_NOTE part

console.log('Found STUFF at prefix:', JSON.stringify(stuffPrefix));
console.log('STUFF starts with:', stuffContent.slice(0, 60));

const placeholder = 'SQLFMT_PROTECTED_STUFF_0';
const textWithPlaceholder = text.replace(stuffPattern, `$1, ${placeholder} AS H_NOTE`);

function formatSql(t, opts) {
    const tw = opts.whitespace?.numberOfSpacesInTabs ?? 4;
    const si = opts.parentheses?.addSpacesInsideParentheses ?? false;
    let f = format(t, mapToFormatterOptions(opts));
    f = applySetLineJoining(f);
    f = f.replace(/^([ \t]*GO\b)[ \t]+(?=[^\s\n])/gim, '$1\n\n');
    f = applyKeywordRePadding(f, opts.joinStatements?.join?.keywordAlignment === 'toTable' && opts.lists?.placeCommasBeforeItems === true);
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

let result = formatSql(textWithPlaceholder, options);

// Restore the STUFF call
// Find the line with placeholder
const lines = result.split('\n');
const placeholderLineIdx = lines.findIndex(l => l.includes(placeholder));
if (placeholderLineIdx === -1) { console.log('PLACEHOLDER NOT FOUND IN OUTPUT'); process.exit(1); }

console.log('\nPlaceholder line:', JSON.stringify(lines[placeholderLineIdx]));

// Replace placeholder line with original STUFF content
const placeholderLine = lines[placeholderLineIdx];
const placeholderIndentMatch = placeholderLine.match(/^( *), /);
const indent = placeholderIndentMatch ? placeholderIndentMatch[1] : '';

// The STUFF content should be at indent+2 characters from line start
// Replace: "  , PLACEHOLDER AS H_NOTE" → "  , STUFF(( SELECT..."
lines[placeholderLineIdx] = indent + ', ' + stuffContent;

result = lines.join('\n');

// Compare with original
const expected = text;
if (result === expected) {
    console.log('\n✅ PERFECT MATCH - idempotent!');
} else {
    console.log('\n❌ Differences remain:');
    const expLines = expected.split('\n');
    const resLines = result.split('\n');
    let count = 0;
    for (let i = 0; i < Math.max(expLines.length, resLines.length); i++) {
        if (expLines[i] !== resLines[i]) {
            if (count < 20) {
                console.log(`Line ${i+1}:`);
                console.log(`  EXP: ${JSON.stringify(expLines[i])}`);
                console.log(`  GOT: ${JSON.stringify(resLines[i])}`);
            }
            count++;
        }
    }
    console.log(`Total: ${count} differing lines`);
}
