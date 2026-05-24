import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { formatSql } from '../formatter.js';
import type { FormatterConfig } from '../formatter.js';

const examplesDir = path.join(__dirname, '..', '..', 'examples');
const inputSql = fs.readFileSync(path.join(examplesDir, 'input.sql'), 'utf-8').trim();

const styles = fs
    .readdirSync(examplesDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();

describe('SQL formatter examples', () => {
    for (const style of styles) {
        it(`style "${style}" produces expected output`, () => {
            const configPath = path.join(examplesDir, style, 'config.json');
            const outputPath = path.join(examplesDir, style, 'output.sql');

            const config = JSON.parse(
                fs.readFileSync(configPath, 'utf-8'),
            ) as Partial<FormatterConfig>;

            const expected = fs
                .readFileSync(outputPath, 'utf-8')
                .replace(/\r\n/g, '\n')
                .trimEnd();

            const actual = formatSql(inputSql, config);
            assert.equal(actual, expected);
        });
    }
});
