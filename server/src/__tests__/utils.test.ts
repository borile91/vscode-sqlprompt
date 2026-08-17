import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateAlias, stripIdentifierDelimiters } from '../utils.js';

describe('generateAlias — shape of the alias', () => {
    it('takes the initial of each underscore-separated part', () => {
        assert.equal(generateAlias('ORDINI_DETTAGLIO'), 'od');
    });

    it('takes the capitals of a CamelCase name', () => {
        assert.equal(generateAlias('ClientiAttivi'), 'ca');
    });

    it('takes the first letter of an all-uppercase name', () => {
        assert.equal(generateAlias('ARTICOLI'), 'a');
    });

    it('takes the first letter of an all-lowercase name', () => {
        assert.equal(generateAlias('orders'), 'o');
    });
});

describe('generateAlias — reserved words', () => {
    // `FROM dbo.OrdiniFasi AS of` fails with "Incorrect syntax near the keyword
    // 'of'", so the alias is extended with what follows the last initial.
    it('extends a CamelCase alias that would be a reserved word', () => {
        assert.equal(generateAlias('OrdiniFasi'), 'ofa');
    });

    it('extends an underscore alias that would be a reserved word', () => {
        assert.equal(generateAlias('ORDINI_FASI'), 'ofa');
        assert.equal(generateAlias('TIPO_ORDINE'), 'tor');
        assert.equal(generateAlias('IMP_SPEDIZIONI'), 'isp');
        assert.equal(generateAlias('IMP_NOMINATIVI'), 'ino');
        assert.equal(generateAlias('ARTICOLI_SOSTITUTIVI'), 'aso');
    });

    it('extends across the "vw" prefix of a view', () => {
        assert.equal(generateAlias('vwOrdiniFasi'), 'ofa');
        assert.equal(generateAlias('vwOrdiniRicambi'), 'ori');
    });

    it('leaves an alias that is not reserved untouched', () => {
        assert.equal(generateAlias('ORDINI_TESTATA'), 'ot');
        assert.equal(generateAlias('OrdiniFasiNote'), 'ofn');
    });

    it('never returns a reserved word, whatever the name', () => {
        const riservate = new Set(['as', 'in', 'is', 'of', 'or', 'to', 'on', 'by', 'if']);
        const nomi = [
            'OrdiniFasi', 'ORDINI_FASI', 'TIPO_ORDINE', 'IMP_SPEDIZIONI', 'IN_OUT',
            'AV_SCARICO', 'ARTICOLI_SOSTITUTIVI', 'InventarioStorico', 'OrdineRighe',
            'TABELLA_ORDINI', 'BY_PASS', 'IF_ELSE', 'ON_HOLD',
        ];
        for (const nome of nomi) {
            const alias = generateAlias(nome);
            assert.equal(riservate.has(alias), false, `"${nome}" → "${alias}" is reserved`);
        }
    });
});

describe('generateAlias — deduplication', () => {
    it('appends a counter when the alias is taken', () => {
        assert.equal(generateAlias('ARTICOLI', new Set(['a'])), 'a2');
        assert.equal(generateAlias('ARTICOLI', new Set(['a', 'a2'])), 'a3');
    });

    it('deduplicates the extended form, not the reserved one', () => {
        assert.equal(generateAlias('OrdiniFasi', new Set(['ofa'])), 'ofa2');
    });

    it('ignores unrelated aliases', () => {
        assert.equal(generateAlias('ARTICOLI', new Set(['o', 'od'])), 'a');
    });
});

describe('stripIdentifierDelimiters', () => {
    it('removes brackets', () => {
        assert.equal(stripIdentifierDelimiters('[My Table]'), 'My Table');
    });

    it('removes double quotes', () => {
        assert.equal(stripIdentifierDelimiters('"dbo"'), 'dbo');
    });

    it('leaves a plain identifier alone', () => {
        assert.equal(stripIdentifierDelimiters('dbo'), 'dbo');
    });
});
