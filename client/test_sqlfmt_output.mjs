import { format } from 'sql-formatter';
import { mapToFormatterOptions } from './out/formatter/formatOptionsMapper.js';
import * as fs from 'node:fs';

const configPath = './src/formatter/__tests__/examples/1_Vertical/config.json';
const options = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const fmtOpts = mapToFormatterOptions(options);

const text = fs.readFileSync('/tmp/orig_example7_vertical.sql', 'utf8').trimEnd().replace(/\r\n/g, '\n');
const result = format(text, fmtOpts);
console.log(result);
