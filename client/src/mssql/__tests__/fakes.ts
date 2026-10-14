/** Finti oggetti API mssql per i test dei backend (niente `vscode`). */

import { Event, SharedConnectionsApi } from '../mssqlApi.js';
import { TokenSource } from '../sharedConnectionsBackend.js';

/** Errore come `ConnectionSharingError` di mssql: conta solo `code`. */
export function mssqlError(code: string): Error & { code: string } {
    return Object.assign(new Error(`mssql error ${code}`), { code });
}

/** Evento manuale. */
export function fakeEvent(): { event: Event<void>; fire(): void; listenerCount(): number } {
    const listeners = new Set<(e: void) => unknown>();
    return {
        event: (listener) => {
            listeners.add(listener);
            return { dispose: () => listeners.delete(listener) };
        },
        fire: () => listeners.forEach((l) => l(undefined)),
        listenerCount: () => listeners.size,
    };
}

/**
 * Provider di token finto: ogni richiesta concessa emette un token nuovo,
 * valido per l'API finta collegata. `granted` dice se il consenso c'è già;
 * `acceptPrompt` cosa risponde l'utente al prompt.
 */
export function fakeTokenSource(options: { granted?: boolean; acceptPrompt?: boolean } = {}) {
    const state = {
        granted: options.granted ?? true,
        acceptPrompt: options.acceptPrompt ?? true,
        issued: 0,
        requests: [] as Array<'silent' | 'prompt'>,
        valid: new Set<string>(),
    };
    const source: TokenSource = {
        async getAccessToken(mode) {
            state.requests.push(mode);
            if (!state.granted) {
                if (mode === 'silent') {
                    return undefined;
                }
                if (!state.acceptPrompt) {
                    throw new Error('User did not consent to login.');
                }
                state.granted = true;
            }
            const token = `t${++state.issued}`;
            state.valid.add(token);
            return token;
        },
    };
    return { source, state };
}

/** API `ISharedConnectionsService` finta, con token e connessioni verificati come in mssql. */
export function fakeSharedApi(validTokens: Set<string>) {
    const changed = fakeEvent();
    const state = {
        activeConnectionId: 'conn-A' as string | undefined,
        activeDatabase: 'DbOne' as string | undefined,
        savedDatabase: 'SavedDb' as string | undefined,
        connectCount: 0,
        open: new Set<string>(),
        calls: [] as string[],
        /** Risposte di `executeSimpleQuery` (per URI) o errori da lanciare una volta. */
        failNextQuery: [] as Error[],
        queries: [] as Array<{ token: string; uri: string; sql: string }>,
        disconnected: [] as string[],
    };
    const check = (token: string) => {
        if (!validTokens.has(token)) {
            throw mssqlError('INVALID_ACCESS_TOKEN');
        }
    };
    const api: SharedConnectionsApi = {
        authenticationProviderId: 'mssql-shared-connections',
        async getActiveEditorConnectionId(token) {
            state.calls.push('getActiveEditorConnectionId');
            check(token);
            return state.activeConnectionId;
        },
        async getActiveDatabase(token) {
            state.calls.push('getActiveDatabase');
            check(token);
            return state.activeDatabase;
        },
        async getDatabaseForConnectionId(token) {
            state.calls.push('getDatabaseForConnectionId');
            check(token);
            return state.savedDatabase;
        },
        async connect(token, connectionId, database) {
            state.calls.push(`connect:${connectionId}|${database ?? ''}`);
            check(token);
            const uri = `uri-${++state.connectCount}`;
            state.open.add(uri);
            return uri;
        },
        async disconnect(token, uri) {
            check(token);
            state.disconnected.push(uri);
            state.open.delete(uri);
        },
        async isConnected(token, uri) {
            state.calls.push(`isConnected:${uri}`);
            check(token);
            return state.open.has(uri);
        },
        async executeSimpleQuery(token, uri, sql) {
            check(token);
            const failure = state.failNextQuery.shift();
            if (failure) {
                throw failure;
            }
            if (!state.open.has(uri)) {
                throw mssqlError('INVALID_CONNECTION_URI');
            }
            state.queries.push({ token, uri, sql });
            return { rowCount: 0, columnInfo: [], rows: [] };
        },
        async listDatabases(token, uri) {
            check(token);
            if (!state.open.has(uri)) {
                throw mssqlError('INVALID_CONNECTION_URI');
            }
            return ['master', 'DbOne'];
        },
        onDidChangeActiveEditorConnection: changed.event,
    };
    return { api, state, changed };
}
