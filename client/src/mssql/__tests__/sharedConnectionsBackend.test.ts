import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    AccessTokenCache,
    ConnectionPool,
    SchemaAccessNotGrantedError,
    SharedConnectionsSchemaAccess,
    SharedConnectionsDeps,
    connectionKey,
} from '../sharedConnectionsBackend.js';
import { fakeEvent, fakeSharedApi, fakeTokenSource, mssqlError } from './fakes.js';

/** Provider sulla nuova API con token e API finti collegati. */
function setup(
    options: { granted?: boolean; acceptPrompt?: boolean } & Partial<SharedConnectionsDeps> = {},
) {
    const tokens = fakeTokenSource(options);
    const mssql = fakeSharedApi(tokens.state.valid);
    let declined = 0;
    const provider = new SharedConnectionsSchemaAccess({
        api: mssql.api,
        tokens: tokens.source,
        onAccessDeclined: () => declined++,
        ...options,
    });
    return { provider, tokens, mssql, declinedCount: () => declined };
}

describe('AccessTokenCache', () => {
    it('riusa il token in cache e lo rinnova dopo la scadenza', async () => {
        const { source, state } = fakeTokenSource();
        let now = 0;
        const cache = new AccessTokenCache(source, { now: () => now, refreshAfterMs: 1000 });

        assert.equal(await cache.get('auto'), 't1');
        assert.equal(await cache.get('auto'), 't1');
        assert.equal(state.requests.length, 1);

        now = 1000;
        assert.equal(await cache.get('auto'), 't2');
        assert.deepEqual(state.requests, ['silent', 'silent']);
    });

    it('silent non mostra mai il prompt', async () => {
        const { source, state } = fakeTokenSource({ granted: false });
        const cache = new AccessTokenCache(source);
        assert.equal(await cache.get('silent'), undefined);
        assert.deepEqual(state.requests, ['silent']);
    });

    it('auto chiede il consenso finché non viene rifiutato, explicit anche dopo', async () => {
        const { source, state } = fakeTokenSource({ granted: false, acceptPrompt: false });
        let declined = 0;
        const cache = new AccessTokenCache(source, { onDeclined: () => declined++ });

        assert.equal(await cache.get('auto'), undefined);
        assert.equal(cache.declined, true);
        assert.equal(declined, 1);

        // Nessun nuovo prompt ad ogni sincronizzazione automatica.
        assert.equal(await cache.get('auto'), undefined);
        assert.equal(state.requests.filter((r) => r === 'prompt').length, 1);
        assert.equal(declined, 1);

        // Un comando dell'utente lo ripropone; questa volta accetta.
        state.acceptPrompt = true;
        assert.equal(await cache.get('explicit'), 't1');
        assert.equal(cache.declined, false);
        assert.equal(state.requests.filter((r) => r === 'prompt').length, 2);
    });

    it('accesso concesso altrove dopo un rifiuto: il token silenzioso torna a funzionare', async () => {
        const { source, state } = fakeTokenSource({ granted: false, acceptPrompt: false });
        const cache = new AccessTokenCache(source);
        assert.equal(await cache.get('auto'), undefined);
        state.granted = true;
        assert.equal(await cache.get('auto'), 't1');
        assert.equal(cache.declined, false);
    });

    it('le richieste contemporanee condividono la stessa chiamata', async () => {
        const { source, state } = fakeTokenSource({ granted: false });
        const cache = new AccessTokenCache(source);
        const results = await Promise.all([cache.get('auto'), cache.get('auto'), cache.get('auto')]);
        assert.deepEqual(results, ['t1', 't1', 't1']);
        assert.deepEqual(state.requests, ['silent', 'prompt']);
    });

    it('invalidate scarta solo il token rifiutato', async () => {
        const { source } = fakeTokenSource();
        const cache = new AccessTokenCache(source);
        assert.equal(await cache.get('silent'), 't1');
        cache.invalidate('altro');
        assert.equal(await cache.get('silent'), 't1');
        cache.invalidate('t1');
        assert.equal(await cache.get('silent'), 't2');
    });
});

describe('ConnectionPool', () => {
    function pool(maxSize = 4) {
        const valid = new Set(['tok']);
        const mssql = fakeSharedApi(valid);
        return { pool: new ConnectionPool(mssql.api, maxSize), mssql };
    }

    it('riusa la connessione per connectionId|database (database case-insensitive)', async () => {
        const { pool: p, mssql } = pool();
        const a = await p.acquire('tok', 'conn-A', 'DbOne');
        const b = await p.acquire('tok', 'conn-A', 'dbone');
        assert.equal(a, b);
        assert.equal(mssql.state.connectCount, 1);
        assert.equal(connectionKey('conn-A', 'DbOne'), connectionKey('conn-A', 'DBONE'));
    });

    it('apre connessioni distinte per database o profilo diversi', async () => {
        const { pool: p, mssql } = pool();
        const a = await p.acquire('tok', 'conn-A', 'DbOne');
        const b = await p.acquire('tok', 'conn-A', 'DbTwo');
        const c = await p.acquire('tok', 'conn-B', 'DbOne');
        assert.equal(new Set([a, b, c]).size, 3);
        assert.equal(mssql.state.connectCount, 3);
        assert.ok(mssql.state.calls.includes('connect:conn-A|DbTwo'));
    });

    it('riconnette se mssql non dà più la connessione per connessa', async () => {
        const { pool: p, mssql } = pool();
        const first = await p.acquire('tok', 'conn-A', 'DbOne');
        mssql.state.open.delete(first);
        const second = await p.acquire('tok', 'conn-A', 'DbOne');
        assert.notEqual(first, second);
        assert.equal(mssql.state.connectCount, 2);
    });

    it('due richieste contemporanee aspettano la stessa connect', async () => {
        const { pool: p, mssql } = pool();
        const [a, b] = await Promise.all([
            p.acquire('tok', 'conn-A', 'DbOne'),
            p.acquire('tok', 'conn-A', 'DbOne'),
        ]);
        assert.equal(a, b);
        assert.equal(mssql.state.connectCount, 1);
    });

    it('una connect fallita non resta in cache', async () => {
        const { pool: p, mssql } = pool();
        const connect = mssql.api.connect;
        mssql.api.connect = async () => {
            throw mssqlError('CONNECTION_FAILED');
        };
        await assert.rejects(p.acquire('tok', 'conn-A', 'DbOne'), /CONNECTION_FAILED/);
        mssql.api.connect = connect;
        assert.equal(await p.acquire('tok', 'conn-A', 'DbOne'), 'uri-1');
    });

    it('oltre la dimensione massima chiude la connessione usata meno di recente', async () => {
        const { pool: p, mssql } = pool(2);
        const a = await p.acquire('tok', 'conn-A', 'One');
        await p.acquire('tok', 'conn-A', 'Two');
        await p.acquire('tok', 'conn-A', 'One'); // "One" torna la più recente
        await p.acquire('tok', 'conn-A', 'Three');
        await new Promise((r) => setImmediate(r));
        assert.equal(p.openCount, 2);
        assert.deepEqual(mssql.state.disconnected, ['uri-2']);
        assert.equal(await p.acquire('tok', 'conn-A', 'One'), a);
    });

    it('disconnectAll chiude tutte le connessioni aperte', async () => {
        const { pool: p, mssql } = pool();
        await p.acquire('tok', 'conn-A', 'One');
        await p.acquire('tok', 'conn-A', 'Two');
        await p.disconnectAll('tok');
        assert.deepEqual(mssql.state.disconnected.sort(), ['uri-1', 'uri-2']);
        assert.equal(p.openCount, 0);
    });
});

describe('SharedConnectionsSchemaAccess', () => {
    it('restituisce connessione, database e un target per le query', async () => {
        const { provider } = setup();
        const connection = await provider.getEditorConnection('file:///a.sql', { isActiveEditor: true });
        assert.equal(connection?.connectionId, 'conn-A');
        assert.equal(connection?.database, 'DbOne');
        assert.ok(connection?.target);
        assert.notEqual(connection?.target, 'file:///a.sql');
    });

    it('senza database attivo usa quello del profilo salvato', async () => {
        const { provider, mssql } = setup();
        mssql.state.activeDatabase = undefined;
        const connection = await provider.getEditorConnection('file:///a.sql', { isActiveEditor: true });
        assert.equal(connection?.database, 'SavedDb');
    });

    it('editor non attivo o non posseduto da mssql: nessun token richiesto', async () => {
        const { provider, tokens } = setup({ ownsEditor: () => false });
        assert.equal(await provider.getEditorConnection('file:///a.sql', { isActiveEditor: false }), undefined);
        assert.equal(await provider.getEditorConnection('file:///a.sql', { isActiveEditor: true }), undefined);
        assert.deepEqual(tokens.state.requests, []);
    });

    it('editor attivo non connesso: undefined', async () => {
        const { provider, mssql } = setup();
        mssql.state.activeConnectionId = undefined;
        assert.equal(await provider.getEditorConnection('file:///a.sql', { isActiveEditor: true }), undefined);
    });

    it('le query vanno su una connessione propria, riusata', async () => {
        const { provider, mssql } = setup();
        const { target } = (await provider.getEditorConnection('file:///a.sql', { isActiveEditor: true }))!;
        await provider.runner.executeSimpleQuery(target, 'SELECT 1');
        await provider.runner.executeSimpleQuery(target, 'SELECT 2');
        assert.equal(mssql.state.connectCount, 1);
        assert.deepEqual(
            mssql.state.queries.map((q) => [q.uri, q.sql]),
            [['uri-1', 'SELECT 1'], ['uri-1', 'SELECT 2']],
        );
        assert.ok(mssql.state.calls.includes('connect:conn-A|DbOne'));
        assert.deepEqual(await provider.runner.listDatabases!(target), ['master', 'DbOne']);
    });

    it('token scaduto: ne chiede uno nuovo e riprova una volta', async () => {
        const { provider, tokens, mssql } = setup();
        const { target } = (await provider.getEditorConnection('file:///a.sql', { isActiveEditor: true }))!;
        await provider.runner.executeSimpleQuery(target, 'SELECT 1');

        tokens.state.valid.delete('t1'); // scaduto lato mssql
        await provider.runner.executeSimpleQuery(target, 'SELECT 2');
        assert.equal(mssql.state.queries.at(-1)?.token, 't2');
        // Stessa sessione: la connessione resta valida, nessuna riconnessione.
        assert.equal(mssql.state.connectCount, 1);
    });

    it('token rifiutato due volte: l’errore arriva al chiamante', async () => {
        const { provider, mssql } = setup();
        const { target } = (await provider.getEditorConnection('file:///a.sql', { isActiveEditor: true }))!;
        mssql.state.failNextQuery.push(mssqlError('INVALID_ACCESS_TOKEN'), mssqlError('INVALID_ACCESS_TOKEN'));
        await assert.rejects(provider.runner.executeSimpleQuery(target, 'SELECT 1'), /INVALID_ACCESS_TOKEN/);
    });

    it('connessione rifiutata da mssql: riconnette e riprova una volta', async () => {
        const { provider, mssql } = setup();
        const { target } = (await provider.getEditorConnection('file:///a.sql', { isActiveEditor: true }))!;
        await provider.runner.executeSimpleQuery(target, 'SELECT 1');
        mssql.state.failNextQuery.push(mssqlError('NO_ACTIVE_CONNECTION'));
        await provider.runner.executeSimpleQuery(target, 'SELECT 2');
        assert.equal(mssql.state.connectCount, 2);
        assert.equal(mssql.state.queries.at(-1)?.uri, 'uri-2');
    });

    it('errori SQL non vengono ripetuti', async () => {
        const { provider, mssql } = setup();
        const { target } = (await provider.getEditorConnection('file:///a.sql', { isActiveEditor: true }))!;
        mssql.state.failNextQuery.push(Object.assign(new Error('Invalid object name'), { number: 208 }));
        await assert.rejects(provider.runner.executeSimpleQuery(target, 'SELECT 1'), /Invalid object name/);
        assert.equal(mssql.state.queries.length, 0);
    });

    it('target sconosciuto: errore esplicito', async () => {
        const { provider } = setup();
        await assert.rejects(provider.runner.executeSimpleQuery('file:///a.sql', 'SELECT 1'), /unknown shared connection target/);
    });

    it('consenso rifiutato: nessuna connessione, un solo avviso, query senza prompt', async () => {
        const { provider, tokens, declinedCount } = setup({ granted: false, acceptPrompt: false });
        assert.equal(await provider.getEditorConnection('file:///a.sql', { isActiveEditor: true }), undefined);
        assert.equal(await provider.getEditorConnection('file:///a.sql', { isActiveEditor: true }), undefined);
        assert.equal(declinedCount(), 1);
        assert.equal(tokens.state.requests.filter((r) => r === 'prompt').length, 1);
        assert.equal(
            await provider.getEditorConnection('file:///a.sql', { isActiveEditor: true, consent: 'silent' }),
            undefined,
        );
        assert.equal(tokens.state.requests.filter((r) => r === 'prompt').length, 1);
    });

    it('query senza accesso concesso: SchemaAccessNotGrantedError, mai un prompt', async () => {
        const { provider, tokens } = setup();
        const { target } = (await provider.getEditorConnection('file:///a.sql', { isActiveEditor: true }))!;
        tokens.state.valid.clear();
        tokens.state.granted = false; // accesso revocato
        await assert.rejects(
            provider.runner.executeSimpleQuery(target, 'SELECT 1'),
            (err) => err instanceof SchemaAccessNotGrantedError,
        );
        assert.ok(!tokens.state.requests.includes('prompt'));
    });

    it('inoltra il cambio di connessione dell’editor attivo', async () => {
        const { provider, mssql } = setup();
        let fired = 0;
        provider.onDidChangeActiveEditorConnection(() => fired++);
        mssql.changed.fire();
        assert.equal(fired, 1);
    });

    it('cambio di sessione: rinnova il token, riusa le connessioni ancora valide e notifica', async () => {
        const sessions = fakeEvent();
        const { provider, mssql, tokens } = setup({ onDidChangeSessions: sessions.event });
        const { target } = (await provider.getEditorConnection('file:///a.sql', { isActiveEditor: true }))!;
        await provider.runner.executeSimpleQuery(target, 'SELECT 1');
        let fired = 0;
        provider.onDidChangeActiveEditorConnection(() => fired++);

        sessions.fire();
        await new Promise((r) => setImmediate(r));
        assert.equal(fired, 1);
        await provider.runner.executeSimpleQuery(target, 'SELECT 2');
        assert.equal(mssql.state.queries.at(-1)?.token, 't2');
        assert.equal(mssql.state.connectCount, 1);
        assert.equal(provider.tokens.declined, false);

        // Sessione chiusa e ricreata altrove: token e connessioni vecchi non valgono più.
        tokens.state.valid.clear();
        mssql.state.open.clear();
        sessions.fire();
        await new Promise((r) => setImmediate(r));
        await provider.runner.executeSimpleQuery(target, 'SELECT 3');
        assert.equal(mssql.state.connectCount, 2);
        assert.equal(mssql.state.queries.at(-1)?.uri, 'uri-2');
    });

    it('sign out: nessun prompt automatico alla sincronizzazione successiva', async () => {
        const sessions = fakeEvent();
        const { provider, tokens, declinedCount } = setup({ onDidChangeSessions: sessions.event });
        assert.ok(await provider.getEditorConnection('file:///a.sql', { isActiveEditor: true }));

        tokens.state.valid.clear();
        tokens.state.granted = false;
        sessions.fire();
        await new Promise((r) => setImmediate(r));
        assert.equal(provider.tokens.declined, true);

        assert.equal(await provider.getEditorConnection('file:///a.sql', { isActiveEditor: true }), undefined);
        assert.ok(!tokens.state.requests.includes('prompt'));
        assert.equal(declinedCount(), 0);
    });

    it('dispose chiude le connessioni proprie e gli eventi', async () => {
        const { provider, mssql } = setup();
        const { target } = (await provider.getEditorConnection('file:///a.sql', { isActiveEditor: true }))!;
        await provider.runner.executeSimpleQuery(target, 'SELECT 1');
        await provider.dispose();
        assert.deepEqual(mssql.state.disconnected, ['uri-1']);
        assert.equal(mssql.changed.listenerCount(), 0);
    });
});
