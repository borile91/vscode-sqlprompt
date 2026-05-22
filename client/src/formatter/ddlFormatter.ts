import type { SqlPromptStyleJson } from './styleLoader';

/**
 * Post-processes sql-formatter output to apply DDL column definition formatting:
 *
 * - `ddl.verticallyAlignDataTypes: true` — in CREATE TABLE / ALTER TABLE column
 *   definition lists, data type names are padded so they all start at the same
 *   column (the column after the longest column name + 1 space).
 *
 * This formatter detects CREATE TABLE / ALTER TABLE blocks and processes the
 * column definition lines inside their parentheses.
 */
export function applyDdlFormatting(sql: string, style: SqlPromptStyleJson): string {
    if (!style.ddl?.verticallyAlignDataTypes) return sql;
    return alignDdlDataTypes(sql);
}

/**
 * Matches a CREATE or ALTER TABLE/PROCEDURE statement opening.
 * We only process CREATE TABLE / ALTER TABLE for column alignment.
 */
const CREATE_ALTER_RE = /^\s*(?:CREATE|ALTER)\s+TABLE\b/i;

/**
 * Matches a column definition line inside a CREATE TABLE block.
 * Captures: [indent, columnName, dataType, remainder]
 *
 * Handles both plain identifiers and bracket-quoted identifiers:
 *   OrderID         INT           NOT NULL
 *   [Order Date]    DATETIME      NOT NULL
 */
const COLUMN_DEF_RE = /^(\s+)(\[?[a-zA-Z_@#][a-zA-Z0-9_@#$]*\]?|\[[^\]]+\])\s+(\S+)(.*)/;

/**
 * Matches lines that are constraints (PRIMARY KEY, FOREIGN KEY, UNIQUE, CHECK,
 * INDEX) — these don't get data type alignment.
 */
const CONSTRAINT_RE = /^\s+(?:PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|INDEX|CONSTRAINT)\b/i;

/**
 * Matches a leading-comma column definition (MadLab style):
 *   , OrderDate DATETIME NOT NULL
 */
const LEADING_COMMA_COL_RE = /^(\s+,\s+)(\[?[a-zA-Z_@#][a-zA-Z0-9_@#$]*\]?|\[[^\]]+\])\s+(\S+)(.*)/;

interface ColumnDef {
    /** Full original line */
    original: string;
    /** Leading whitespace/comma prefix */
    prefix: string;
    /** Column name */
    name: string;
    /** Data type */
    dataType: string;
    /** Everything after the data type */
    remainder: string;
    /** Whether this is a definition line (vs constraint/other) */
    isDefinition: boolean;
}

export function alignDdlDataTypes(sql: string): string {
    const lines = sql.split('\n');
    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // Detect start of a CREATE/ALTER TABLE block
        if (CREATE_ALTER_RE.test(line)) {
            result.push(line);
            i++;

            // Scan ahead to find the opening paren and collect column defs
            // The opening paren may be on the CREATE TABLE line itself or on the
            // next line (when ddl.openingParenthesisBreakType: "always").
            let blockLines: string[] = [];
            let openCount = 0;
            let blockStartIdx = i;

            // Count parens to find the matching close
            while (i < lines.length) {
                const blockLine = lines[i];
                for (const ch of blockLine) {
                    if (ch === '(') openCount++;
                    else if (ch === ')') openCount--;
                }
                blockLines.push(blockLine);
                i++;
                // Stop after we've closed all open parens (including the one from
                // the CREATE TABLE line if any)
                if (openCount <= 0 && blockLines.length > 0) break;
            }
            // If we never found a paren block, just emit the lines as-is
            if (openCount > 0) {
                result.push(...blockLines);
                continue;
            }

            result.push(...processCreateTableBlock(blockLines));
            continue;
        }

        result.push(line);
        i++;
    }

    return result.join('\n');
}

/**
 * Processes a block of lines that came after a CREATE/ALTER TABLE header
 * (i.e. from the opening `(` to the closing `)`).
 * Aligns data types in column definition lines.
 */
function processCreateTableBlock(lines: string[]): string[] {
    // Parse each line into a ColumnDef (or mark as non-definition)
    const defs: ColumnDef[] = lines.map(line => {
        if (CONSTRAINT_RE.test(line)) {
            return { original: line, prefix: '', name: '', dataType: '', remainder: '', isDefinition: false };
        }

        // Try leading-comma style first
        const lcMatch = line.match(LEADING_COMMA_COL_RE);
        if (lcMatch) {
            return {
                original: line,
                prefix: lcMatch[1],
                name: lcMatch[2],
                dataType: lcMatch[3],
                remainder: lcMatch[4],
                isDefinition: true,
            };
        }

        // Try standard indented definition
        const stdMatch = line.match(COLUMN_DEF_RE);
        if (stdMatch) {
            return {
                original: line,
                prefix: stdMatch[1],
                name: stdMatch[2],
                dataType: stdMatch[3],
                remainder: stdMatch[4],
                isDefinition: true,
            };
        }

        return { original: line, prefix: '', name: '', dataType: '', remainder: '', isDefinition: false };
    });

    // Compute max (prefix.length + name.length) across all definition lines so
    // that data types start at the same absolute column regardless of whether
    // the line uses a standard indent or a leading-comma prefix.
    let maxPrefixPlusNameLen = 0;
    for (const d of defs) {
        if (d.isDefinition) {
            maxPrefixPlusNameLen = Math.max(maxPrefixPlusNameLen, d.prefix.length + d.name.length);
        }
    }

    if (maxPrefixPlusNameLen === 0) return lines;

    // Re-emit lines with aligned data types
    return defs.map(d => {
        if (!d.isDefinition) return d.original;
        const targetNameLen = maxPrefixPlusNameLen - d.prefix.length;
        const paddedName = d.name.padEnd(targetNameLen);
        return d.prefix + paddedName + ' ' + d.dataType + d.remainder;
    });
}
