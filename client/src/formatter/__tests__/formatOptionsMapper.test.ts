import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapToFormatterOptions } from '../formatOptionsMapper.js';
import type { SqlPromptStyleJson } from '../styleLoader.js';

describe('mapToFormatterOptions', () => {
    it('maps default tabWidth to 4', () => {
        const opts = mapToFormatterOptions({});
        assert.equal(opts.tabWidth, 4);
    });

    it('maps numberOfSpacesInTabs', () => {
        const style: SqlPromptStyleJson = { whitespace: { numberOfSpacesInTabs: 2 } };
        assert.equal(mapToFormatterOptions(style).tabWidth, 2);
    });

    it('sets useTabs when spacesOrTabs is onlyTabs', () => {
        const style: SqlPromptStyleJson = { whitespace: { spacesOrTabs: 'onlyTabs' } };
        assert.equal(mapToFormatterOptions(style).useTabs, true);
    });

    it('does not set useTabs for onlySpaces', () => {
        const style: SqlPromptStyleJson = { whitespace: { spacesOrTabs: 'onlySpaces' } };
        assert.equal(mapToFormatterOptions(style).useTabs, false);
    });

    it('maps emptyLinesBetweenStatements=1 to linesBetweenQueries=1', () => {
        const style: SqlPromptStyleJson = {
            whitespace: { newLines: { emptyLinesBetweenStatements: 1 } },
        };
        assert.equal(mapToFormatterOptions(style).linesBetweenQueries, 1);
    });

    it('maps emptyLinesBetweenStatements=0 to linesBetweenQueries=0', () => {
        const style: SqlPromptStyleJson = {
            whitespace: { newLines: { emptyLinesBetweenStatements: 0 } },
        };
        assert.equal(mapToFormatterOptions(style).linesBetweenQueries, 0);
    });

    it('defaults linesBetweenQueries to 1 when not specified', () => {
        assert.equal(mapToFormatterOptions({}).linesBetweenQueries, 1);
    });

    it('maps reservedKeywords uppercase', () => {
        const style: SqlPromptStyleJson = { casing: { reservedKeywords: 'uppercase' } };
        assert.equal(mapToFormatterOptions(style).keywordCase, 'upper');
    });

    it('maps builtInFunctions uppercase to functionCase upper', () => {
        const style: SqlPromptStyleJson = { casing: { builtInFunctions: 'uppercase' } };
        assert.equal(mapToFormatterOptions(style).functionCase, 'upper');
    });

    it('maps wrapLinesLongerThan to expressionWidth', () => {
        const style: SqlPromptStyleJson = { whitespace: { wrapLinesLongerThan: 200 } };
        assert.equal(mapToFormatterOptions(style).expressionWidth, 200);
    });

    it('sets tabularLeft indentStyle for toTable keywordAlignment with leading commas', () => {
        const style: SqlPromptStyleJson = {
            joinStatements: { join: { keywordAlignment: 'toTable' } },
            lists: { placeCommasBeforeItems: true },
        };
        assert.equal(mapToFormatterOptions(style).indentStyle, 'tabularLeft');
    });

    it('does not set tabularLeft indentStyle for toTable without leading commas', () => {
        const style: SqlPromptStyleJson = {
            joinStatements: { join: { keywordAlignment: 'toTable' } },
        };
        assert.equal(mapToFormatterOptions(style).indentStyle, undefined);
    });

    it('does not set indentStyle for toFrom keywordAlignment', () => {
        const style: SqlPromptStyleJson = {
            joinStatements: { join: { keywordAlignment: 'toFrom' } },
        };
        assert.equal(mapToFormatterOptions(style).indentStyle, undefined);
    });
});
