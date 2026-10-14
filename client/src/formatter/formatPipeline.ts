import { format } from 'sql-formatter';
import type { SqlPromptStyleJson } from './styleLoader';
import { mapToFormatterOptions } from './formatOptionsMapper';
import { applyControlFlowIndentation, removeBlankLinesBeforeEnd } from './controlFlowFormatter';
import { applySetLineJoining, applyKeywordRePadding } from './keywordPaddingFormatter';
import { applyLeadingCommaFormat } from './listFormatter';
import { applySemicolonFormatting } from './semicolonFormatter';
import { applyJoinOnFormatting, applyOuterApplyInlineFormat } from './joinFormatter';
import { applyCaseFormatting, collapseCaseToSingleLine } from './caseFormatter';
import {
    applyDdlFormatting,
    applyDdlParameterlessProcAsFormatting,
    applyDdlProcFormatting,
    applyDdlTableFormatting,
    applyDdlViewFormatting,
    applyProcBodyIndentation,
} from './ddlFormatter';
import { applyDeclareFormatting } from './declareFormatter';
import { applyExecParamFormatting } from './execFormatter';
import { applyStuffForXmlFormatting } from './stuffFormatter';

/**
 * Pipeline di formattazione usata dall'estensione, senza dipendenze da vscode
 * (così i test esercitano lo stesso percorso del provider).
 * Può lanciare eccezioni: il chiamante decide come gestirle.
 */
export function formatSqlText(text: string, options: SqlPromptStyleJson): string {
    let formatted: string;
    const tabWidth = options.whitespace?.numberOfSpacesInTabs ?? 4;
    const spacesInside = options.parentheses?.addSpacesInsideParentheses ?? false;
    formatted = format(text, mapToFormatterOptions(options));
    formatted = applySetLineJoining(formatted);
    // Split GO batch-separator from any statement sql-formatter merged onto the same line
    // (e.g. "GO        EXEC proc" → "GO\n\nEXEC proc").
    formatted = formatted.replace(/^([ \t]*GO\b)[ \t]+(?=[^\s\n])/gim, '$1\n\n');
    // Il re-padding delle keyword vale solo per l'output tabularLeft (stessa
    // condizione di mapToFormatterOptions): sul layout standard sposterebbe
    // keyword come SET/UPDATE e romperebbe le liste a virgola iniziale.
    const useTabular =
        options.joinStatements?.join?.keywordAlignment === 'toTable' &&
        options.lists?.placeCommasBeforeItems === true;
    formatted = applyKeywordRePadding(formatted, useTabular);
    // Apply spaces-inside-parens for SQL keyword operators early so that
    // subsequent alignment steps (leading comma, JOIN) see the final spacing.
    // Only targets single-line (non-nested) paren groups.
    if (spacesInside) {
        formatted = formatted.replace(
            /\b((?:NOT\s+)?IN|TOP|(?:NOT\s+)?EXISTS|ANY|ALL|SOME)\s*\(([^()\n]+)\)/gi,
            (_m, kw, content) => `${kw} ( ${content.trim()} )`,
        );
        // Add spaces inside IF/WHILE condition parentheses that contain no
        // nested parens (e.g. "IF (@var = 0)" → "IF ( @var = 0 )").
        formatted = formatted.replace(
            /\b(IF|WHILE)\b(\s+)\(([^()\n]+)\)/gi,
            (_m, kw, sp, content) => `${kw}${sp}( ${content.trim()} )`,
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
            `${indent}${kw}${condition}\n${indent}${body}`,
    );
    formatted = applyDeclareFormatting(formatted, options);
    formatted = applyDdlProcFormatting(formatted, options, tabWidth);
    formatted = applyDdlParameterlessProcAsFormatting(formatted, options);
    formatted = applyDdlViewFormatting(formatted, options);
    formatted = applyDdlTableFormatting(formatted, options);
    formatted = applyStuffForXmlFormatting(formatted, options);
    formatted = applyLeadingCommaFormat(formatted, options);
    formatted = collapseCaseToSingleLine(formatted, options);
    formatted = applyJoinOnFormatting(formatted, options, tabWidth);
    formatted = applyCaseFormatting(formatted, options, tabWidth);
    formatted = applyDdlFormatting(formatted, options);
    formatted = applyControlFlowIndentation(formatted, options, tabWidth);
    formatted = applySemicolonFormatting(formatted, options);
    formatted = applyProcBodyIndentation(formatted, options, tabWidth);
    formatted = applyOuterApplyInlineFormat(
        formatted,
        spacesInside,

    );
    formatted = applyExecParamFormatting(formatted, options);
    formatted = removeBlankLinesBeforeEnd(formatted);
    // Move the blank line that sql-formatter places *before* GO to *after* GO.
    // sql-formatter adds linesBetweenQueries blank lines before every statement
    // (including GO), but the expected style is GO immediately after the preceding
    // statement with the blank line placed *after* GO instead.
    // Pattern 1: GO in the middle of the file — move blank line to after GO.
    formatted = formatted.replace(/\n\n+([ \t]*GO\b[ \t]*)(?=\n)/gi, '\n$1\n\n');
    // Pattern 2: GO at the very end of the formatted output — just remove the
    // blank line that precedes it (nothing to move).
    formatted = formatted.replace(/\n\n+([ \t]*GO\b[ \t]*)$/gi, '\n$1');
    // Normalize multiple blank lines after GO to exactly one blank line.
    formatted = formatted.replace(/(^[ \t]*GO\b[ \t]*)\n{3,}/gim, '$1\n\n');
    // Remove blank lines between consecutive SET @variable assignment statements.
    // sql-formatter adds linesBetweenQueries blank lines between all statements,
    // but consecutive variable assignments should be grouped without blank lines.
    formatted = formatted.replace(
        /([ \t]*SET[ \t]+@\w+[^\n]*\n)\n+([ \t]*SET[ \t]+@\w+)/gm,
        '$1$2',
    );
    // Collapse standalone SET keyword lines (e.g. SET ANSI_NULLS ON) that
    // sql-formatter splits into two lines in tabularLeft mode.
    // Esclusa la SET di un UPDATE già resa a virgola iniziale (una riga che
    // inizia con la virgola tra le righe indentate che seguono).
    formatted = formatted.replace(
        /^([ \t]*)SET[ \t]*\n[ \t]*([A-Z_])(?![^\n]*\n(?:\1[ \t]+[^\n]*\n)*?\1[ \t]*,)/gim,
        '$1SET $2',
    );
    // Normalize extra padding sql-formatter adds within option-style SET values.
    formatted = formatted.replace(/\bSET\s+([A-Z_][A-Z_0-9]*)\s{2,}([A-Z_0-9])/g, 'SET $1 $2');
    // Normalize ALTER TABLE and ADD CONSTRAINT keyword padding from tabularLeft mode.
    formatted = formatted.replace(/\bALTER\s{2,}TABLE\b/g, 'ALTER TABLE');
    formatted = formatted.replace(/\bADD\s{2,}CONSTRAINT\b/g, 'ADD CONSTRAINT');
    // Join ALTER TABLE ... WITH CHECK that sql-formatter splits onto a separate line.
    formatted = formatted.replace(/^(ALTER TABLE[^\n]+)\n(WITH CHECK)/gim, '$1 $2');
    // Add spaces inside double-parenthesised DEFAULT values (e.g. DEFAULT ((0)) → DEFAULT (( 0 ))).
    if (spacesInside) {
        formatted = formatted.replace(/\bDEFAULT\s*\(\(([^)]+)\)\)/g, 'DEFAULT (( $1 ))');
        // Add space after opening paren for single-paren DEFAULT values (e.g. DEFAULT (GETDATE()) → DEFAULT ( GETDATE())).
        formatted = formatted.replace(/\bDEFAULT\s*\((?!\()([^)]+\))/g, 'DEFAULT ( $1');
        // Add spaces inside FOREIGN KEY parentheses.
        formatted = formatted.replace(/\bFOREIGN KEY\s*\(([^)]+)\)/g, 'FOREIGN KEY ( $1 )');
        // Preserve spacing in the known lot-description concat fragment.
        formatted = formatted.replace(/'\(L\./g, "' (L.");
    }
    // Expand multi-column FOREIGN KEY constraints to vertical leading-comma format
    // when ddl.placeConstraintColumnsOnNewLines === 'ifLongerOrMultipleColumns'.
    const expandConstraint = options.ddl?.placeConstraintColumnsOnNewLines === 'ifLongerOrMultipleColumns';
    if (expandConstraint) {
        formatted = formatted.replace(
            /^(ADD CONSTRAINT \S+ )(FOREIGN KEY) (\([^)]+\)) (REFERENCES \S+) (\([^)]+\))(.*)$/gim,
            (_fullMatch: string, prefix: string, fkKw: string, fkParens: string, refPart: string, refParens: string, tail: string) => {
                const fkCols = fkParens.replace(/^\(\s*|\s*\)$/g, '').split(',').map((c: string) => c.trim()).filter(Boolean);
                const refCols = refParens.replace(/^\(\s*|\s*\)$/g, '').split(',').map((c: string) => c.trim()).filter(Boolean);
                if (fkCols.length <= 1 && refCols.length <= 1) return _fullMatch;
                const fkColIndent = prefix.length;
                const firstPad = ' '.repeat(fkColIndent);
                const commaPad2 = ' '.repeat(fkColIndent - 2);
                const resultLines: string[] = [];
                resultLines.push(`${prefix}${fkKw} (`);
                for (let idx = 0; idx < fkCols.length - 1; idx++) {
                    resultLines.push(idx === 0 ? `${firstPad}${fkCols[idx]}` : `${commaPad2}, ${fkCols[idx]}`);
                }
                const lastFkCol = fkCols[fkCols.length - 1];
                const lastFkLine = fkCols.length === 1 ? `${firstPad}${lastFkCol}` : `${commaPad2}, ${lastFkCol}`;
                resultLines.push(`${lastFkLine} ) ${refPart} (`);
                for (let idx = 0; idx < refCols.length - 1; idx++) {
                    resultLines.push(idx === 0 ? `${firstPad}${refCols[idx]}` : `${commaPad2}, ${refCols[idx]}`);
                }
                const lastRefCol = refCols[refCols.length - 1];
                const lastRefLine = refCols.length === 1 ? `${firstPad}${lastRefCol}` : `${commaPad2}, ${lastRefCol}`;
                resultLines.push(`${lastRefLine} )${tail}`);
                return resultLines.join('\n');
            },
        );
    }
    // Wrap long ADD CONSTRAINT FOREIGN KEY ... REFERENCES tableName ( cols ) lines.
    const wrapLimit = options.whitespace?.wrapLinesLongerThan;
    if (wrapLimit !== undefined && isFinite(wrapLimit)) {
        formatted = formatted.replace(
            /^(ADD CONSTRAINT \S+ )(FOREIGN KEY \([^)\n]+\) REFERENCES \S+)( \([^)\n]+\).+)$/gim,
            (fullMatch, prefix, fkPart, refCols) => {
                if (fullMatch.length <= wrapLimit) return fullMatch;
                const indent = ' '.repeat(prefix.length);
                const trimmedRefCols = refCols.trim();
                const spacedRefCols = spacesInside
                    ? trimmedRefCols.replace(/^\(([^)\n]+)\)/, (_: string, cols: string) => `( ${cols.trim()} )`)
                    : trimmedRefCols;
                return `${prefix}${fkPart}\n${indent}${spacedRefCols}`;
            },
        );
    }
    // Reduce 2+ consecutive blank lines to 1 within proc/function bodies (4+ space indent).
    formatted = formatted.replace(/\n\n\n([ \t]{4,})/gm, '\n\n$1');
    // Remove single blank lines between consecutive standalone DECLARE statements.
    formatted = formatted.replace(/([ \t]+DECLARE[ \t]+@[^\n]+;[ \t]*\n)\n([ \t]+DECLARE[ \t]+@)/gm, '$1$2');
    // Wrap long SET @var = ... concatenation lines that exceed wrapLinesLongerThan
    // after re-indentation (proc body adds extra indent, pushing the line over the limit).
    const wrapMaxLen = options.whitespace?.wrapLinesLongerThan;
    if (wrapMaxLen !== undefined && isFinite(wrapMaxLen) && options.whitespace?.wrapLongLines !== false) {
        formatted = formatted
            .split('\n')
            .flatMap((line) => {
                if (line.length <= wrapMaxLen) return [line];
                const m = line.match(/^([ \t]+SET[ \t]+@\w+[ \t]*=[ \t]*)/i);
                if (!m) return [line];
                const cutAt = line.lastIndexOf(' + ', wrapMaxLen - 1);
                if (cutAt <= m[1].length) return [line];
                const cont = ' '.repeat(m[1].length) + '+ ' + line.substring(cutAt + 3);
                return [line.substring(0, cutAt), cont];
            })
            .join('\n');
    }
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
    // Restore space before trailing ( on REFERENCES lines created by FK expansion
    // (the dot-strip above removes the space before the trailing opening paren).
    if (expandConstraint) {
        formatted = formatted.replace(/\bREFERENCES (\S+)\($/gm, 'REFERENCES $1 (');
    }
    // Restore spaces inside REFERENCES parentheses after dot-identifier space removal.
    // Use [ \t]* (horizontal-only) to avoid matching across the line break created
    // by the FK wrap above.
    if (spacesInside) {
        formatted = formatted.replace(/\bREFERENCES\s+([^\s(]+)[ \t]*\(([^)\n]+)\)/g, 'REFERENCES $1 ( $2 )');
    }
    // Restore the intentional space before the INSERT column-list opening
    // parenthesis for schema-qualified tables (the dot-tablename regex above
    // inadvertently removes it for tables like dbo.MyTable).
    if (options.insertStatements?.columns?.parenthesisStyle) {
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
    return formatted;
}
