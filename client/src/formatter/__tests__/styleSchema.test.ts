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
