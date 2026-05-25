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

// Normalize SQL: collapse extra whitespace while preserving string literals and line comments
function normalizeSql(sql) {
    // We'll collapse runs of whitespace to a single space/newline
    // Strategy: tokenize into: string literals, -- comments, and other tokens
    let result = '';
    let i = 0;
    while (i < sql.length) {
        // Single-quoted string literal
        if (sql[i] === "'") {
            let j = i + 1;
            while (j < sql.length) {
                if (sql[j] === "'" && sql[j+1] === "'") { j += 2; continue; }
                if (sql[j] === "'") { j++; break; }
                j++;
            }
            result += sql.slice(i, j);
            i = j;
            continue;
        }
        // Line comment
        if (sql[i] === '-' && sql[i+1] === '-') {
            let j = i;
            while (j < sql.length && sql[j] !== '\n') j++;
            result += sql.slice(i, j); // keep comment text but not newline
            i = j;
            continue;
        }
        // Whitespace: collapse to single space
        if (/\s/.test(sql[i])) {
            result += ' ';
            while (i < sql.length && /\s/.test(sql[i])) i++;
            continue;
        }
        result += sql[i++];
    }
    return result.trim();
}

function formatSql(text, options) {
    const tabWidth = options.whitespace?.numberOfSpacesInTabs ?? 4;
    const spacesInside = options.parentheses?.addSpacesInsideParentheses ?? false;
    const useTabular = options.joinStatements?.join?.keywordAlignment === 'toTable' && options.lists?.placeCommasBeforeItems === true;
    
    // Normalize first
    const normalized = normalizeSql(text);
    
    let formatted = format(normalized, mapToFormatterOptions(options));
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
    return formatted;
}

const configPath = './src/formatter/__tests__/examples/1_Vertical/config.json';
const sqlPath = '/tmp/orig_example7_vertical.sql';

const options = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const text = fs.readFileSync(sqlPath, 'utf8').trimEnd().replace(/\r\n/g, '\n');

const result = formatSql(text, options);
const expected = text;

if (result === expected) {
    console.log('✅ IDEMPOTENT (with normalize-first)');
} else {
    console.log('❌ NOT IDEMPOTENT');
    // Also check: does format(format(text)) === format(text)?
    const result2 = formatSql(result, options);
    if (result === result2) {
        console.log('✅ Double-formatting is idempotent (but first pass differs from example7)');
    } else {
        console.log('❌ Even double-formatting is not idempotent');
    }
    
    // Show first diff
    const expectedLines = expected.split('\n');
    const resultLines = result.split('\n');
    const maxLines = Math.max(expectedLines.length, resultLines.length);
    let diffCount = 0;
    for (let i = 0; i < maxLines; i++) {
        if (expectedLines[i] !== resultLines[i]) {
            if (diffCount < 5) {
                console.log(`Line ${i+1}:`);
                console.log(`  EXPECTED: ${JSON.stringify(expectedLines[i])}`);
                console.log(`  GOT:      ${JSON.stringify(resultLines[i])}`);
            }
            diffCount++;
        }
    }
    console.log(`Total differing lines: ${diffCount}`);
}
