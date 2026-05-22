import type { SqlPromptStyleJson } from './styleLoader';

/**
 * Post-processes sql-formatter output to apply CASE expression formatting rules:
 *
 * - `placeFirstWhenOnNewLine: "always" | "never" | "ifInputExpression"`
 *   Controls whether the first WHEN goes on a new line.
 * - `whenAlignment: "toFirstItem" | "toCase" | "indented"`
 *   Horizontal position of WHEN/ELSE relative to CASE.
 * - `alignElseToWhen: true`   — ELSE aligns with the WHEN keywords.
 * - `placeElseOnNewLine: true` — ELSE starts on a new line.
 * - `placeEndOnNewLine: true`  — END starts on a new line.
 * - `endAlignment: "toCase" | "toFirstItem" | "indented"`
 *   Horizontal position of END.
 *
 * Operates as a line-by-line state machine; CASE expressions may be nested but
 * the formatter handles single-level nesting correctly for common patterns.
 */
export function applyCaseFormatting(sql: string, style: SqlPromptStyleJson, tabWidth: number): string {
    const cfg = style.caseExpressions;
    if (!cfg) return sql;

    const placeFirstWhen = cfg.placeFirstWhenOnNewLine ?? 'always';
    const whenAlignment = cfg.whenAlignment ?? 'toCase';
    const alignElse = cfg.alignElseToWhen ?? true;
    const placeElse = cfg.placeElseOnNewLine ?? true;
    const placeEnd = cfg.placeEndOnNewLine ?? true;
    const endAlignment = cfg.endAlignment ?? 'toCase';

    // We process token-by-token on the whole SQL string, scanning for CASE…END.
    // This handles CASE on a single line as well as already-expanded multi-line.

    // State machine: find CASE tokens, track context.
    // We work on a flat token stream reconstructed from lines.

    const result = processCaseExpressions(
        sql,
        placeFirstWhen,
        whenAlignment,
        alignElse,
        placeElse,
        placeEnd,
        endAlignment,
        tabWidth,
    );
    return result;
}

interface CaseToken {
    kind: 'CASE' | 'WHEN' | 'THEN' | 'ELSE' | 'END' | 'INPUT' | 'OTHER';
    text: string;
}

/**
 * Very simple CASE scanner: finds CASE … END blocks on a line and reformats
 * them. Only handles the outermost CASE on each line (no deep nesting).
 */
function processCaseExpressions(
    sql: string,
    placeFirstWhen: string,
    whenAlignment: string,
    alignElse: boolean,
    placeElse: boolean,
    placeEnd: boolean,
    endAlignment: string,
    tabWidth: number,
): string {
    const lines = sql.split('\n');
    const output: string[] = [];

    for (const line of lines) {
        // Find CASE keyword on this line (case-insensitive, word boundary)
        const caseMatch = line.match(/^(\s*)(.*?\bCASE\b)(.*)/i);
        if (!caseMatch) {
            output.push(line);
            continue;
        }

        const lineIndent = caseMatch[1].length;
        const prefix = caseMatch[1] + caseMatch[2]; // up to and including CASE
        const rest = caseMatch[3].trim();

        // Determine if this is a "searched CASE" (CASE WHEN …) or
        // "simple CASE" (CASE <expr> WHEN …)
        const isSearched = /^WHEN\b/i.test(rest);

        // Parse the rest: INPUT? WHEN val THEN res [WHEN val THEN res]* [ELSE res] END
        const tokens = tokeniseCaseRest(rest);
        if (tokens.length === 0) {
            // Malformed or already multi-line — leave as-is
            output.push(line);
            continue;
        }

        // Compute alignment columns
        // caseCol = column of the C in CASE
        const caseCol = prefix.lastIndexOf('CASE');
        const caseKeywordCol = caseCol >= 0 ? caseCol : lineIndent;

        let whenCol: number;
        if (whenAlignment === 'toCase') {
            whenCol = caseKeywordCol;
        } else if (whenAlignment === 'indented') {
            whenCol = caseKeywordCol + tabWidth;
        } else {
            // "toFirstItem": WHEN aligns just after CASE + space (or CASE <expr> + space)
            // Find how far in the first WHEN would be if kept on the CASE line
            // Use caseKeywordCol + 5 (length of "CASE ") = caseKeywordCol + 5
            whenCol = caseKeywordCol + 5;
        }
        const endCol = endAlignment === 'toCase' ? caseKeywordCol
            : endAlignment === 'indented' ? caseKeywordCol + tabWidth
            : whenCol; // toFirstItem

        const needsFirstWhenNewLine =
            placeFirstWhen === 'always' ||
            (placeFirstWhen === 'ifInputExpression' && !isSearched);

        // Build output lines for this CASE expression
        const caseLines: string[] = [];

        // First line: prefix (up to and including CASE) + optional input expression
        let caseLine = prefix;
        let firstWhenEmitted = false;

        for (let t = 0; t < tokens.length; t++) {
            const tok = tokens[t];

            if (tok.kind === 'INPUT') {
                caseLine += ' ' + tok.text;
            } else if (tok.kind === 'WHEN') {
                if (!firstWhenEmitted) {
                    if (needsFirstWhenNewLine) {
                        caseLines.push(caseLine);
                        caseLine = ' '.repeat(whenCol) + tok.text;
                    } else {
                        caseLine += ' ' + tok.text;
                    }
                    firstWhenEmitted = true;
                } else {
                    caseLines.push(caseLine);
                    caseLine = ' '.repeat(whenCol) + tok.text;
                }
            } else if (tok.kind === 'THEN') {
                caseLine += ' ' + tok.text;
            } else if (tok.kind === 'ELSE') {
                if (placeElse) {
                    caseLines.push(caseLine);
                    const elseCol = alignElse ? whenCol : caseKeywordCol;
                    caseLine = ' '.repeat(elseCol) + tok.text;
                } else {
                    caseLine += ' ' + tok.text;
                }
            } else if (tok.kind === 'END') {
                if (placeEnd) {
                    caseLines.push(caseLine);
                    caseLine = ' '.repeat(endCol) + tok.text;
                } else {
                    caseLine += ' ' + tok.text;
                }
                // Do NOT push/reset here — any trailing content (e.g. AS alias)
                // will be appended by the next OTHER token, then flushed at end.
            } else {
                // OTHER: value/expression
                caseLine += ' ' + tok.text;
            }
        }
        if (caseLine.trim()) caseLines.push(caseLine);

        output.push(...caseLines);
    }

    return output.join('\n');
}

/**
 * Tokenises the part of the line after the CASE keyword into a sequence of
 * labelled tokens: INPUT, WHEN, THEN, ELSE, END, OTHER.
 *
 * Returns [] if the END keyword is not found on the same line (already expanded).
 */
function tokeniseCaseRest(rest: string): CaseToken[] {
    // Quick check: must contain END on this line for us to process
    if (!/\bEND\b/i.test(rest)) return [];

    const tokens: CaseToken[] = [];
    // Split by CASE keywords (WHEN, THEN, ELSE, END) keeping the delimiters
    const parts = rest.split(/\b(WHEN|THEN|ELSE|END)\b/i);
    // parts alternates: [before_first_kw, kw, content, kw, content, ...]
    // Index 0: optional input expression (before first WHEN/ELSE/END)
    let idx = 0;

    if (parts[0].trim()) {
        tokens.push({ kind: 'INPUT', text: parts[0].trim() });
    }
    idx = 1;

    while (idx < parts.length) {
        const kw = parts[idx]?.toUpperCase() as CaseToken['kind'];
        const content = parts[idx + 1]?.trim() ?? '';

        if (kw === 'WHEN' || kw === 'THEN' || kw === 'ELSE' || kw === 'END') {
            tokens.push({ kind: kw, text: kw });
            if (content) {
                tokens.push({ kind: 'OTHER', text: content });
            }
        }
        idx += 2;
    }

    return tokens;
}

/**
 * Pre-pass: collapses multi-line CASE…END expressions onto a single line so
 * that the list formatter can treat the whole CASE as one item (correct leading-
 * comma placement). `applyCaseFormatting` then re-expands to the final format.
 *
 * Only collapses when `caseExpressions` config is present (i.e. when the CASE
 * formatter will later run). Does not cross blank lines or BEGIN blocks.
 */
export function collapseCaseToSingleLine(sql: string, style: SqlPromptStyleJson): string {
    if (!style.caseExpressions) return sql;

    const lines = sql.split('\n');
    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // Count CASE and END occurrences on this line (word-boundary)
        const casesOnLine = (line.match(/\bCASE\b/gi) ?? []).length;
        const endsOnLine = (line.match(/\bEND\b/gi) ?? []).length;

        if (casesOnLine === 0 || casesOnLine <= endsOnLine) {
            // No unmatched CASE on this line — leave as-is
            result.push(line);
            i++;
            continue;
        }

        // Unmatched CASE: collect subsequent lines until depth reaches 0
        let depth = casesOnLine - endsOnLine;
        let combined = line.trimEnd();
        let j = i + 1;
        let aborted = false;

        while (j < lines.length && depth > 0) {
            const nextTrimmed = lines[j].trim();

            // Stop at blank lines or BEGIN blocks (don't collapse across them)
            if (nextTrimmed === '' || /\bBEGIN\b/i.test(nextTrimmed)) {
                aborted = true;
                break;
            }

            const moreCases = (nextTrimmed.match(/\bCASE\b/gi) ?? []).length;
            const moreEnds = (nextTrimmed.match(/\bEND\b/gi) ?? []).length;
            depth += moreCases - moreEnds;

            combined += ' ' + nextTrimmed;
            j++;
        }

        if (!aborted && depth <= 0) {
            // Successfully collapsed — preserve leading whitespace of original line
            const leadingSpace = (line.match(/^(\s*)/) ?? ['', ''])[1];
            const content = combined.trim().replace(/\s+/g, ' ');
            result.push(leadingSpace + content);
            i = j;
        } else {
            result.push(line);
            i++;
        }
    }

    return result.join('\n');
}
