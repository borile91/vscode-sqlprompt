// Genera i casi "una opzione per volta" dallo schema dell'editor degli stili.
// Per ogni sezione: inputs/<sezione>.sql (SQL di anteprima) e il caso <sezione>__default;
// per ogni opzione e ogni valore diverso dal default: styles/<sezione>__<chiave>=<valore>.json,
// con lo stile predefinito più quell'opzione e le sue condizioni (enabledWhen, appliesWhen).
// Con condizioni c'è anche il caso <sezione>__<chiave>=default (solo le condizioni), da confrontare.
// cases.txt: "caso sezione caso-di-confronto", una riga per caso.
// Uso: node tools/redgate-oracle/options-cases.mjs <cartella-uscita>   (client compilato)
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const schema = require(path.join(root, 'client/out/formatter/styleSchema.js'));

const out = path.resolve(process.argv[2] ?? path.join(root, 'formatter-engine/tests/options'));

// valore di prova per i numeri: abbastanza lontano dal default da cambiare l'anteprima
const INT_SAMPLES = {
    'whitespace.numberOfSpacesInTabs': 2,
    'whitespace.wrapLinesLongerThan': 60,
    'whitespace.newLines.emptyLinesBetweenStatements': 2,
    'whitespace.newLines.emptyLinesAfterBatchSeparator': 2,
    'dml.clauses.clauseIndentation': 4,
};
const intSample = o => INT_SAMPLES[o.key] ?? (o.key.endsWith('ShorterThan') ? 30 : o.default + 1);

function variants(o) {
    if (o.type === 'bool') return [!o.default];
    if (o.type === 'int') return [intSample(o)];
    return o.choices.map(c => c.value).filter(v => v !== o.default);
}

const caseName = (section, key, value) => `${section}__${key}=${value}`;

fs.rmSync(path.join(out, 'inputs'), { recursive: true, force: true });
fs.rmSync(path.join(out, 'styles'), { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'inputs'), { recursive: true });
fs.mkdirSync(path.join(out, 'styles'), { recursive: true });

const cases = [];
const write = (name, section, values, base) => {
    const style = schema.applyValues({ metadata: { name } }, values);
    fs.writeFileSync(path.join(out, 'styles', name + '.json'), JSON.stringify(style, null, 2) + '\n');
    cases.push(`${name} ${section} ${base}`);
};

for (const section of schema.STYLE_SECTIONS) {
    fs.writeFileSync(path.join(out, 'inputs', section.id + '.sql'), section.preview + '\n');
    const sectionDefault = `${section.id}__default`;
    write(sectionDefault, section.id, {}, sectionDefault);
    for (const group of section.groups) {
        for (const o of group.options) {
            const conditions = { ...o.appliesWhen };
            if (o.enabledWhen) conditions[o.enabledWhen] = true;
            let base = sectionDefault;
            if (Object.keys(conditions).length) {
                base = caseName(section.id, o.key, 'default');
                write(base, section.id, conditions, base);
            }
            for (const v of variants(o)) write(caseName(section.id, o.key, v), section.id, { ...conditions, [o.key]: v }, base);
        }
    }
}

// elenco dei casi
fs.writeFileSync(path.join(out, 'cases.txt'), cases.join('\n') + '\n');
console.log(`${cases.length} casi in ${out}`);
