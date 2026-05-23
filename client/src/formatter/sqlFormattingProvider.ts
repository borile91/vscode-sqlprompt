import {
    CancellationToken,
    DocumentFormattingEditProvider,
    FormattingOptions,
    Range,
    TextDocument,
    TextEdit,
    window,
} from 'vscode';
import { format } from 'sql-formatter';
import type { LoadedStyle } from './styleLoader';
import { mapToFormatterOptions } from './formatOptionsMapper';
import { applyControlFlowIndentation, removeBlankLinesBeforeEnd } from './controlFlowFormatter';
import { applySetLineJoining, applyKeywordRePadding } from './keywordPaddingFormatter';
import { applyLeadingCommaFormat } from './listFormatter';
import { applySemicolonFormatting } from './semicolonFormatter';
import { applyJoinOnFormatting } from './joinFormatter';
import { applyCaseFormatting, collapseCaseToSingleLine } from './caseFormatter';
import {
    applyDdlFormatting,
    applyDdlParameterlessProcAsFormatting,
    applyDdlProcFormatting,
    applyDdlViewFormatting,
    applyProcBodyIndentation,
} from './ddlFormatter';
import { applyDeclareFormatting } from './declareFormatter';
import { applyExecParamFormatting } from './execFormatter';

export class SqlFormattingProvider implements DocumentFormattingEditProvider {
    constructor(private readonly getStyle: () => LoadedStyle | undefined) {}

    provideDocumentFormattingEdits(
        document: TextDocument,
        _options: FormattingOptions,
        _token: CancellationToken,
    ): TextEdit[] {
        const style = this.getStyle();
        if (!style) {
            window.showInformationMessage(
                'SQL Prompt: no formatting style active. Run "SQL Prompt: Select Formatting Style" to choose one.',
            );
            return [];
        }

        const text = document.getText();
        let formatted: string;
        try {
            const tabWidth = style.options.whitespace?.numberOfSpacesInTabs ?? 4;
            const spacesInside = style.options?.parentheses?.addSpacesInsideParentheses ?? false;
            formatted = format(text, mapToFormatterOptions(style.options));
            formatted = applySetLineJoining(formatted);
            formatted = applyKeywordRePadding(formatted);
            // Apply spaces-inside-parens for SQL keyword operators early so that
            // subsequent alignment steps (leading comma, JOIN) see the final spacing.
            // Only targets single-line (non-nested) paren groups.
            if (spacesInside) {
                formatted = formatted.replace(
                    /\b((?:NOT\s+)?IN|TOP|(?:NOT\s+)?EXISTS|ANY|ALL|SOME)\s*\(([^()\n]+)\)/gi,
                    (_m, kw, content) => `${kw} ( ${content.trim()} )`,
                );
            }
            // Expand collapsed single-line IF/WHILE statements back to two lines.
            // sql-formatter's collapseStatementsShorterThan may join the condition and
            // body onto a single line (e.g. "IF (cond) body;"), but the expected style
            // always places the body on its own indented line.
            // This must run BEFORE applyControlFlowIndentation so the IF is processed
            // correctly as a single-body statement.
            formatted = formatted.replace(
                /^([ \t]*)(IF|WHILE)\b(.*?)[ \t]+((?:COMMIT|ROLLBACK|RETURN|BREAK|CONTINUE|RAISERROR|EXEC|INSERT|UPDATE|DELETE|SELECT|SET\s+@)[^;\n]*;)$/gim,
                (_, indent, kw, condition, body) =>
                    `${indent}${kw}${condition}\n${indent}    ${body}`,
            );
            formatted = applyDeclareFormatting(formatted, style.options);
            formatted = applyDdlProcFormatting(formatted, style.options, tabWidth);
            formatted = applyDdlParameterlessProcAsFormatting(formatted, style.options);
            formatted = applyDdlViewFormatting(formatted, style.options);
            formatted = collapseCaseToSingleLine(formatted, style.options);
            formatted = applyLeadingCommaFormat(formatted, style.options);
            formatted = applyJoinOnFormatting(formatted, style.options, tabWidth);
            formatted = applyCaseFormatting(formatted, style.options, tabWidth);
            formatted = applyDdlFormatting(formatted, style.options);
            formatted = applyControlFlowIndentation(formatted, style.options, tabWidth);
            formatted = applySemicolonFormatting(formatted, style.options);
            formatted = applyProcBodyIndentation(formatted, style.options, tabWidth);
            formatted = applyExecParamFormatting(formatted, style.options);
            formatted = removeBlankLinesBeforeEnd(formatted);
            // Remove blank line between a SQL statement and its trailing GO batch separator.
            // sql-formatter adds linesBetweenQueries blank lines before every statement
            // (including GO), but the expected style is GO immediately after the preceding
            // statement with the blank line placed *after* GO instead.
            formatted = formatted.replace(/\n\n([ \t]*GO\b)/gi, '\n$1');
            // Remove blank lines between consecutive SET @variable assignment statements.
            // sql-formatter adds linesBetweenQueries blank lines between all statements,
            // but consecutive variable assignments should be grouped without blank lines.
            formatted = formatted.replace(
                /([ \t]*SET[ \t]+@\w+[^\n]*\n)\n+([ \t]*SET[ \t]+@\w+)/gm,
                '$1$2',
            );
            // Collapse short EXISTS / NOT EXISTS subqueries from multi-line form into
            // a 2-line format:
            //   IF ... NOT EXISTS (       →   IF ... NOT EXISTS ( SELECT ...
            //       SELECT ...                  <aligned>FROM ... )
            //       FROM ...
            //   )
            // Also handles AND NOT EXISTS / OR NOT EXISTS in WHERE clauses.
            // Handles SELECT + one or more FROM/WHERE/GROUP BY/HAVING/ORDER BY clauses.
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
            // Only match horizontal whitespace (not newlines) so that a procedure
            // parameter list  `proc_name\n    (`  is not collapsed to `proc_name(`.
            formatted = formatted.replace(/(\.\w+)[ \t]+\(/g, '$1(');
            // Restore the intentional space before the INSERT column-list opening
            // parenthesis for schema-qualified tables (the dot-tablename regex above
            // inadvertently removes it for tables like dbo.MyTable).
            if (style.options.insertStatements?.columns?.parenthesisStyle) {
                formatted = formatted.replace(
                    /^([ \t]*INSERT\s+(?:INTO\s+)?[^\s(]+)\(/gim,
                    '$1 (',
                );
            }
            // Remove spurious space before ( in known T-SQL built-in statements
            // (sql-formatter may emit a space after statement names like RAISERROR).
            formatted = formatted.replace(/\bRAISERROR\s+\(/gi, 'RAISERROR(');
            // Add spaces inside table-hint parentheses when addSpacesInsideParentheses is set
            if (spacesInside) {
                formatted = formatted.replace(
                    /\((NOLOCK|UPDLOCK|ROWLOCK|TABLOCK|TABLOCKX|HOLDLOCK|READPAST|NOWAIT|READCOMMITTEDLOCK|REPEATABLEREAD|SERIALIZABLE|SNAPSHOT|FORCESCAN|FORCESEEK|PAGLOCK)\)/gi,
                    '( $1 )',
                );
                // Add spaces inside single-line VALUES(…) parentheses.
                // Uses greedy match to find the last ) before optional ; on the line,
                // then adds a space before ) unless the content already ends with )
                // (e.g. GETDATE()) to avoid producing the ugly double-paren sequence ) ).
                formatted = formatted.replace(
                    /^([ \t]*VALUES\s*\()(.+)\)([ \t]*;?[ \t]*)$/gim,
                    (_m, kw, content, suffix) => {
                        const c = content.trim();
                        return `${kw} ${c}${c.endsWith(')') ? '' : ' '})${suffix}`;
                    },
                );
            }
            // Keep one empty line between a leading comment block and the first
            // SQL statement when sql-formatter compacts them together.
            formatted = formatted.replace(/^((?:[ \t]*--[^\n]*\n)+)(?=\S)/, '$1\n');
        } catch {
            return [];
        }

        const fullRange = new Range(
            document.lineAt(0).range.start,
            document.lineAt(document.lineCount - 1).range.end,
        );
        return [TextEdit.replace(fullRange, formatted)];
    }
}
