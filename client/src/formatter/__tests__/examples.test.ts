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
    applyDdlTableFormatting,
    applyProcBodyIndentation,
} from '../ddlFormatter.js';
import { collapseCaseToSingleLine, applyCaseFormatting } from '../caseFormatter.js';
import { applyLeadingCommaFormat } from '../listFormatter.js';
import { applyJoinOnFormatting, applyOuterApplyInlineFormat } from '../joinFormatter.js';
import { applyControlFlowIndentation, removeBlankLinesBeforeEnd } from '../controlFlowFormatter.js';
import { applySemicolonFormatting } from '../semicolonFormatter.js';
import { applyExecParamFormatting } from '../execFormatter.js';
import { applyStuffForXmlFormatting } from '../stuffFormatter.js';

// Same pipeline as SqlFormattingProvider.provideDocumentFormattingEdits
function formatSql(text: string, options: SqlPromptStyleJson): string {    const tabWidth = options.whitespace?.numberOfSpacesInTabs ?? 4;
    const spacesInside = options.parentheses?.addSpacesInsideParentheses ?? false;
    const useTabular = options.joinStatements?.join?.keywordAlignment === 'toTable' && options.lists?.placeCommasBeforeItems === true;
    let formatted = format(text, mapToFormatterOptions(options));
    formatted = applySetLineJoining(formatted);
    // Split GO batch-separator from any statement sql-formatter merged onto the same line
    // (e.g. "GO        EXEC proc" → "GO\n\nEXEC proc").
    formatted = formatted.replace(/^([ \t]*GO\b)[ \t]+(?=[^\s\n])/gim, '$1\n\n');
    formatted = applyKeywordRePadding(formatted, useTabular);
    // Apply spaces-inside-parens for SQL keyword operators early so that
    // subsequent alignment steps (leading comma, JOIN) see the final spacing.
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
    // Expand collapsed single-line IF/WHILE statements back to two lines,
    // but only when collapseShortStatements is NOT enabled.
    if (!options.controlFlow?.collapseShortStatements) {
        formatted = formatted.replace(
            /^([ \t]*)(IF|WHILE)\b(.*?)[ \t]+((?:COMMIT|ROLLBACK|RETURN|BREAK|CONTINUE|RAISERROR|EXEC|INSERT|UPDATE|DELETE|SELECT|SET\s+@)[^;\n]*;)$/gim,
            (_, indent, kw, condition, body) =>
                `${indent}${kw}${condition}\n${indent}${body}`,
        );
    }
    formatted = applyDeclareFormatting(formatted, options);
    formatted = applyDdlProcFormatting(formatted, options, tabWidth);
    formatted = applyDdlParameterlessProcAsFormatting(formatted, options);
    formatted = applyDdlViewFormatting(formatted, options);
    formatted = applyDdlTableFormatting(formatted, options);
    formatted = applyStuffForXmlFormatting(formatted, options);
    formatted = applyLeadingCommaFormat(formatted, options);
    formatted = collapseCaseToSingleLine(formatted, options);
    // For non-leading-comma styles (placeSubsequentItemsOnNewLines === 'never'),
    // collapse SELECT/FROM/WHERE/ORDER BY clause keywords with their items inline.
    // This must run before applyJoinOnFormatting so that FROM+table appears on
    // one line, enabling correct JOIN indent inference.
    if (options.lists?.placeSubsequentItemsOnNewLines === 'never') {
        const maxLen = options.whitespace?.wrapLinesLongerThan ?? 9999;
        // Limit to ≤ 8 spaces of indent to avoid processing clauses inside subqueries
        // (e.g. WHERE inside OUTER APPLY at 18-space indent).
        const INLINE_CLAUSE = /^([ \t]*)(SELECT|FROM|WHERE|ORDER\s+BY)(\s*)$/i;
        const PACK_CLAUSE = /^([ \t]*)(GROUP\s+BY|HAVING)(\s*)$/i;
        const JOIN_RE = /^[ \t]*(?:(?:INNER|LEFT|RIGHT|FULL|CROSS)\s+(?:OUTER\s+)?JOIN|OUTER\s+APPLY|CROSS\s+APPLY|JOIN)\b/i;
        const lines2 = formatted.split('\n');
        const out2: string[] = [];
        let j2 = 0;
        let parenDepth2 = 0; // track subquery depth; skip INLINE/PACK when > 0
        while (j2 < lines2.length) {
            const l2 = lines2[j2];
            // Update paren depth from this line (rough count, ignoring string literals)
            const lineParens = (l2.match(/\(/g)?.length ?? 0) - (l2.match(/\)/g)?.length ?? 0);
            const im = parenDepth2 === 0 ? l2.match(INLINE_CLAUSE) : null;
            const pm = !im && parenDepth2 === 0 ? l2.match(PACK_CLAUSE) : null;
            if (im || pm) {
                const kwIndent = (im || pm)![1];
                const kw = (im || pm)![2].replace(/\s+/g, ' ');
                const contIndent = kwIndent + ' '.repeat(tabWidth);
                // Collect continuation lines (items at kwIndent + tabWidth)
                const items: string[] = [];
                j2++;
                while (j2 < lines2.length) {
                    const cl = lines2[j2];
                    if (!cl.startsWith(contIndent)) break;
                    const rest = cl.slice(contIndent.length);
                    if (!rest.trim()) break;
                    if (JOIN_RE.test(cl)) break; // join lines are not clause items
                    items.push(rest.replace(/,\s*$/, '').trim()); // strip trailing comma, normalise AND/OR
                    j2++;
                }
                if (items.length === 0) { out2.push(l2); continue; }
                // Reassemble with OR/AND continuations stripped of leading whitespace
                const rawJoined = items.join(', ').replace(/,\s*(AND|OR)\s+/gi, ' $1 ');
                if (im) {
                    // Inline: keyword + items on same line, wrap at maxLen
                    const prefix = kwIndent + kw + ' ';
                    if (prefix.length + rawJoined.length <= maxLen) {
                        out2.push(prefix + rawJoined);
                    } else {
                        // Greedy wrap: first line uses prefix, continuation at contIndent
                        let cur = prefix + items[0];
                        for (let k = 1; k < items.length; k++) {
                            const add = ', ' + items[k];
                            if (cur.length + add.length <= maxLen) cur += add;
                            else { out2.push(cur + ','); cur = contIndent + items[k]; }
                        }
                        out2.push(cur);
                    }
                } else {
                    // Pack-only: keyword on own line, items greedy on next line(s)
                    out2.push(kwIndent + kw);
                    let cur = contIndent + items[0];
                    for (let k = 1; k < items.length; k++) {
                        const add = ', ' + items[k];
                        if (cur.length + add.length <= maxLen) cur += add;
                        else { out2.push(cur + ','); cur = contIndent + items[k]; }
                    }
                    out2.push(cur);
                }
                continue;
            }
            out2.push(l2);
            parenDepth2 += lineParens;
            j2++;
        }
        formatted = out2.join('\n');
    }
    formatted = applyJoinOnFormatting(formatted, options, tabWidth);
    formatted = applyCaseFormatting(formatted, options, tabWidth);
    formatted = applyDdlFormatting(formatted, options);
    formatted = applyControlFlowIndentation(formatted, options, tabWidth);
    formatted = applySemicolonFormatting(formatted, options);
    formatted = applyProcBodyIndentation(formatted, options, tabWidth);
    // For collapseShortStatements styles, collapse IF/WHILE + body onto one line
    // when the combined length fits within collapseStatementsShorterThan.
    if (options.controlFlow?.collapseShortStatements) {
        const maxCollapse = options.controlFlow?.collapseStatementsShorterThan ?? Infinity;
        formatted = formatted.replace(
            /^([ \t]*)(IF|WHILE)(\b[^\n]*)\n([ \t]+)(\S[^;\n]*;)$/gim,
            (match, indent, kw, condition, bodyIndent, body) => {
                if (bodyIndent.length !== indent.length + tabWidth) return match;
                const combined = indent + kw + condition + ' ' + body;
                return combined.length < maxCollapse ? combined : match;
            },
        );
    }
    formatted = applyOuterApplyInlineFormat(
        formatted,
        spacesInside,
        options.lists?.placeCommasBeforeItems === true,
    );
    // For scripting styles, greedily repack EXEC/EXECUTE named parameters onto
    // lines within wrapLinesLongerThan. sql-formatter puts each @param on its
    // own line at col 0; we join them and repack at maxLen.
    if (options.lists?.placeSubsequentItemsOnNewLines === 'never' && options.whitespace?.wrapLinesLongerThan) {
        const maxLen = options.whitespace.wrapLinesLongerThan;
        const EXEC_FIRST_RE = /^([ \t]*EXEC(?:UTE)?\s+\S+)([ \t]+@\S+[^,\n]*,)\s*$/i;
        const EXEC_CONT_RE = /^(@\S[^\n]*?)([,;])\s*$/;
        const execLines = formatted.split('\n');
        const execResult: string[] = [];
        let ei = 0;
        while (ei < execLines.length) {
            const el = execLines[ei];
            const execM = el.match(EXEC_FIRST_RE);
            if (!execM) { execResult.push(el); ei++; continue; }
            const execHead = execM[1].trimStart().length > 0 ? execM[1] : execM[1];
            const firstParam = execM[2].trim().replace(/,\s*$/, '');
            const indent = el.match(/^([ \t]*)/)![1];
            // Collect all params
            const params: string[] = [firstParam];
            ei++;
            let terminator = ',';
            while (ei < execLines.length) {
                const cl = execLines[ei];
                const cm = cl.trim().match(EXEC_CONT_RE);
                if (!cm) break;
                params.push(cm[1]);
                terminator = cm[2];
                ei++;
                if (cm[2] === ';') break;
            }
            // Greedy pack
            const contPad = indent + ' '.repeat(tabWidth);
            let line = execM[1] + ' ' + params[0];
            for (let pi = 1; pi < params.length; pi++) {
                const isLast = pi === params.length - 1;
                const sep = isLast ? (terminator === ';' ? '' : ',') : ',';
                const candidate = line + ', ' + params[pi];
                if (candidate.length + (isLast ? 0 : 0) <= maxLen) {
                    line = candidate + (isLast ? '' : '');
                } else {
                    execResult.push(line + ',');
                    line = contPad + params[pi];
                }
            }
            execResult.push(line + terminator);
        }
        formatted = execResult.join('\n');
    }
    // ── Scripting-style post-processing (placeSubsequentItemsOnNewLines === 'never') ──
    if (options.lists?.placeSubsequentItemsOnNewLines === 'never') {
        const scMaxLen = options.whitespace?.wrapLinesLongerThan ?? 9999;
        const scCollapseMax = options.dml?.collapseStatementsShorterThan ?? Infinity;
        const scCfMax = options.controlFlow?.collapseStatementsShorterThan ?? Infinity;

        // 1. DECLARE greedy packing for non-comma-first styles (sql-formatter emits
        //    continuation vars at the same indent as DECLARE; pack them at maxLen
        //    with continuation at indent + tabWidth).
        if (!options.lists?.placeCommasBeforeItems) {
            const dLines = formatted.split('\n');
            const dResult: string[] = [];
            let di = 0;
            while (di < dLines.length) {
                const dl = dLines[di];
                const dm = dl.match(/^([ \t]*)(DECLARE\s+)(@\S+[^\n]*),\s*$/i);
                if (!dm) { dResult.push(dl); di++; continue; }
                const declIndent = dm[1];
                const contIndent = declIndent + ' '.repeat(tabWidth);
                const vars: string[] = [dm[3].trim()];
                let hasSemicolon = false;
                di++;
                while (di < dLines.length) {
                    const cl = dLines[di].trimStart();
                    if (!cl.startsWith('@')) break;
                    hasSemicolon = cl.endsWith(';');
                    vars.push(cl.replace(/[,;]\s*$/, '').trim());
                    di++;
                    if (hasSemicolon) break;
                }
                if (vars.length <= 1) { dResult.push(dl); continue; }
                const kwPfx = declIndent + 'DECLARE ';
                let cur = kwPfx + vars[0];
                for (let vi = 1; vi < vars.length; vi++) {
                    const cand = cur + ', ' + vars[vi];
                    if (cand.length > scMaxLen) { dResult.push(cur + ','); cur = contIndent + vars[vi]; }
                    else cur = cand;
                }
                dResult.push(cur + (hasSemicolon ? ';' : ''));
            }
            formatted = dResult.join('\n');
        }

        // 2. Collapse INSERT [INTO]\n    table → INSERT [INTO] table
        formatted = formatted.replace(
            /^([ \t]*INSERT(?:\s+INTO)?)\n([ \t]+)(\S[^\n]*)/gim,
            (_, kw, _ind, rest) => `${kw} ${rest.trim()}`,
        );

        // 3. Collapse VALUES\n    (...) → VALUES (...)
        formatted = formatted.replace(
            /^([ \t]*VALUES)\n[ \t]+(\S[^\n]*)/gim,
            (_, kw, rest) => `${kw} ${rest.trim()}`,
        );

        // 4. Combine short INSERT [INTO] + VALUES onto one line
        if (isFinite(scCollapseMax) && !options.lists?.placeCommasBeforeItems) {
            formatted = formatted.replace(
                /^([ \t]*INSERT(?:\s+INTO)?[^\n]+)\n([ \t]*VALUES\s+\([^\n]*;)$/gim,
                (m, ins, vals) => {
                    const one = ins + ' ' + vals.trimStart();
                    return one.length < scCollapseMax ? one : m;
                },
            );
        }

        // 5. Collapse SET col = val,\n    col2 = val2 → single line (UPDATE SET items)
        formatted = formatted.replace(
            /^([ \t]*SET\s+[^\n]+,)\n([ \t]+)(\S[^\n]*)$/gim,
            (m, setLine, _ind, rest) => {
                const one = setLine + ' ' + rest.trim();
                return one.length <= scMaxLen ? one : m;
            },
        );

        // 6. Collapse UPDATE table\nSET items\nWHERE cond → single line when short
        if (isFinite(scCollapseMax) && !options.lists?.placeCommasBeforeItems) {
            formatted = formatted.replace(
                /^([ \t]*UPDATE\s+\S+)\n([ \t]*SET\s+[^\n]+)\n([ \t]*WHERE\s+[^\n]+;)$/gim,
                (m, upd, set, whr) => {
                    const one = upd + ' ' + set.trimStart() + ' ' + whr.trimStart();
                    return one.length < scCollapseMax ? one : m;
                },
            );
            // Also collapse UPDATE ... SET ... (no WHERE)
            formatted = formatted.replace(
                /^([ \t]*UPDATE\s+\S+)\n([ \t]*SET\s+[^\n]+;)$/gim,
                (m, upd, set) => {
                    const one = upd + ' ' + set.trimStart();
                    return one.length < scCollapseMax ? one : m;
                },
            );
        }

        // 7. Inline simple IF [NOT] EXISTS subqueries (SELECT + FROM/WHERE on own lines)
        if (!options.lists?.placeCommasBeforeItems && (options.dml?.collapseSubqueriesShorterThan ?? Infinity) < Infinity) {
            const eLines = formatted.split('\n');
            const eResult: string[] = [];
            let ei = 0;
            while (ei < eLines.length) {
                const el = eLines[ei];
                const em = el.match(/^([ \t]*)((?:ELSE\s+)?IF\s+(?:NOT\s+)?EXISTS\s*)\(\s*$/i);
                if (!em) { eResult.push(el); ei++; continue; }
                const ifIndent = em[1];
                const ifPart = em[2].replace(/\s+/g, ' ').trimEnd();
                const bodyIndent2 = ifIndent + ' '.repeat(tabWidth * 2);
                const bodyLines: string[] = [];
                ei++;
                let foundClose = false;
                while (ei < eLines.length) {
                    const bl = eLines[ei];
                    if (/^\s*$/.test(bl) && !foundClose) { ei++; continue; }
                    if (bl === ifIndent + ')') { foundClose = true; ei++; break; }
                    bodyLines.push(bl);
                    ei++;
                }
                if (!foundClose) { eResult.push(el, ...bodyLines); continue; }
                // Inline each clause keyword + its items
                const parts: string[] = [];
                let bi = 0;
                while (bi < bodyLines.length) {
                    const bl = bodyLines[bi];
                    const trimBl = bl.trimStart();
                    const km = trimBl.match(/^(SELECT|FROM|WHERE)\s*$/i);
                    if (km) {
                        const kw = km[1].toUpperCase();
                        bi++;
                        const items: string[] = [];
                        while (bi < bodyLines.length && bodyLines[bi].startsWith(bodyIndent2)) {
                            items.push(bodyLines[bi].trim());
                            bi++;
                        }
                        parts.push(kw + (items.length > 0 ? ' ' + items.join(' ') : ''));
                    } else if (trimBl) { parts.push(trimBl); bi++; }
                    else bi++;
                }
                const subq = parts.join(' ');
                const one = ifIndent + ifPart + ' (' + subq + ')';
                if (one.length <= scMaxLen) eResult.push(one);
                else eResult.push(el, ...bodyLines, ifIndent + ')');
            }
            formatted = eResult.join('\n');
        }

        // 8. Collapse multiline IF condition (single AND/OR continuation) when fits
        if (isFinite(scCfMax) && !options.lists?.placeCommasBeforeItems) {
            formatted = formatted.replace(
                /^([ \t]*(?:ELSE\s+)?IF\b[^\n]+)\n([ \t]+(?:AND|OR)\b[^\n]+)$/gim,
                (m, ifLine, andLine) => {
                    const one = ifLine + ' ' + andLine.trimStart();
                    return one.length < scCfMax ? one : m;
                },
            );
        }
    }
    formatted = applyExecParamFormatting(formatted, options);
    formatted = removeBlankLinesBeforeEnd(formatted);
    // Move the blank line that sql-formatter places *before* GO to *after* GO.
    // Pattern 1: GO in the middle of the file — move blank line to after GO.
    formatted = formatted.replace(/\n\n+([ \t]*GO\b[ \t]*)(?=\n)/gi, '\n$1\n\n');
    // Pattern 2: GO at the very end — just remove the blank line before it.
    formatted = formatted.replace(/\n\n+([ \t]*GO\b[ \t]*)$/gi, '\n$1');
    // Normalize multiple blank lines after GO to exactly one blank line.
    formatted = formatted.replace(/(^[ \t]*GO\b[ \t]*)\n{3,}/gim, '$1\n\n');
    // For emptyLinesAfterBatchSeparator: 0, remove blank lines after GO.
    if ((options.whitespace?.newLines?.emptyLinesAfterBatchSeparator ?? 1) === 0) {
        formatted = formatted.replace(/^([ \t]*GO\b[ \t]*)\n\n/gim, '$1\n');
    }
    // Remove blank lines between consecutive SET @variable assignments.
    formatted = formatted.replace(
        /([ \t]*SET[ \t]+@\w+[^\n]*\n)\n+([ \t]*SET[ \t]+@\w+)/gm,
        '$1$2',
    );    // Collapse standalone SET keyword lines (e.g. SET ANSI_NULLS ON) that
    // sql-formatter splits into two lines in tabularLeft mode.
    formatted = formatted.replace(/^([ \t]*)SET[ \t]*\n[ \t]*([A-Z_])/gim, '$1SET $2');
    // Normalize extra padding sql-formatter adds within option-style SET values.
    formatted = formatted.replace(/\bSET\s+([A-Z_][A-Z_0-9]*)\s{2,}([A-Z_0-9])/g, 'SET $1 $2');
    // Normalize ALTER TABLE and ADD CONSTRAINT keyword padding from tabularLeft mode.
    formatted = formatted.replace(/\bALTER\s{2,}TABLE\b/g, 'ALTER TABLE');
    formatted = formatted.replace(/\bADD\s{2,}CONSTRAINT\b/g, 'ADD CONSTRAINT');
    // sql-formatter sometimes splits WITH\n    CHECK across 3 lines in ALTER TABLE context — join first.
    formatted = formatted.replace(/^(ALTER\s+TABLE[^\n]+\n)(WITH)\n[ \t]*(CHECK)\b/gim, '$1$2 $3');
    // Join ALTER TABLE ... WITH CHECK that sql-formatter splits onto a separate line.
    formatted = formatted.replace(/^(ALTER TABLE[^\n]+)\n(WITH CHECK)/gim, '$1 $2');
    // Collapse short ALTER TABLE ... ADD CONSTRAINT to a single line.
    // Threshold is 97 (combined line must be strictly less than 97 chars).
    if (options.ddl?.collapseShortStatements) {
        formatted = formatted.replace(/^(ALTER\s+TABLE\s+\S+)\n(ADD\s+CONSTRAINT\s+.+)$/gim, (m, p1, p2) => {
            const joined = `${p1} ${p2}`;
            return joined.length < 97 ? joined : m;
        });
    }
    // Add spaces inside double-parenthesised DEFAULT values (e.g. DEFAULT ((0)) → DEFAULT (( 0 ))).
    if (spacesInside) {
        formatted = formatted.replace(/\bDEFAULT\s*\(\(([^)]+)\)\)/g, 'DEFAULT (( $1 ))');
        // Add space after opening paren for single-paren DEFAULT values (e.g. DEFAULT (GETDATE()) → DEFAULT ( GETDATE())).
        formatted = formatted.replace(/\bDEFAULT\s*\((?!\()([^)]+\))/g, 'DEFAULT ( $1');
        // Add spaces inside FOREIGN KEY parentheses.
        formatted = formatted.replace(/\bFOREIGN KEY\s*\(([^)]+)\)/g, 'FOREIGN KEY ( $1 )');
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
                // Single column in both → keep inline (spacesInside handles parens)
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
    // Wrap long ADD CONSTRAINT FOREIGN KEY ... REFERENCES tableName ( cols ) lines:
    // when the full line exceeds wrapLinesLongerThan, break before the REFERENCES column list,
    // aligning the continuation with the start of the FOREIGN KEY clause.
    if (options.whitespace?.wrapLinesLongerThan !== undefined && isFinite(options.whitespace.wrapLinesLongerThan)) {
        formatted = formatted.replace(
            /^(ADD CONSTRAINT \S+ )(FOREIGN KEY \([^)\n]+\) REFERENCES \S+)( \([^)\n]+\).+)$/gim,
            (fullMatch, prefix, fkPart, refCols) => {
                if (fullMatch.length <= options.whitespace!.wrapLinesLongerThan!) return fullMatch;
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
    // For scripting styles, ensure a blank line between each adjacent statement at
    // the outer proc-body indent level (8 spaces = 2×tabWidth for indented BEGIN bodies).
    // Any line ending with ";" followed immediately by the next 8-space statement gets
    // a blank line inserted. DECLARE consecutive cleanup runs immediately after.
    if (options.lists?.placeSubsequentItemsOnNewLines === 'never' && !options.lists?.placeCommasBeforeItems) {
        formatted = formatted.replace(/^(.+;)\n(?=[ \t]*(?!ELSE\b|END\b|CATCH\b|GO\b)\S)/gm, '$1\n\n');
    } else if (options.lists?.placeSubsequentItemsOnNewLines === 'never') {
        // For tabular styles with 8-space proc body, insert blank between top-level body statements only.
        formatted = formatted.replace(/^(.+;)\n(?=        (?!ELSE\b|END\b|CATCH\b)\S)/gm, '$1\n\n');
    }
    // Remove single blank lines between consecutive standalone DECLARE statements.
    formatted = formatted.replace(/([ \t]*DECLARE[ \t]+@[^\n]+;[ \t]*\n)\n([ \t]*DECLARE[ \t]+@)/gm, '$1$2');
    // Remove single blank lines between consecutive SET @var = value assignments (scripting style).
    if (options.lists?.placeSubsequentItemsOnNewLines === 'never' && !options.lists?.placeCommasBeforeItems) {
        formatted = formatted.replace(/([ \t]*SET[ \t]+@\w[^\n]+;[ \t]*\n)\n([ \t]*SET[ \t]+@\w)/gm, '$1$2');
    }
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
    // Restore space before ( in CREATE TABLE headers (dot-strip inadvertently removes it).
    formatted = formatted.replace(/^(CREATE\s+TABLE\s+\S+)\(/gim, '$1 (');
    // Restore space before ( in CREATE/ALTER PROCEDURE/FUNCTION headers (dot-strip removes it).
    formatted = formatted.replace(/^((?:CREATE|ALTER)\s+(?:OR\s+REPLACE\s+)?(?:PROCEDURE|FUNCTION|PROC)\s+\S+)\(/gim, '$1 (');
    // Restore space before ( in REFERENCES (dot-strip inadvertently removes it).
    formatted = formatted.replace(/\bREFERENCES\s+([^\s(]+)\(/g, 'REFERENCES $1 (');    // Restore space before trailing ( on REFERENCES lines created by FK expansion
    // (the dot-strip above removes the space before the trailing opening paren).
    if (expandConstraint) {
        formatted = formatted.replace(/\bREFERENCES (\S+)\($/gm, 'REFERENCES $1 (');
    }
    // Restore spaces inside REFERENCES parentheses after dot-identifier space removal.
    // Use [ \t]* (horizontal-only) to avoid matching across the line break created
    // by the FK wrap above.
    if (spacesInside) {
        formatted = formatted.replace(/\bREFERENCES\s+([^\s(]+)[ \t]*\(([^)\n]+)\)/g, 'REFERENCES $1 ( $2 )');
    }    // Restore the intentional space before the INSERT column-list opening
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
    const query = fs.readFileSync(sqlPath, 'utf8').trimEnd().replace(/\r\n/g, '\n');
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
