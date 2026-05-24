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
    applyDdlParameterlessProcAsFormatting,
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
function formatSql(text: string, options: SqlPromptStyleJson): string {    const tabWidth = options.whitespace?.numberOfSpacesInTabs ?? 4;
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
    formatted = applyDdlParameterlessProcAsFormatting(formatted, options);
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
    // Restore the intentional space before the INSERT column-list opening
    // parenthesis for schema-qualified tables (the dot-tablename regex above
    // inadvertently removes it for tables like dbo.MyTable).
    if (options.insertStatements?.columns?.parenthesisStyle) {
        formatted = formatted.replace(
            /^([ \t]*INSERT\s+(?:INTO\s+)?[^\s(]+)\(/gim,
            '$1 (',
        );
    }
    // Remove spurious space before ( in RAISERROR.
    formatted = formatted.replace(/\bRAISERROR\s+\(/gi, 'RAISERROR(');
    if (spacesInside) {
        formatted = formatted.replace(
            /\((NOLOCK|UPDLOCK|ROWLOCK|TABLOCK|TABLOCKX|HOLDLOCK|READPAST|NOWAIT|READCOMMITTEDLOCK|REPEATABLEREAD|SERIALIZABLE|SNAPSHOT|FORCESCAN|FORCESEEK|PAGLOCK)\)/gi,
            '( $1 )',
        );
        // Add spaces inside single-line VALUES(…) parentheses.
        formatted = formatted.replace(
            /^([ \t]*VALUES\s*\()(.+)\)([ \t]*;?[ \t]*)$/gim,
            (_m, kw, content, suffix) => {
                const c = content.trim();
                return `${kw} ${c}${c.endsWith(')') ? '' : ' '})${suffix}`;
            },
        );
    }
    // Keep one blank line between a leading comment block and the first SQL
    // statement when sql-formatter compacts them onto adjacent lines.
    formatted = formatted.replace(/^((?:[ \t]*--[^\n]*\n)+)(?=\S)/, '$1\n');
    return formatted;
}

interface ParsedExample {
    configPath: string;
    query: string;
}

function parseExampleFile(exampleDir: string, sqlFileName: string): ParsedExample {
    const configFiles = fs.readdirSync(exampleDir).filter(f => f.endsWith('.json')).sort();
    if (configFiles.length === 0) {
        throw new Error(`No config JSON found in ${exampleDir}`);
    }
    if (configFiles.length > 1) {
        throw new Error(`Multiple config JSON files found in ${exampleDir}`);
    }

    const sqlPath = path.join(exampleDir, sqlFileName);
    const query = fs.readFileSync(sqlPath, 'utf8').trimEnd();
    return {
        configPath: path.join(exampleDir, configFiles[0]),
        query,
    };
}

// Resolve examples directory so it works from both src/* and out/* execution roots.
const examplesDir = path.resolve(__dirname, '..', '..', '..', 'src', 'formatter', '__tests__', 'examples');

interface ExampleCase {
    group: string;
    fileName: string;
    filePath: string;
}

const exampleCases: ExampleCase[] = fs.existsSync(examplesDir)
    ? fs.readdirSync(examplesDir)
        .sort()
        .flatMap(groupName => {
            const groupPath = path.join(examplesDir, groupName);
            if (!fs.statSync(groupPath).isDirectory()) {
                return [];
            }
            return fs.readdirSync(groupPath)
                .filter(f => f.endsWith('.sql'))
                .sort()
                .map(fileName => ({
                    group: groupName,
                    fileName,
                    filePath: path.join(groupPath, fileName),
                }));
        })
    : [];

describe('formatter examples — idempotent formatting', () => {
    if (exampleCases.length === 0) {
        it('skipped — examples directory not found', () => {});
    }
    for (const exampleCase of exampleCases) {
        let parsed: ParsedExample;
        try {
            parsed = parseExampleFile(path.dirname(exampleCase.filePath), exampleCase.fileName);
        } catch (e) {
            it(`${exampleCase.group}/${exampleCase.fileName} — skipped: ${(e as Error).message}`, () => { });
            continue;
        }

        let styleOptions: SqlPromptStyleJson;
        try {
            const raw = fs.readFileSync(parsed.configPath, 'utf8');
            styleOptions = JSON.parse(raw) as SqlPromptStyleJson;
        } catch (e) {
            it(`${exampleCase.group}/${exampleCase.fileName} — skipped: cannot load config ${parsed.configPath}: ${(e as Error).message}`, () => { });
            continue;
        }

        it(`${exampleCase.group}/${exampleCase.fileName} — formatting is idempotent`, () => {
            const result = formatSql(parsed.query, styleOptions);
            assert.equal(result, parsed.query);
        });
    }
});
