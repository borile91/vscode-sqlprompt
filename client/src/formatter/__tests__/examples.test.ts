import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { format } from 'sql-formatter';
import type { SqlPromptStyleJson } from '../styleLoader.js';
import { mapToFormatterOptions } from '../formatOptionsMapper.js';
import { applySetLineJoining, applyKeywordRePadding } from '../keywordPaddingFormatter.js';
import { applyDeclareFormatting } from '../declareFormatter.js';
import {
    applyDdlProcFormatting,
    applyDdlViewFormatting,
    applyDdlFormatting,
    applyProcBodyIndentation,
} from '../ddlFormatter.js';
import { collapseCaseToSingleLine, applyCaseFormatting } from '../caseFormatter.js';
import { applyLeadingCommaFormat } from '../listFormatter.js';
import { applyJoinOnFormatting } from '../joinFormatter.js';
import { applyControlFlowIndentation, removeBlankLinesBeforeEnd } from '../controlFlowFormatter.js';
import { applySemicolonFormatting } from '../semicolonFormatter.js';
import { applyExecParamFormatting } from '../execFormatter.js';

// Same pipeline as SqlFormattingProvider.provideDocumentFormattingEdits
function formatSql(text: string, options: SqlPromptStyleJson): string {
    const tabWidth = options.whitespace?.numberOfSpacesInTabs ?? 4;
    const spacesInside = options.parentheses?.addSpacesInsideParentheses ?? false;
    let formatted = format(text, mapToFormatterOptions(options));
    formatted = applySetLineJoining(formatted);
    formatted = applyKeywordRePadding(formatted);
    // Apply spaces-inside-parens for SQL keyword operators early so that
    // subsequent alignment steps (leading comma, JOIN) see the final spacing.
    if (spacesInside) {
        formatted = formatted.replace(
            /\b((?:NOT\s+)?IN|TOP|(?:NOT\s+)?EXISTS|ANY|ALL|SOME)\s*\(([^()\n]+)\)/gi,
            (_m, kw, content) => `${kw} ( ${content.trim()} )`,
        );
    }
    // Expand collapsed single-line IF/WHILE statements back to two lines.
    formatted = formatted.replace(
        /^([ \t]*)(IF|WHILE)\b(.*?)[ \t]+((?:COMMIT|ROLLBACK|RETURN|BREAK|CONTINUE|RAISERROR|EXEC|INSERT|UPDATE|DELETE|SELECT|SET\s+@)[^;\n]*;)$/gim,
        (_, indent, kw, condition, body) =>
            `${indent}${kw}${condition}\n${indent}    ${body}`,
    );
    formatted = applyDeclareFormatting(formatted, options);
    formatted = applyDdlProcFormatting(formatted, options, tabWidth);
    formatted = applyDdlViewFormatting(formatted, options);
    formatted = collapseCaseToSingleLine(formatted, options);
    formatted = applyLeadingCommaFormat(formatted, options);
    formatted = applyJoinOnFormatting(formatted, options, tabWidth);
    formatted = applyCaseFormatting(formatted, options, tabWidth);
    formatted = applyDdlFormatting(formatted, options);
    formatted = applyControlFlowIndentation(formatted, options, tabWidth);
    formatted = applySemicolonFormatting(formatted, options);
    formatted = applyProcBodyIndentation(formatted, options, tabWidth);
    formatted = applyExecParamFormatting(formatted, options);
    formatted = removeBlankLinesBeforeEnd(formatted);
    // Remove blank line before GO batch separator.
    formatted = formatted.replace(/\n\n([ \t]*GO\b)/gi, '\n$1');
    // Remove blank lines between consecutive SET @variable assignments.
    formatted = formatted.replace(
        /([ \t]*SET[ \t]+@\w+[^\n]*\n)\n+([ \t]*SET[ \t]+@\w+)/gm,
        '$1$2',
    );
    // Collapse short EXISTS/NOT EXISTS subqueries from multi-line to 2-line form.
    formatted = formatted.replace(
        /^([ \t]*[^\n]*?(?:NOT\s+)?EXISTS\s*\()\n[ \t]*(SELECT[^\n]*)\n((?:[ \t]*(?:FROM|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY)[^\n]*\n)+)[ \t]*\)/gim,
        (_, openPart, select, restClauses) => {
            const sp = spacesInside ? ' ' : '';
            const contentIndent = ' '.repeat(openPart.length + sp.length);
            const clauses = restClauses
                .trimEnd()
                .split('\n')
                .map((l: string) => contentIndent + l.trim())
                .join('\n');
            return openPart + sp + select + '\n' + clauses + (spacesInside ? ' )' : ')');
        },
    );
    // Remove space before ( in schema-qualified function/procedure calls.
    // Only match horizontal whitespace (not newlines).
    formatted = formatted.replace(/(\.\w+)[ \t]+\(/g, '$1(');
    // Remove spurious space before ( in RAISERROR.
    formatted = formatted.replace(/\bRAISERROR\s+\(/gi, 'RAISERROR(');
    if (spacesInside) {
        formatted = formatted.replace(
            /\((NOLOCK|UPDLOCK|ROWLOCK|TABLOCK|TABLOCKX|HOLDLOCK|READPAST|NOWAIT|READCOMMITTEDLOCK|REPEATABLEREAD|SERIALIZABLE|SNAPSHOT|FORCESCAN|FORCESEEK|PAGLOCK)\)/gi,
            '( $1 )',
        );
        // Add space after VALUES ( for INSERT … VALUES statements.
        formatted = formatted.replace(/\bVALUES\s*\((?!\s)/gi, 'VALUES ( ');
    }
    return formatted;
}

interface ParsedExample {
    configPath: string;
    query: string;
}

function parseExampleFile(content: string): ParsedExample {
    const configMatch = content.match(/^#\s*config\s*\n(.*?)(?:\n|$)/m);
    const queryMatch = content.match(/^#\s*query\s*\n([\s\S]*)$/m);
    if (!configMatch || !queryMatch) {
        throw new Error('Example file does not have expected # config / # query sections');
    }
    return {
        configPath: configMatch[1].trim(),
        query: queryMatch[1].trimEnd(),
    };
}

// Resolve examples directory relative to this source file (before compilation the
// compiled output sits two levels above the workspace root: out/formatter/__tests__)
const examplesDir = path.resolve(__dirname, '..', '..', '..', '..', '.vscode', 'debug', 'examples');

const exampleFiles = fs
    .readdirSync(examplesDir)
    .filter(f => f.endsWith('.md'))
    .sort();

describe('formatter examples — idempotent formatting', () => {
    for (const fileName of exampleFiles) {
        const filePath = path.join(examplesDir, fileName);
        const content = fs.readFileSync(filePath, 'utf8');
        let parsed: ParsedExample;
        try {
            parsed = parseExampleFile(content);
        } catch (e) {
            it(`${fileName} — skipped: ${(e as Error).message}`, () => {});
            continue;
        }

        let styleOptions: SqlPromptStyleJson;
        try {
            const raw = fs.readFileSync(parsed.configPath, 'utf8');
            styleOptions = JSON.parse(raw) as SqlPromptStyleJson;
        } catch (e) {
            it(`${fileName} — skipped: cannot load config ${parsed.configPath}: ${(e as Error).message}`, () => {});
            continue;
        }

        it(`${fileName} — formatting is idempotent`, () => {
            const result = formatSql(parsed.query, styleOptions);
            assert.equal(result, parsed.query);
        });
    }
});
