import type { SqlPromptStyleJson } from './styleLoader';

// Bare BEGIN on its own line (no compound keyword, no comment allowed after BEGIN TRANSACTION etc.)
const STANDALONE_BEGIN_RE = /^BEGIN\b\s*(?:--[^\n]*)?$/i;
// Compound BEGIN: BEGIN TRY or BEGIN CATCH
const COMPOUND_BEGIN_RE = /^BEGIN\s+(TRY|CATCH)\b\s*;?\s*(?:--[^\n]*)?$/i;
// Bare END on its own line
const STANDALONE_END_RE = /^END\b\s*;?\s*(?:--[^\n]*)?$/i;
// Compound END: END TRY or END CATCH
const COMPOUND_END_RE = /^END\s+(TRY|CATCH)\b\s*;?\s*(?:--[^\n]*)?$/i;

/**
 * Splits a single line at every block-boundary keyword, placing each keyword
 * on its own output line. Handles all of:
 *   "FROM tabella END"                   → ["FROM tabella", "END"]
 *   "ELSE BEGIN"                          → ["ELSE", "BEGIN"]
 *   "IF @x > 0 BEGIN"                    → ["IF @x > 0", "BEGIN"]
 *   "END TRY BEGIN CATCH SELECT 1"       → ["END TRY", "BEGIN CATCH", "SELECT 1"]
 *   "SELECT 3 END TRY BEGIN CATCH END CATCH IF 1=1 BEGIN" → 6 segments
 *   "BEGIN TRANSACTION;"                  → unchanged
 */
function splitBlockBoundaries(line: string): string[] {
    const trimmed = line.trim();
    if (!trimmed) return [''];

    // Compound keywords must appear before their simple counterparts in the
    // alternation so the engine matches "END TRY" before plain "END".
    // Negative lookbehind/lookahead prevent matching inside identifiers or
    // variable names like @end / end_date.
    // BEGIN TRANSACTION and BEGIN DISTRIBUTED are excluded via negative lookahead.
    // END followed by AS is a CASE expression terminator (e.g. END AS alias),
    // not a block boundary — exclude it via negative lookahead.
    const BOUNDARY_RE =
        /(?<![a-zA-Z0-9@_])(END\s+(?:TRY|CATCH)\s*;?|BEGIN\s+(?:TRY|CATCH)\s*;?|END(?!\s+AS\b)\s*;?|BEGIN(?!\s+(?:TRANSACTION|DISTRIBUTED|TRY|CATCH)\b))(?![a-zA-Z0-9_])/gi;

    const segments: string[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = BOUNDARY_RE.exec(trimmed)) !== null) {
        const before = trimmed.slice(lastIndex, match.index).trim();
        if (before) segments.push(before);
        segments.push(match[1].trim());
        lastIndex = match.index + match[0].length;
    }

    const remainder = trimmed.slice(lastIndex).trim();
    if (remainder) segments.push(remainder);

    // If nothing was split, return the original line (preserves leading whitespace)
    return segments.length > 1 ? segments : [line];
}

/**
 * Applies casing to a boundary keyword line when reservedKeywords = "uppercase".
 */
function applyKeywordCasing(text: string, style: SqlPromptStyleJson): string {
    if (style.casing?.reservedKeywords === 'uppercase') return text.toUpperCase();
    if (style.casing?.reservedKeywords === 'lowercase') return text.toLowerCase();
    return text;
}

/**
 * Post-processes sql-formatter output to apply controlFlow indentation settings:
 *
 * - `indentBeginAndEndKeywords: true`  — bare BEGIN / END are indented one extra
 *   level relative to the owning control-flow statement.
 *   BEGIN TRY / BEGIN CATCH / END TRY / END CATCH stay at current level but open
 *   an indented content block.
 * - `indentContentsOfStatements: true`  — content inside BEGIN…END is indented
 *   one level beyond the BEGIN keyword (default).
 * - `indentContentsOfStatements: false` — content sits at the same level as BEGIN.
 */
export function applyControlFlowIndentation(
    sql: string,
    style: SqlPromptStyleJson,
    tabWidth: number,
): string {
    const cf = style.controlFlow;
    if (!cf?.indentBeginAndEndKeywords) return sql;

    const indentContents = cf.indentContentsOfStatements ?? true;

    // Pre-pass: place every block-boundary keyword on its own line
    const lines = sql.split('\n').flatMap(line => splitBlockBoundaries(line));

    const result: string[] = [];
    let contentExtraIndent = 0;
    const stack: number[] = []; // saves contentExtraIndent at each block entry
    // When > 0, the NEXT non-blank non-BEGIN, non-AND/OR line is a single-statement
    // IF / WHILE / ELSE body and should be emitted at this indent level.
    let pendingSingleBodyIndent = 0;
    // Width of the keyword (e.g. "IF " = 3, "WHILE " = 6) that set pendingSingleBodyIndent.
    // Used to place AND/OR condition continuations at the correct column.
    let pendingSingleBodyKeywordWidth = 0;
    // Sentinel pushed into `stack` when a bare BEGIN is treated as a compound
    // opener (i.e. it's the outermost BEGIN of a function body at indent 0).
    // The matching END must then be emitted without the extra tabWidth.
    const COMPOUND_SENTINEL = -1;
    // When true, we are inside a COMPOUND_SENTINEL block (the outermost function
    // body BEGIN/END). Lines here already have sql-formatter's absolute indent so
    // we must PREPEND contentExtraIndent rather than strip-and-replace.
    // Outside compound blocks (inside nested BEGIN/END), we strip-and-replace so
    // that sql-formatter's inner indent does not double-count with our extra indent.
    let inCompoundBlock = false;

    for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed) {
            result.push(line);
            continue;
        }



        if (STANDALONE_END_RE.test(trimmed)) {
            // Bare END: matches same indent as its opening bare BEGIN
            const savedExtra = stack.length > 0 ? stack.pop()! : 0;
            pendingSingleBodyIndent = 0;
            pendingSingleBodyKeywordWidth = 0;
            if (savedExtra === COMPOUND_SENTINEL) {
                // Matching a compound-sentinel BEGIN — emit at base level (no +tabWidth)
                result.push(applyKeywordCasing(trimmed, style));
                contentExtraIndent = 0;
                inCompoundBlock = false;
            } else {
                result.push(' '.repeat(savedExtra + tabWidth) + applyKeywordCasing(trimmed, style));
                contentExtraIndent = savedExtra;
            }

        } else if (COMPOUND_END_RE.test(trimmed)) {
            // END TRY / END CATCH: back to the level of the matching BEGIN TRY/CATCH
            const savedExtra = stack.length > 0 ? stack.pop()! : 0;
            pendingSingleBodyIndent = 0;
            pendingSingleBodyKeywordWidth = 0;
            if (style.ddl?.indentClauses) {
            // tabular mode: applyProcBodyIndentation adds the base shift;
            // END TRY/CATCH must align with the matching BEGIN TRY/CATCH.
                result.push(' '.repeat(savedExtra) + applyKeywordCasing(trimmed, style));
            } else {
                // scripting mode: no applyProcBodyIndentation shift;
                // add tabWidth so END TRY/CATCH sits at the BEGIN TRY/CATCH column.
                result.push(' '.repeat(savedExtra + tabWidth) + applyKeywordCasing(trimmed, style));
            }
            contentExtraIndent = savedExtra;

        } else if (COMPOUND_BEGIN_RE.test(trimmed)) {
            // BEGIN TRY / BEGIN CATCH: placement depends on whether
            // applyProcBodyIndentation will later add a base tabWidth shift.
            pendingSingleBodyIndent = 0;
            pendingSingleBodyKeywordWidth = 0;
            if (style.ddl?.indentClauses) {
            // tabular mode: emit at current level; applyProcBodyIndentation
            // adds the base shift, so we must not double-add here.
                result.push(' '.repeat(contentExtraIndent) + applyKeywordCasing(trimmed, style));
                stack.push(contentExtraIndent);
                contentExtraIndent += tabWidth;
            } else {
                // scripting mode: applyProcBodyIndentation won't shift;
                // add tabWidth explicitly so BEGIN TRY/CATCH is indented.
                const beginTryIndent = contentExtraIndent + tabWidth;
                result.push(' '.repeat(beginTryIndent) + applyKeywordCasing(trimmed, style));
                stack.push(contentExtraIndent);
                contentExtraIndent = beginTryIndent + tabWidth;
            }

        } else if (STANDALONE_BEGIN_RE.test(trimmed)) {
            // Bare BEGIN: normally indented one level beyond the owning statement.
            // A bare BEGIN at contentExtraIndent === 0 with no active
            // pending single-body context is the outermost function-body BEGIN
            // (e.g. ALTER FUNCTION … AS BEGIN … END).  Treat it as a compound opener
            // so that applyProcBodyIndentation can add the base tabWidth offset
            // without double-indenting it.
            // When there is a pending single-body indent (e.g. "IF cond\n BEGIN"),
            // the BEGIN is the compound body of the IF and should be placed at
            // pendingSingleBodyIndent (= IF_indent + tabWidth).
            const hadPendingSingleBody = pendingSingleBodyIndent > 0;
            const beginBase =
                pendingSingleBodyIndent > 0 ? pendingSingleBodyIndent - tabWidth : contentExtraIndent;
            pendingSingleBodyIndent = 0;
            pendingSingleBodyKeywordWidth = 0;
            if (beginBase === 0 && !hadPendingSingleBody) {
                result.push(applyKeywordCasing(trimmed, style));
                stack.push(COMPOUND_SENTINEL);
                contentExtraIndent = tabWidth;
                inCompoundBlock = true;
            } else {
                const beginIndent = beginBase + tabWidth;
                result.push(' '.repeat(beginIndent) + applyKeywordCasing(trimmed, style));
                stack.push(beginBase);
                contentExtraIndent = indentContents ? beginIndent + tabWidth : beginIndent;
            }

        } else {
            // Regular content: prepend extra indent, keeping sql-formatter's own
            // indentation intact (preserves tabularLeft column alignment).

            // AND/OR lines may be condition continuations for a preceding IF/WHILE:
            // they align at (IF_indent + IF_keyword_width) rather than using pendingSingleBodyIndent.
            const isConditionCont =
                pendingSingleBodyIndent > 0 && /^(?:AND|OR)\b/i.test(trimmed);

            if (isConditionCont) {
                // Align at the IF/WHILE content column: IF_indent + keyword_width
                // pendingSingleBodyIndent = emittedIndent + tabWidth, so
                // emittedIndent = pendingSingleBodyIndent - tabWidth
                // AND/OR should be at: emittedIndent + keyword_width
                // Normalise tabular-left padding between AND/OR and the condition:
                // sql-formatter pads "AND    expr" to align columns; collapse to one space.
                const normTrimmed = trimmed.replace(/^(AND|OR)\s+/i, (_, kw) => kw + ' ');
                const condIndent =
                    (pendingSingleBodyIndent - tabWidth) + pendingSingleBodyKeywordWidth;
                result.push(condIndent > 0 ? ' '.repeat(condIndent) + normTrimmed : normTrimmed);
                // Leave pendingSingleBodyIndent in place — body statement comes later
            } else {
                const effectiveIndent =
                    pendingSingleBodyIndent > 0 ? pendingSingleBodyIndent : contentExtraIndent;
                // For lines placed because of pendingSingleBodyIndent (the body of an
                // IF/WHILE/ELSE that has no BEGIN), strip the original leading whitespace
                // and replace it with the computed indent to avoid double-counting
                // sql-formatter's base indent.
                if (pendingSingleBodyIndent > 0) {
                    result.push(' '.repeat(effectiveIndent) + trimmed);
                } else if (effectiveIndent > 0) {
                    result.push(' '.repeat(effectiveIndent) + line);
                } else {
                    result.push(line);
                }

                const isComment = trimmed.startsWith('--');
                if (!isComment) {
                    // Non-comment lines consume the pending single-body marker
                    pendingSingleBodyIndent = 0;
                    pendingSingleBodyKeywordWidth = 0;
                }

                // Mark that the NEXT non-blank line should be indented as a single-statement
                // body (applies to IF, WHILE, and ELSE / ELSE IF not followed by BEGIN).
                // NOTE: ELSE is only treated as a control-flow marker when it is
                // standalone ("ELSE" on its own line, optionally with a comment) or
                // "ELSE IF …" — never when it is a CASE ELSE expression like "ELSE NULL".
                if (!isComment) {
                    const isControlFlowElse =
                        /^ELSE\b/i.test(trimmed) &&
                        (/^ELSE\s*(?:--.*)?$/i.test(trimmed) || /^ELSE\s+IF\b/i.test(trimmed));
                    const cfm =
                        trimmed.match(/^(IF|WHILE)\b/i) ??
                        (isControlFlowElse ? trimmed.match(/^(ELSE(?:\s+IF)?)/) : null);
                    if (cfm) {
                        // The body must be tabWidth deeper than the IF/WHILE/ELSE line.
                        // When effectiveIndent > 0 the line is being placed there; otherwise
                        // it keeps sql-formatter's own indent which we must measure from `line`.
                        const emittedIndent =
                            effectiveIndent > 0
                                ? effectiveIndent
                                : line.match(/^(\s*)/)![1].length;
                        pendingSingleBodyIndent = emittedIndent + tabWidth;
                        // Width includes the keyword + one space (e.g. "IF " = 3, "ELSE IF " = 8)
                        pendingSingleBodyKeywordWidth =
                            cfm[1].replace(/\s+/g, ' ').length + 1;
                    }
                }
            }
        }
    }

    return result.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Remove blank lines before END keywords
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Removes blank lines immediately before END / END TRY / END CATCH lines.
 *
 * sql-formatter emits one blank line between every statement, which means
 * the last statement before END is always followed by a blank line.  SQL Prompt
 * style does not use blank lines before closing END keywords.
 */
export function removeBlankLinesBeforeEnd(sql: string): string {
    const lines = sql.split('\n');
    const result: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();

        if (trimmed === '') {
            // Look ahead: skip this blank line if the next non-blank line is END or ELSE
            let next = i + 1;
            while (next < lines.length && lines[next].trim() === '') next++;
            if (next < lines.length && /^(?:END|ELSE)\b/i.test(lines[next].trim())) {
                continue; // drop this blank line
            }
        }

        result.push(lines[i]);
    }

    return result.join('\n');
}
