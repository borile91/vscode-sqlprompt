import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
    ALL_OPTIONS,
    STYLE_SECTIONS,
    applyValues,
    coerceValue,
    effectiveValue,
    effectiveValues,
    findOption,
    styleFileName,
} from '../styleSchema';

describe('styleSchema: definizione', () => {
    it('ogni chiave compare una sola volta', () => {
        const keys = ALL_OPTIONS.map(o => o.key);
        assert.equal(new Set(keys).size, keys.length);
    });

    it('i default sono valori ammessi', () => {
        for (const o of ALL_OPTIONS) {
            if (o.type === 'enum') assert.ok(o.choices.some(c => c.value === o.default), o.key);
            if (o.type === 'int') assert.ok(o.default >= o.min && o.default <= o.max, o.key);
        }
    });

    it('le dipendenze puntano a opzioni booleane esistenti', () => {
        for (const o of ALL_OPTIONS.filter(x => x.enabledWhen)) {
            assert.equal(findOption(o.enabledWhen!)?.type, 'bool', o.key);
        }
    });

    it('ogni sezione ha un SQL di anteprima', () => {
        for (const s of STYLE_SECTIONS) assert.ok(s.preview.trim().length > 0, s.id);
    });
});

describe('styleSchema: lettura dei valori', () => {
    it('una chiave assente prende il default', () => {
        assert.equal(effectiveValue({}, findOption('lists.placeCommasBeforeItems')!), false);
        assert.equal(effectiveValue({}, findOption('whitespace.wrapLinesLongerThan')!), 120);
    });

    it('i valori enum non distinguono le maiuscole, come SQL Prompt', () => {
        const style = { casing: { reservedKeywords: 'UPPERCASE' } };
        assert.equal(effectiveValue(style, findOption('casing.reservedKeywords')!), 'uppercase');
    });

    it('un valore non valido prende il default', () => {
        const style = { lists: { commaAlignment: 'boh' }, whitespace: { wrapLongLines: 'si' } };
        assert.equal(effectiveValue(style, findOption('lists.commaAlignment')!), 'beforeItem');
        assert.equal(effectiveValue(style, findOption('whitespace.wrapLongLines')!), true);
    });
});

describe('styleSchema: valori dall\'interfaccia', () => {
    it('i numeri sono limitati all\'intervallo ammesso', () => {
        const o = findOption('whitespace.numberOfSpacesInTabs')!;
        assert.equal(coerceValue(o, 40), 16);
        assert.equal(coerceValue(o, '2'), 2);
        assert.equal(coerceValue(o, 2.5), undefined);
    });

    it('un valore enum sconosciuto viene rifiutato', () => {
        assert.equal(coerceValue(findOption('lists.commaAlignment')!, 'altro'), undefined);
    });
});

describe('styleSchema: salvataggio come SQL Prompt', () => {
    const original = {
        metadata: { id: 'abc', name: 'Prova' },
        lists: { placeCommasBeforeItems: true, alignComments: true },
        futuro: { opzione: 1 },
    };

    it('un valore uguale al default viene tolto, con la sezione rimasta vuota', () => {
        const result = applyValues(original, { 'lists.placeCommasBeforeItems': false, 'lists.alignComments': false });
        assert.deepEqual(result, { metadata: { id: 'abc', name: 'Prova' }, futuro: { opzione: 1 } });
    });

    it('un valore diverso dal default viene scritto nel suo percorso', () => {
        const result = applyValues(original, { 'joinStatements.on.conditionAlignment': 'toInner' });
        assert.deepEqual((result as any).joinStatements, { on: { conditionAlignment: 'toInner' } });
    });

    it('metadati e chiavi sconosciute restano, l\'originale non cambia', () => {
        const copy = JSON.parse(JSON.stringify(original));
        const result = applyValues(original, { 'casing.reservedKeywords': 'uppercase' });
        assert.deepEqual(original, copy);
        assert.deepEqual((result as any).futuro, { opzione: 1 });
        assert.deepEqual((result as any).metadata, { id: 'abc', name: 'Prova' });
    });

    it('gli stili del corpus rimangono identici dopo lettura e riscrittura', () => {
        const dir = path.resolve(__dirname, '../../../../formatter-engine/tests/corpus/styles');
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        assert.ok(files.length > 0);
        for (const f of files) {
            const style = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            const rewritten = applyValues(style, effectiveValues(style));
            assert.deepEqual(effectiveValues(rewritten), effectiveValues(style), f);
            // le opzioni conosciute restano solo se diverse dal default
            for (const o of ALL_OPTIONS) {
                const v = effectiveValues(style)[o.key];
                const present = o.key.split('.').reduce<any>((cur, p) => cur?.[p], rewritten) !== undefined;
                assert.equal(present, v !== o.default, `${f}: ${o.key}`);
            }
        }
    });
});

describe('styleSchema: nome del file', () => {
    it('i caratteri non validi diventano _', () => {
        assert.equal(styleFileName('Stile: prova/2'), 'Stile_ prova_2.json');
        assert.equal(styleFileName('   '), 'Style.json');
    });
});

// Casi "una opzione per volta" generati con tools/redgate-oracle/build-options.sh (output della CLI di SQL Prompt)

// Casi in cui l'opzione non cambia l'anteprima nemmeno per la CLI: manca ancora l'esempio
// o la condizione che la rende visibile (da indagare)
const KNOWN_INVISIBLE = new Set<string>([
    'whitespace__whitespace.newLines.preserveExistingEmptyLinesAfterBatchSeparator=false',
    'whitespace__whitespace.newLines.emptyLinesAfterBatchSeparator=2',
    'whitespace__whitespace.newLines.alignGroupOfSingleLineComments=false',
    'lists__lists.indentListItems=false',
    'lists__lists.addSpaceAfterComma=false',
    'parentheses__parentheses.addSpacesAroundParentheses=false',
    'dml__dml.clauses.clauseAlignment=toFirstListItem',
    'ddl__ddl.indentParenthesesContents=true',
    'ddl__ddl.placeConstraintColumnsOnNewLines=ifLongerOrMultipleColumns',
    'ddl__ddl.indentClauses=true',
    'ddl__ddl.placeFirstProcedureParameterOnNewLine=always',
    'ddl__ddl.collapseShortStatements=true',
    'ddl__ddl.collapseStatementsShorterThan=30',
    'joins__joinStatements.join.keywordAlignment=rightAlignedToFrom',
    'joins__joinStatements.join.indentJoinTable=false',
    'joins__joinStatements.on.conditionAlignment=toInner',
    'insert__insertStatements.values.placeSubsequentValuesOnNewLines=ifLongerThanMaxLineLength',
    'functions__functionCalls.addSpaceAfterFunctionCalls=true',
    'operators__operators.in.alignment=indented',
    'operators__operators.in.alignment=rightAligned',
    'operators__operators.in.placeFirstValueOnNewLine=always',
    'operators__operators.arithmetic.addSpacesAround=false',
    'restore__restoreStatements.moveTo.toKeywordAlignment=toMove',
]);

describe('styleSchema: ogni opzione si vede nell\'anteprima', () => {
    const dir = path.resolve(__dirname, '../../../../formatter-engine/tests/options');
    const lines = fs.readFileSync(path.join(dir, 'cases.txt'), 'utf8').split('\n').filter(Boolean).map(l => l.split(' '));
    const cases = lines.map(l => l[0]);
    const expected = (name: string) => fs.readFileSync(path.join(dir, 'expected', name + '.sql'), 'utf8').replace(/\r\n/g, '\n');
    const variants = STYLE_SECTIONS.flatMap(s => s.groups.flatMap(g => g.options.flatMap(o => {
        const values = o.type === 'bool' ? [!o.default] : o.type === 'enum' ? o.choices.map(c => c.value).filter(v => v !== o.default) : [undefined];
        return values.map(v => ({ section: s.id, option: o, value: v }));
    })));

    it('i casi generati coprono tutte le opzioni dello schema', () => {
        for (const v of variants) {
            const prefix = `${v.section}__${v.option.key}=`;
            const found = v.value === undefined ? cases.some(c => c.startsWith(prefix)) : cases.includes(prefix + v.value);
            assert.ok(found, `manca il caso ${prefix}${v.value ?? '<numero>'}: rigenerare con build-options.sh`);
        }
    });

    it('la CLI ha formattato l\'esempio di ogni sezione (SQL analizzabile)', () => {
        for (const s of STYLE_SECTIONS) {
            const input = fs.readFileSync(path.join(dir, 'inputs', s.id + '.sql'), 'utf8').replace(/\r\n/g, '\n');
            assert.notEqual(expected(`${s.id}__default`).trimEnd(), input.trimEnd(), s.id);
        }
    });

    it('cambiare un\'opzione cambia l\'SQL di anteprima della sua sezione', () => {
        // ogni caso ha il suo caso di confronto: lo stile predefinito, più le condizioni dell'opzione
        const unchanged = lines.filter(([name, , base]) => name !== base && expected(name) === expected(base)).map(l => l[0]);
        assert.deepEqual(unchanged.filter(n => !KNOWN_INVISIBLE.has(n)), []);
        // un'eccezione che ora si vede va tolta dall'elenco
        assert.deepEqual([...KNOWN_INVISIBLE].filter(n => !unchanged.includes(n)), []);
    });
});
