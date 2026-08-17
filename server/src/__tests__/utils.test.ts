import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateAlias, stripIdentifierDelimiters } from '../utils.js';

describe('generateAlias — shape of the alias', () => {
    it('takes the initial of each underscore-separated part', () => {
        assert.equal(generateAlias('PRESTITI_DETTAGLIO'), 'od');
    });

    it('takes the capitals of a CamelCase name', () => {
        assert.equal(generateAlias('ClientiAttivi'), 'ca');
    });

    it('takes the first letter of an all-uppercase name', () => {
        assert.equal(generateAlias('LIBRI'), 'a');
    });

    it('takes the first letter of an all-lowercase name', () => {
        assert.equal(generateAlias('orders'), 'o');
    });
});

describe('generateAlias — reserved words', () => {
    // `FROM dbo.OrariFestivi AS of` fails with "Incorrect syntax near the keyword
    // 'of'", so the alias is extended with what follows the last initial.
    it('extends a CamelCase alias that would be a reserved word', () => {
        assert.equal(generateAlias('OrariFestivi'), 'ofa');
    });

    it('extends an underscore alias that would be a reserved word', () => {
        assert.equal(generateAlias('ORARI_FESTIVI'), 'ofa');
        assert.equal(generateAlias('TIPO_ORARIO'), 'tor');
        assert.equal(generateAlias('IMP_SPOSTAMENTI'), 'isp');
        assert.equal(generateAlias('IMP_NOTIFICHE'), 'ino');
        assert.equal(generateAlias('AUTORI_SOSTITUTI'), 'aso');
    });

    it('extends across the "vw" prefix of a view', () => {
        assert.equal(generateAlias('vwOrariFestivi'), 'ofa');
        assert.equal(generateAlias('vwOrariRitardi'), 'ori');
    });

    it('leaves an alias that is not reserved untouched', () => {
        assert.equal(generateAlias('PRESTITI_TESTATA'), 'ot');
        assert.equal(generateAlias('OrariFestiviNote'), 'ofn');
    });

    it('never returns a reserved word, whatever the name', () => {
        const riservate = new Set(['as', 'in', 'is', 'of', 'or', 'to', 'on', 'by', 'if']);
        const nomi = [
            'OrariFestivi', 'ORARI_FESTIVI', 'TIPO_ORARIO', 'IMP_SPOSTAMENTI', 'IN_OUT',
            'AV_SCADENZE', 'AUTORI_SOSTITUTI', 'IndiceStorico', 'OrarioRighe',
            'TABELLA_ORARI', 'BY_PASS', 'IF_ELSE', 'ON_HOLD',
        ];
        for (const nome of nomi) {
            const alias = generateAlias(nome);
            assert.equal(riservate.has(alias), false, `"${nome}" → "${alias}" is reserved`);
        }
    });
});

describe('generateAlias — deduplication', () => {
    it('appends a counter when the alias is taken', () => {
        assert.equal(generateAlias('LIBRI', new Set(['a'])), 'a2');
        assert.equal(generateAlias('LIBRI', new Set(['a', 'a2'])), 'a3');
    });

    it('deduplicates the extended form, not the reserved one', () => {
        assert.equal(generateAlias('OrariFestivi', new Set(['ofa'])), 'ofa2');
    });

    it('ignores unrelated aliases', () => {
        assert.equal(generateAlias('LIBRI', new Set(['o', 'od'])), 'a');
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
