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
    const BOUNDARY_RE =
        /(?<![a-zA-Z0-9@_])(END\s+(?:TRY|CATCH)\s*;?|BEGIN\s+(?:TRY|CATCH)\s*;?|END\s*;?|BEGIN(?!\s+(?:TRANSACTION|DISTRIBUTED|TRY|CATCH)\b))(?![a-zA-Z0-9_])/gi;

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

    for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed) {
            result.push(line);
            continue;
        }

        if (STANDALONE_END_RE.test(trimmed)) {
            // Bare END: matches same indent as its opening bare BEGIN
            const savedExtra = stack.length > 0 ? stack.pop()! : 0;
            result.push(' '.repeat(savedExtra + tabWidth) + applyKeywordCasing(trimmed, style));
            contentExtraIndent = savedExtra;

        } else if (COMPOUND_END_RE.test(trimmed)) {
            // END TRY / END CATCH: back to the level of the matching BEGIN TRY/CATCH
            const savedExtra = stack.length > 0 ? stack.pop()! : 0;
            result.push(' '.repeat(savedExtra) + applyKeywordCasing(trimmed, style));
            contentExtraIndent = savedExtra;

        } else if (COMPOUND_BEGIN_RE.test(trimmed)) {
            // BEGIN TRY / BEGIN CATCH: stays at current level, opens indented block
            result.push(' '.repeat(contentExtraIndent) + applyKeywordCasing(trimmed, style));
            stack.push(contentExtraIndent);
            contentExtraIndent += tabWidth;

        } else if (STANDALONE_BEGIN_RE.test(trimmed)) {
            // Bare BEGIN: indented one level beyond the owning statement
            const beginIndent = contentExtraIndent + tabWidth;
            result.push(' '.repeat(beginIndent) + applyKeywordCasing(trimmed, style));
            stack.push(contentExtraIndent);
            contentExtraIndent = indentContents ? beginIndent + tabWidth : beginIndent;

        } else {
            // Regular content: prepend extra indent, keeping sql-formatter's own
            // indentation intact (preserves tabularLeft column alignment)
            result.push(contentExtraIndent > 0 ? ' '.repeat(contentExtraIndent) + line : line);
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
            // Look ahead: skip this blank line if the next non-blank line is END
            let next = i + 1;
            while (next < lines.length && lines[next].trim() === '') next++;
            if (next < lines.length && /^END\b/i.test(lines[next].trim())) {
                continue; // drop this blank line
            }
        }

        result.push(lines[i]);
    }

    return result.join('\n');
}
