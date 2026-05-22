import type { SqlPromptStyleJson } from './styleLoader';

/**
 * Post-processes sql-formatter output to apply semicolon placement rules:
 *
 * - `"none"` (default)     — semicolons are attached to the last token of each
 *   statement with no preceding space (sql-formatter default; no-op unless the
 *   source had spaces/newlines before the semicolon).
 * - `"spaceBefore"`        — a single space is inserted before every semicolon.
 * - `"newLineBefore"`      — the semicolon is moved to its own line.
 *
 * A semicolon that is already on its own line (possibly with leading whitespace)
 * is always handled correctly regardless of the starting format.
 */
export function applySemicolonFormatting(sql: string, style: SqlPromptStyleJson): string {
    const placement = style.whitespace?.whiteSpaceBeforeSemiColon ?? 'none';
    if (placement === 'none') {
        return normaliseSemicolons(sql, '');
    }
    if (placement === 'spaceBefore') {
        return normaliseSemicolons(sql, ' ');
    }
    if (placement === 'newLineBefore') {
        return semicolonOnNewLine(sql);
    }
    return sql;
}

/**
 * Ensures every `;` is immediately preceded by `prefix` (and not any extra
 * whitespace). Handles semicolons that are:
 *   - inline: `token ;` or `token;`
 *   - on their own line: `\n   ;`
 */
function normaliseSemicolons(sql: string, prefix: string): string {
    // First, join any standalone semicolon lines back to the previous line
    const joined = sql.replace(/([^\n;])\n[ \t]*;/g, `$1${prefix};`);
    // Then normalise inline semicolons (remove existing space(s) before `;` and re-add prefix)
    return joined.replace(/[ \t]*;/g, `${prefix};`);
}

/**
 * Moves every `;` to its own line (newLineBefore).
 */
function semicolonOnNewLine(sql: string): string {
    // Remove any existing whitespace (including a newline) directly before `;`
    // then insert a newline
    return sql.replace(/[ \t]*;/g, '\n;');
}
