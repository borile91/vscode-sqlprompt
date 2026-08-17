import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SqlPromptStyleJson } from '../styleLoader.js';
import { formatSql } from '../formatSql.js';

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

/**
 * Rebuilds an "unformatted" version of a fixture: every statement is joined
 * onto a single line, keeping comments and GO separators on their own.
 * Formatting it must produce the fixture back — the fixed-point test alone
 * would also pass for a formatter that never touches anything.
 */
function joinStatementLines(sql: string): string {
    const out: string[] = [];
    let buffer = '';

    for (const rawLine of sql.split('\n')) {
        const line = rawLine.trim();
        if (line === '' || line.startsWith('--') || /^GO\b/i.test(line)) {
            if (buffer) { out.push(buffer); buffer = ''; }
            out.push(line);
            continue;
        }
        buffer = buffer ? `${buffer} ${line}` : line;
        if (line.endsWith(';')) { out.push(buffer); buffer = ''; }
    }
    if (buffer) out.push(buffer);

    return out.join('\n').replace(/[ \t]{2,}/g, ' ');
}

describe('formatter examples — formatting unformatted input', () => {
    for (const exampleCase of exampleCases) {
        let parsed: ParsedExample;
        let styleOptions: SqlPromptStyleJson;
        try {
            parsed = parseExampleFile(path.dirname(exampleCase.filePath), exampleCase.fileName);
            styleOptions = JSON.parse(fs.readFileSync(parsed.configPath, 'utf8')) as SqlPromptStyleJson;
        } catch {
            continue;
        }

        it(`${exampleCase.group}/${exampleCase.fileName} — rebuilt from joined lines`, () => {
            assert.equal(formatSql(joinStatementLines(parsed.query), styleOptions), parsed.query);
        });

        it(`${exampleCase.group}/${exampleCase.fileName} — converges after two passes`, () => {
            const once = formatSql(joinStatementLines(parsed.query), styleOptions);
            assert.equal(formatSql(once, styleOptions), once);
        });
    }
});
