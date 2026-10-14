import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SchemaAccessDeps, selectSchemaAccess } from '../connectionProvider.js';
import { LegacyConnectionSharingApi, MssqlExtensionApi } from '../mssqlApi.js';
import { fakeEvent, fakeSharedApi, fakeTokenSource } from './fakes.js';

const EXTENSION_ID = 'borile91.vscode-sqlprompt';

function deps(overrides: Partial<SchemaAccessDeps> = {}): SchemaAccessDeps & { logs: string[]; providerIds: string[] } {
    const logs: string[] = [];
    const providerIds: string[] = [];
    return {
        logs,
        providerIds,
        extensionId: EXTENSION_ID,
        createTokenSource: (id) => {
            providerIds.push(id);
            return fakeTokenSource().source;
        },
        log: (message) => logs.push(message),
        ...overrides,
    };
}

/** `connectionSharing` finta: registra le chiamate. */
function fakeLegacy(connected: Record<string, boolean> = { 'file:///a.sql': true }) {
    const calls: string[] = [];
    const api: LegacyConnectionSharingApi = {
        isConnected: (uri) => {
            calls.push(`isConnected:${uri}`);
            return connected[uri] ?? false;
        },
        getActiveEditorConnectionId: async (id) => {
            calls.push(`getActiveEditorConnectionId:${id}`);
            return 'conn-A';
        },
        getActiveDatabase: async () => 'DbOne',
        getDatabaseForConnectionId: async () => 'SavedDb',
        executeSimpleQuery: async (uri, sql) => {
            calls.push(`query:${uri}:${sql}`);
            return { rows: [] };
        },
        listDatabases: async () => ['master'],
    };
    return { api, calls };
}

describe('selectSchemaAccess', () => {
    it('nessuna API: nessun provider e un motivo da mostrare', () => {
        const result = selectSchemaAccess(undefined, deps());
        assert.equal(result.provider, undefined);
        assert.match(result.reason!, /did not return an API/);
    });

    it('né la nuova API né connectionSharing: motivo esplicito', () => {
        const result = selectSchemaAccess({ uriOwnershipApi: {} }, deps());
        assert.equal(result.provider, undefined);
        assert.match(result.reason!, /no connection-sharing API/);
    });

    it('solo connectionSharing (mssql 1.46.0): backend legacy', () => {
        const result = selectSchemaAccess({ connectionSharing: fakeLegacy().api }, deps());
        assert.equal(result.provider?.kind, 'legacy');
    });

    it('nuova API presente: la preferisce, anche se c’è connectionSharing', () => {
        const tokens = fakeTokenSource();
        const shared = fakeSharedApi(tokens.state.valid);
        const d = deps();
        const result = selectSchemaAccess(
            { connectionSharing: fakeLegacy().api, getSharedConnectionsApi: () => shared.api },
            d,
        );
        assert.equal(result.provider?.kind, 'sharedConnections');
        assert.deepEqual(d.providerIds, ['mssql-shared-connections']);
    });

    it('versione della nuova API non supportata: ripiega su connectionSharing', () => {
        const d = deps();
        const api: MssqlExtensionApi = {
            connectionSharing: fakeLegacy().api,
            getSharedConnectionsApi: () => {
                throw new Error('Version 1 of the shared connections API isn’t available');
            },
        };
        const result = selectSchemaAccess(api, d);
        assert.equal(result.provider?.kind, 'legacy');
        assert.ok(d.logs.some((l) => l.includes('getSharedConnectionsApi(1) failed')));
    });

    it('nuova API incompleta e niente connectionSharing: nessun provider', () => {
        const api = { getSharedConnectionsApi: () => ({}) } as unknown as MssqlExtensionApi;
        const result = selectSchemaAccess(api, deps());
        assert.equal(result.provider, undefined);
    });

    it('inoltra gli eventi di ownership come cambio connessioni', () => {
        const ownership = fakeEvent();
        const result = selectSchemaAccess(
            {
                connectionSharing: fakeLegacy().api,
                uriOwnershipApi: { onDidChangeUriOwnership: ownership.event },
            },
            deps(),
        );
        let fired = 0;
        result.provider!.onDidChangeConnections!(() => fired++);
        ownership.fire();
        assert.equal(fired, 1);
        // L'API legacy non ha l'evento di cambio editor: resta il polling.
        assert.equal(result.provider!.onDidChangeActiveEditorConnection, undefined);
    });

    it('nuova API: ownsUri evita di chiedere il token per un editor non connesso', async () => {
        const tokens = fakeTokenSource();
        const shared = fakeSharedApi(tokens.state.valid);
        const owned = new Set(['file:///connected.sql']);
        const result = selectSchemaAccess(
            {
                getSharedConnectionsApi: () => shared.api,
                uriOwnershipApi: { ownsUri: (uri) => owned.has(String((uri as { s: string }).s)) },
            },
            deps({
                createTokenSource: () => tokens.source,
                parseUri: (s) => ({ s }),
            }),
        );
        const provider = result.provider!;
        assert.equal(
            await provider.getEditorConnection('file:///other.sql', { isActiveEditor: true }),
            undefined,
        );
        assert.deepEqual(tokens.state.requests, []);
        const connection = await provider.getEditorConnection('file:///connected.sql', { isActiveEditor: true });
        assert.equal(connection?.connectionId, 'conn-A');
    });
});

describe('LegacySchemaAccess', () => {
    it('editor connesso e attivo: id, database e target uguale all’URI dell’editor', async () => {
        const legacy = fakeLegacy();
        const provider = selectSchemaAccess({ connectionSharing: legacy.api }, deps()).provider!;
        const connection = await provider.getEditorConnection('file:///a.sql', { isActiveEditor: true });
        assert.deepEqual(connection, { target: 'file:///a.sql', connectionId: 'conn-A', database: 'DbOne' });
        assert.ok(legacy.calls.includes(`getActiveEditorConnectionId:${EXTENSION_ID}`));
    });

    it('editor non attivo: connesso, ma senza id né database', async () => {
        const legacy = fakeLegacy();
        const provider = selectSchemaAccess({ connectionSharing: legacy.api }, deps()).provider!;
        const connection = await provider.getEditorConnection('file:///a.sql', { isActiveEditor: false });
        assert.deepEqual(connection, { target: 'file:///a.sql', connectionId: undefined, database: undefined });
    });

    it('editor non connesso o isConnected che lancia: undefined', async () => {
        const legacy = fakeLegacy();
        const provider = selectSchemaAccess({ connectionSharing: legacy.api }, deps()).provider!;
        assert.equal(await provider.getEditorConnection('file:///b.sql', { isActiveEditor: true }), undefined);
        legacy.api.isConnected = () => {
            throw new Error('boom');
        };
        assert.equal(await provider.getEditorConnection('file:///a.sql', { isActiveEditor: true }), undefined);
    });

    it('il runner interroga direttamente l’URI dell’editor', async () => {
        const legacy = fakeLegacy();
        const provider = selectSchemaAccess({ connectionSharing: legacy.api }, deps()).provider!;
        await provider.runner.executeSimpleQuery('file:///a.sql', 'SELECT 1');
        assert.ok(legacy.calls.includes('query:file:///a.sql:SELECT 1'));
        assert.deepEqual(await provider.runner.listDatabases!('file:///a.sql'), ['master']);
    });
});
