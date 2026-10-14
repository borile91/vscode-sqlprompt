import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SHORTCUTS,
  isTypingTopN,
  resolveShortcuts,
  shortcutsFor,
  shouldRetrigger,
  toSnippetText,
} from '../statementShortcuts.js';

describe('resolveShortcuts', () => {
  it('senza impostazioni restituisce quelle predefinite', () => {
    assert.deepEqual(Object.fromEntries(resolveShortcuts(undefined)), DEFAULT_SHORTCUTS);
  });

  it('aggiunge, ridefinisce e (con stringa vuota) toglie', () => {
    const map = resolveShortcuts({ SD: 'SELECT DISTINCT ', ssf: 'SELECT *\nFROM ', av: '' });
    assert.equal(map.get('sd'), 'SELECT DISTINCT ');
    assert.equal(map.get('ssf'), 'SELECT *\nFROM ');
    assert.equal(map.has('av'), false);
  });

  it('scarta sigle non valide e valori non testuali', () => {
    const map = resolveShortcuts({ 'a b': 'X', ok: 1, '': 'Y' });
    assert.deepEqual(Object.fromEntries(map), DEFAULT_SHORTCUTS);
    assert.deepEqual(Object.fromEntries(resolveShortcuts(['x'])), DEFAULT_SHORTCUTS);
  });
});

describe('shortcutsFor', () => {
  const defaults = resolveShortcuts(undefined);

  it('st<N> diventa SELECT TOP N', () => {
    const st25 = shortcutsFor('st25', defaults).find((s) => s.label === 'st25');
    assert.equal(st25?.text, 'SELECT TOP 25 * FROM ');
    assert.equal(shortcutsFor('ST7', defaults).find((s) => s.label === 'st7')?.text, 'SELECT TOP 7 * FROM ');
  });

  it('una scorciatoia già definita vince su st<N>', () => {
    const custom = resolveShortcuts({ st5: 'SELECT TOP (5) * FROM ' });
    const st5 = shortcutsFor('st5', custom).filter((s) => s.label === 'st5');
    assert.deepEqual(st5.map((s) => s.text), ['SELECT TOP (5) * FROM ']);
  });

  it('isTypingTopN riconosce st e st seguito da cifre', () => {
    assert.equal(isTypingTopN('st'), true);
    assert.equal(isTypingTopN('st1'), true);
    assert.equal(isTypingTopN('ssf'), false);
  });
});

describe('toSnippetText e shouldRetrigger', () => {
  it('$CURSOR$ diventa $0 e i $ letterali sono protetti', () => {
    assert.equal(toSnippetText('BEGIN TRAN;\n$CURSOR$\nROLLBACK;'), 'BEGIN TRAN;\n$0\nROLLBACK;');
    assert.equal(toSnippetText('OUTPUT $action }'), 'OUTPUT \\$action \\}');
  });

  it('riapre i suggerimenti solo se il testo finisce con uno spazio e senza $CURSOR$', () => {
    assert.equal(shouldRetrigger('SELECT * FROM '), true);
    assert.equal(shouldRetrigger('SELECT 1'), false);
    assert.equal(shouldRetrigger('BEGIN $CURSOR$ END '), false);
  });
});
