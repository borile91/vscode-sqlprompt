import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMode, planSuggestions, SuggestionsState } from '../mssqlSuggestions.js';

const state = (overrides: Partial<SuggestionsState> = {}): SuggestionsState => ({
    globalValue: undefined,
    workspaceValue: undefined,
    ownGlobal: false,
    ownWorkspace: false,
    ...overrides,
});

describe('normalizeMode', () => {
    it('default user, e compatibilità con i vecchi booleani', () => {
        assert.equal(normalizeMode(undefined), 'user');
        assert.equal(normalizeMode(true), 'user');
        assert.equal(normalizeMode(false), 'off');
        assert.equal(normalizeMode('workspace'), 'workspace');
        assert.equal(normalizeMode('off'), 'off');
    });
});

describe('planSuggestions', () => {
    it('user: scrive una volta nelle impostazioni utente, poi non tocca più nulla', () => {
        assert.deepEqual(planSuggestions('user', state()), { global: false });
        assert.deepEqual(planSuggestions('user', state({ globalValue: false, ownGlobal: true })), {});
    });

    it('user: toglie il valore lasciato nel workspace dalle versioni precedenti', () => {
        assert.deepEqual(planSuggestions('user', state({ workspaceValue: false })), {
            global: false,
            workspace: null,
        });
    });

    it('workspace: scrive nel workspace e toglie il valore utente solo se è nostro', () => {
        assert.deepEqual(planSuggestions('workspace', state({ globalValue: false, ownGlobal: true })), {
            global: null,
            workspace: false,
        });
        assert.deepEqual(planSuggestions('workspace', state({ globalValue: false })), { workspace: false });
    });

    it('off: toglie solo ciò che ha scritto SQL Prompt', () => {
        assert.deepEqual(
            planSuggestions('off', state({ globalValue: false, ownGlobal: true, workspaceValue: false })),
            { global: null, workspace: null },
        );
        assert.deepEqual(planSuggestions('off', state({ globalValue: false })), {});
    });

    it('non tocca un valore true scelto dall\'utente se la modalità è off', () => {
        assert.deepEqual(planSuggestions('off', state({ globalValue: true, workspaceValue: true })), {});
    });
});
