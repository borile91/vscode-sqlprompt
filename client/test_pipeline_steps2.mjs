import { format } from 'sql-formatter';
import { mapToFormatterOptions } from './out/formatter/formatOptionsMapper.js';
import { applySetLineJoining, applyKeywordRePadding } from './out/formatter/keywordPaddingFormatter.js';
import * as fs from 'node:fs';

const configPath = './src/formatter/__tests__/examples/1_Vertical/config.json';
const options = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const text = fs.readFileSync('/tmp/orig_example7_vertical.sql', 'utf8').trimEnd().replace(/\r\n/g, '\n');
const useTabular = options.joinStatements?.join?.keywordAlignment === 'toTable' && options.lists?.placeCommasBeforeItems === true;

let formatted = format(text, mapToFormatterOptions(options));
formatted = applySetLineJoining(formatted);
formatted = formatted.replace(/^([ \t]*GO\b)[ \t]+(?=[^\s\n])/gim, '$1\n\n');
formatted = applyKeywordRePadding(formatted, useTabular);

// Show ALL lines
console.log('=== FULL AFTER applyKeywordRePadding ===');
formatted.split('\n').forEach((line, i) => console.log(`${i+1}: ${JSON.stringify(line)}`));
