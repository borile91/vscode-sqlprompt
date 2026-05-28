import type { SqlPromptStyleJson } from './styleLoader';

interface ParsedStuffBlock {
    endIndex: number;
    lines: string[];
}

export function applyStuffForXmlFormatting(sql: string, style: SqlPromptStyleJson): string {
    const lines = sql.split('\n');
    const out: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        if (!/^\s*STUFF\(\s*$/i.test(line)) {
            out.push(line);
            i++;
            continue;
        }

        const parsed = parseStuffForXmlBlock(lines, i, style);
        if (!parsed) {
            out.push(line);
            i++;
            continue;
        }

        out.push(...parsed.lines);
        i = parsed.endIndex + 1;
    }

    return out.join('\n');
}

function parseStuffForXmlBlock(
    lines: string[],
    start: number,
    style: SqlPromptStyleJson,
): ParsedStuffBlock | null {
    const stuffLine = lines[start];
    const stuffIndent = indentLen(stuffLine);
    const placeCommasBeforeItems = style.lists?.placeCommasBeforeItems === true;

    let idx = start + 1;
    const parenLine = lines[idx];
    if (!parenLine) return null;

    let outerSelectExpr: string;
    const parenOnly = /^\s*\(\s*$/i.test(parenLine);
    const parenSelect = parenLine.match(/^\s*\(\s*SELECT(?:\s+(.+))?\s*$/i);
    if (parenOnly) {
        idx++;
        const outerSelect = readKeywordWithContent(lines, idx, 'SELECT');
        if (!outerSelect) return null;
        outerSelectExpr = outerSelect.content;
        idx = outerSelect.nextIndex;
    } else if (parenSelect) {
        const sameLineContent = (parenSelect[1] ?? '').trim();
        if (sameLineContent) {
            outerSelectExpr = normalizeInlineSpaces(sameLineContent);
            idx++;
        } else {
            const next = lines[idx + 1];
            if (!next || !next.trim()) return null;
            outerSelectExpr = normalizeInlineSpaces(next.trim());
            idx += 2;
        }
    } else {
        return null;
    }

    // Parse outer FROM + opening "("
    const outerFrom = readKeywordWithContent(lines, idx, 'FROM');
    if (!outerFrom) return null;
    idx = outerFrom.nextIndex;

    const fromContent = outerFrom.content.trim();
    let innerSelectExpr: string;
    if (fromContent === '(') {
        const innerSelect = readKeywordWithContent(lines, idx, 'SELECT DISTINCT');
        if (!innerSelect) return null;
        innerSelectExpr = innerSelect.content;
        idx = innerSelect.nextIndex;
    } else {
        const inlineInner = fromContent.match(/^\(\s*SELECT\s+DISTINCT\s+(.+)$/i);
        if (!inlineInner) return null;
        innerSelectExpr = normalizeInlineSpaces(inlineInner[1]);
    }

    // Parse inner body until ") AS qry"
    const innerBodyRaw: string[] = [];
    while (idx < lines.length && !/^\s*\)\s+AS\s+\w+/i.test(lines[idx])) {
        innerBodyRaw.push(lines[idx]);
        idx++;
    }
    if (idx >= lines.length) return null;

    const closeInner = lines[idx].trim(); // ) AS qry
    idx++;

    // Parse FOR XML + PATH
    const forXml = readForXmlPath(lines, idx);
    if (!forXml) return null;
    idx = forXml.nextIndex;

    // Parse args and closing alias: ), 1, 1, '', ) AS H_NOTE,
    if (!/^\s*\),\s*$/i.test(lines[idx] ?? '')) return null;
    idx++;

    const args: string[] = [];
    while (idx < lines.length && !/^\s*\)\s+AS\s+\w+/i.test(lines[idx])) {
        const arg = lines[idx].trim().replace(/,$/, '');
        if (!arg) return null;
        args.push(arg);
        idx++;
    }
    if (idx >= lines.length) return null;

    const closeStuff = lines[idx].trim();
    const closeStuffMatch = closeStuff.match(/^\)\s+AS\s+(\w+)(,?)\s*$/i);
    if (!closeStuffMatch) return null;
    const alias = closeStuffMatch[1];
    const aliasComma = closeStuffMatch[2] ?? '';

    const transformed = placeCommasBeforeItems
        ? formatCommaFirstBlock(
              stuffIndent,
                            outerSelectExpr,
                            innerSelectExpr,
              innerBodyRaw,
              closeInner,
              forXml.pathExpr,
              args,
              alias,
              aliasComma,
          )
        : formatScriptingBlock(
              stuffIndent,
                            outerSelectExpr,
                            innerSelectExpr,
              innerBodyRaw,
              closeInner,
              forXml.pathExpr,
              args,
              alias,
              aliasComma,
          );

    return { endIndex: idx, lines: transformed };
}

function formatCommaFirstBlock(
    stuffIndent: number,
    outerSelectExpr: string,
    innerSelectExpr: string,
    innerBodyRaw: string[],
    closeInner: string,
    pathExpr: string,
    args: string[],
    alias: string,
    aliasComma: string,
): string[] {
    const out: string[] = [];
    const outerFromIndent = stuffIndent + 8;
    const innerClauseIndent = outerFromIndent + 9;
    const innerAndIndent = innerClauseIndent + 7;
    const forXmlIndent = stuffIndent + 6;

    out.push(sp(stuffIndent) + `STUFF(( SELECT ${outerSelectExpr}`);
    out.push(sp(outerFromIndent) + `FROM   ( SELECT DISTINCT ${innerSelectExpr}`);

    const normalizedInner = normalizeInnerBody(innerBodyRaw);
    const rebuiltInner: string[] = [];

    for (const line of normalizedInner) {
        const t = line.trim();
        if (!t) continue;
        if (/^AND\b/i.test(t)) rebuiltInner.push(sp(innerAndIndent) + t);
        else rebuiltInner.push(sp(innerClauseIndent) + t);
    }

    if (rebuiltInner.length > 0) {
        rebuiltInner[rebuiltInner.length - 1] += ` ${closeInner}`;
    } else {
        rebuiltInner.push(sp(innerClauseIndent) + closeInner);
    }
    out.push(...rebuiltInner);

    out.push(sp(forXmlIndent) + `FOR XML PATH(${pathExpr})), ${args.join(', ')}) AS ${alias}${aliasComma}`);
    return out;
}

function formatScriptingBlock(
    stuffIndent: number,
    outerSelectExpr: string,
    innerSelectExpr: string,
    innerBodyRaw: string[],
    closeInner: string,
    pathExpr: string,
    args: string[],
    alias: string,
    aliasComma: string,
): string[] {
    const out: string[] = [];
    const fromIndent = stuffIndent + 1;
    const innerClauseIndent = stuffIndent + 7;
    const innerAndIndent = stuffIndent + 13;

    out.push(sp(stuffIndent) + 'STUFF(');
    out.push(sp(stuffIndent) + `(SELECT ${outerSelectExpr}`);
    out.push(sp(fromIndent) + `FROM (SELECT DISTINCT ${innerSelectExpr}`);

    const normalizedInner = normalizeInnerBody(innerBodyRaw);
    const rebuiltInner: string[] = [];
    for (const line of normalizedInner) {
        const t = line.trim();
        if (!t) continue;
        if (/^AND\b/i.test(t)) rebuiltInner.push(sp(innerAndIndent) + t);
        else rebuiltInner.push(sp(innerClauseIndent) + t);
    }

    if (rebuiltInner.length > 0) {
        rebuiltInner[rebuiltInner.length - 1] += closeInner;
    } else {
        rebuiltInner.push(sp(innerClauseIndent) + closeInner);
    }
    out.push(...rebuiltInner);

    out.push(sp(stuffIndent) + `FOR XML PATH(${pathExpr})), ${args.join(', ')}) AS ${alias}${aliasComma}`);
    return out;
}

function readKeywordWithContent(
    lines: string[],
    start: number,
    keyword: 'SELECT' | 'FROM' | 'SELECT DISTINCT',
): { content: string; nextIndex: number } | null {
    const re = new RegExp(`^\\s*${escapeForRegex(keyword)}(?:\\s+(.+))?\\s*$`, 'i');
    const current = lines[start];
    if (!current) return null;

    const m = current.match(re);
    if (!m) return null;

    const sameLineContent = (m[1] ?? '').trim();
    if (sameLineContent) {
        return { content: normalizeInlineSpaces(sameLineContent), nextIndex: start + 1 };
    }

    const next = lines[start + 1];
    if (!next) return null;
    const nextTrimmed = next.trim();
    if (!nextTrimmed) return null;

    return { content: normalizeInlineSpaces(nextTrimmed), nextIndex: start + 2 };
}

function readForXmlPath(lines: string[], start: number): { pathExpr: string; nextIndex: number } | null {
    const current = lines[start];
    if (!current) return null;

    const oneLine = current.match(/^\s*FOR\s+XML\s+PATH\s*\((.+)\)\s*$/i);
    if (oneLine) {
        return { pathExpr: normalizeInlineSpaces(oneLine[1]), nextIndex: start + 1 };
    }

    const forXmlOnly = current.match(/^\s*FOR\s+XML\s*$/i);
    if (!forXmlOnly) return null;

    const next = lines[start + 1];
    if (!next) return null;
    const pathLine = next.match(/^\s*PATH\s*\((.+)\)\s*$/i);
    if (!pathLine) return null;

    return { pathExpr: normalizeInlineSpaces(pathLine[1]), nextIndex: start + 2 };
}

function normalizeInnerBody(lines: string[]): string[] {
    const out: string[] = [];
    let pendingKeyword: 'FROM' | 'WHERE' | null = null;

    for (const line of lines) {
        const t = line.trim();
        if (!t) continue;

        if (/^FROM\s*$/i.test(t)) {
            pendingKeyword = 'FROM';
            continue;
        }
        if (/^WHERE\s*$/i.test(t)) {
            pendingKeyword = 'WHERE';
            continue;
        }

        if (pendingKeyword) {
            out.push(`${pendingKeyword} ${t}`);
            pendingKeyword = null;
            continue;
        }

        out.push(t);
    }

    return out;
}

function normalizeInlineSpaces(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function indentLen(line: string): number {
    return line.length - line.trimStart().length;
}

function escapeForRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sp(len: number): string {
    return ' '.repeat(Math.max(0, len));
}
