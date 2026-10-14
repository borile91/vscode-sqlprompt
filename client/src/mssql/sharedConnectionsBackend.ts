/**
 * Backend sulla nuova API mssql `getSharedConnectionsApi(1)`.
 *
 * Differenze rispetto a `connectionSharing`:
 *   - ogni chiamata vuole un token di sessione del provider di autenticazione
 *     di mssql; il primo lo concede l'utente (prompt di VS Code), poi arriva
 *     senza prompt ma scade dopo un'ora;
 *   - le query non vanno sull'URI dell'editor ma su connessioni aperte da noi
 *     con `connect`, una per `connectionId|database`, riusate finché vivono.
 *
 * Il `target` restituito al resto del codice è la chiave della connessione:
 * il runner la traduce nell'URI vero, connettendo (o riconnettendo) quando
 * serve e rinnovando il token una volta se mssql lo rifiuta.
 */

import type { QueryRunner } from '../schema/schemaLoad';
import type { ConsentMode, EditorConnection, SchemaAccessProvider } from './connectionProvider';
import { disposeAll, SimpleEmitter } from './events';
import { Disposable, Event, MssqlErrorCode, SharedConnectionsApi, mssqlErrorCode } from './mssqlApi';

// ── Token ─────────────────────────────────────────────────────────────────────

/** Da dove arrivano i token (in VS Code: `authentication.getSession`). */
export interface TokenSource {
    /**
     * `silent`: mai un prompt, undefined se l'accesso non è concesso.
     * `prompt`: chiede il consenso; lancia (o restituisce undefined) se l'utente rifiuta.
     */
    getAccessToken(mode: 'silent' | 'prompt'): Promise<string | undefined>;
}

/** L'accesso alle connessioni mssql non è (più) concesso. */
export class SchemaAccessNotGrantedError extends Error {
    constructor() {
        super('access to the SQL Server (mssql) connections has not been granted to SQL Prompt');
        this.name = 'SchemaAccessNotGrantedError';
    }
}

/**
 * I token mssql durano un'ora: quello in cache si rinnova un po' prima, così
 * una query lunga non parte con un token in scadenza.
 */
export const TOKEN_REFRESH_AFTER_MS = 50 * 60 * 1000;

/**
 * Cache in memoria del token, con la politica del consenso.
 *
 * Il prompt `auto` compare al massimo finché l'utente non lo rifiuta; dopo un
 * rifiuto solo `explicit` (un comando dell'utente) lo ripropone. Le richieste
 * contemporanee condividono la stessa chiamata.
 */
export class AccessTokenCache {
    private cached: { token: string; expiresAt: number } | undefined;
    private silentInFlight: Promise<string | undefined> | undefined;
    private promptInFlight: Promise<string | undefined> | undefined;
    private declinedByUser = false;

    constructor(
        private readonly source: TokenSource,
        private readonly options: {
            now?: () => number;
            refreshAfterMs?: number;
            onDeclined?: () => void;
        } = {},
    ) {}

    /** Vero se l'utente ha rifiutato il consenso e non l'ha più concesso. */
    get declined(): boolean {
        return this.declinedByUser;
    }

    async get(consent: ConsentMode): Promise<string | undefined> {
        if (this.cached && this.now() < this.cached.expiresAt) {
            return this.cached.token;
        }

        if (!this.silentInFlight) {
            this.silentInFlight = this.fetchSilent().finally(() => {
                this.silentInFlight = undefined;
            });
        }
        const silent = await this.silentInFlight;
        if (silent) {
            return silent;
        }

        if (consent === 'silent' || (consent === 'auto' && this.declinedByUser)) {
            return undefined;
        }
        if (!this.promptInFlight) {
            this.promptInFlight = this.prompt().finally(() => {
                this.promptInFlight = undefined;
            });
        }
        return this.promptInFlight;
    }

    /** Scarta `token` se è quello in cache (mssql l'ha rifiutato). */
    invalidate(token: string): void {
        if (this.cached?.token === token) {
            this.cached = undefined;
        }
    }

    /** Sessione cambiata (accesso concesso o revocato altrove): niente cache. */
    reset(): void {
        this.cached = undefined;
    }

    /** Accesso revocato dall'utente (es. sign out): come un rifiuto, ma senza avviso. */
    markDeclined(): void {
        this.declinedByUser = true;
    }

    /** L'ultimo token valido, senza chiederne uno nuovo. */
    peek(): string | undefined {
        return this.cached && this.now() < this.cached.expiresAt ? this.cached.token : undefined;
    }

    private async fetchSilent(): Promise<string | undefined> {
        try {
            const token = await this.source.getAccessToken('silent');
            return token ? this.store(token) : undefined;
        } catch {
            return undefined;
        }
    }

    private async prompt(): Promise<string | undefined> {
        try {
            const token = await this.source.getAccessToken('prompt');
            if (token) {
                return this.store(token);
            }
        } catch {
            // Prompt annullato: trattato come rifiuto.
        }
        this.declinedByUser = true;
        this.options.onDeclined?.();
        return undefined;
    }

    private store(token: string): string {
        this.declinedByUser = false;
        this.cached = {
            token,
            expiresAt: this.now() + (this.options.refreshAfterMs ?? TOKEN_REFRESH_AFTER_MS),
        };
        return token;
    }

    private now(): number {
        return (this.options.now ?? Date.now)();
    }
}

// ── Connessioni proprie ───────────────────────────────────────────────────────

/** Chiave di una connessione propria: profilo e database (case-insensitive). */
export function connectionKey(connectionId: string, database: string | undefined): string {
    return `${connectionId}|${(database ?? '').toLowerCase()}`;
}

interface PoolEntry {
    connectionId: string;
    database: string | undefined;
    uri?: string;
    connecting?: Promise<string>;
    lastUsed: number;
}

/** Quante connessioni proprie restano aperte insieme: le meno usate si chiudono. */
export const DEFAULT_POOL_SIZE = 4;

/**
 * Connessioni aperte con `connect`, una per `connectionId|database`.
 *
 * `acquire` riusa la connessione se mssql la dà ancora per connessa,
 * altrimenti ne apre un'altra; due richieste contemporanee aspettano la
 * stessa `connect`.
 */
export class ConnectionPool {
    private readonly entries = new Map<string, PoolEntry>();
    private clock = 0;

    constructor(
        private readonly api: Pick<SharedConnectionsApi, 'connect' | 'disconnect' | 'isConnected'>,
        private readonly maxSize = DEFAULT_POOL_SIZE,
        private readonly log?: (message: string) => void,
    ) {}

    /** URI di una connessione propria per profilo e database, aperta se serve. */
    async acquire(token: string, connectionId: string, database: string | undefined): Promise<string> {
        const key = connectionKey(connectionId, database);
        let entry = this.entries.get(key);
        if (!entry) {
            entry = { connectionId, database, lastUsed: 0 };
            this.entries.set(key, entry);
        }
        entry.lastUsed = ++this.clock;

        if (entry.uri) {
            const uri = entry.uri;
            let alive = false;
            try {
                alive = await this.api.isConnected(token, uri);
            } catch (err) {
                if (mssqlErrorCode(err) === MssqlErrorCode.InvalidAccessToken) {
                    throw err;
                }
                alive = false;
            }
            if (alive) {
                return uri;
            }
            // Chiusa da mssql (o di un'altra sessione): si riconnette.
            if (entry.uri === uri) {
                entry.uri = undefined;
            }
        }

        let connecting = entry.connecting;
        if (!connecting) {
            const pending = entry;
            connecting = pending.connecting = this.api.connect(token, connectionId, database || undefined).then(
                (uri) => {
                    pending.uri = uri;
                    pending.connecting = undefined;
                    this.evict(token, pending);
                    return uri;
                },
                (err) => {
                    pending.connecting = undefined;
                    throw err;
                },
            );
        }
        return connecting;
    }

    /** La connessione non è più valida (mssql l'ha rifiutata): la prossima `acquire` riconnette. */
    invalidate(connectionId: string, database: string | undefined): void {
        const entry = this.entries.get(connectionKey(connectionId, database));
        if (entry) {
            entry.uri = undefined;
        }
    }

    /** Chiude tutte le connessioni aperte. */
    async disconnectAll(token: string | undefined): Promise<void> {
        const uris = [...this.entries.values()].map((e) => e.uri).filter((u): u is string => !!u);
        this.entries.clear();
        if (!token) {
            return;
        }
        await Promise.all(uris.map((uri) => this.disconnectQuietly(token, uri)));
    }

    /** Numero di connessioni aperte (per i test). */
    get openCount(): number {
        return [...this.entries.values()].filter((e) => e.uri).length;
    }

    /** Oltre `maxSize` chiude le connessioni usate meno di recente. */
    private evict(token: string, keep: PoolEntry): void {
        const open = [...this.entries.entries()].filter(([, e]) => e.uri && e !== keep);
        let excess = open.length + 1 - this.maxSize;
        if (excess <= 0) {
            return;
        }
        open.sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
        for (const [key, entry] of open) {
            if (excess-- <= 0) {
                break;
            }
            const uri = entry.uri!;
            this.entries.delete(key);
            void this.disconnectQuietly(token, uri);
        }
    }

    private async disconnectQuietly(token: string, uri: string): Promise<void> {
        try {
            await this.api.disconnect(token, uri);
        } catch (err: any) {
            this.log?.(`disconnect of a shared connection failed: ${err?.message ?? err}`);
        }
    }
}

// ── Provider ──────────────────────────────────────────────────────────────────

export interface SharedConnectionsDeps {
    api: SharedConnectionsApi;
    tokens: TokenSource;
    /** Cambi di sessione del provider di autenticazione. */
    onDidChangeSessions?: Event<void>;
    /** Vero se mssql ha (o sta aprendo) una connessione per l'editor: evita prompt inutili. */
    ownsEditor?: (editorUri: string) => boolean;
    onDidChangeConnections?: Event<void>;
    onAccessDeclined?: () => void;
    log?: (message: string) => void;
    now?: () => number;
    poolSize?: number;
}

const TARGET_PREFIX = 'mssql-shared:';

export class SharedConnectionsSchemaAccess implements SchemaAccessProvider {
    readonly kind = 'sharedConnections' as const;
    readonly runner: QueryRunner;
    readonly onDidChangeConnections?: Event<void>;
    readonly onDidChangeActiveEditorConnection: Event<void>;

    readonly tokens: AccessTokenCache;
    readonly pool: ConnectionPool;
    private readonly api: SharedConnectionsApi;
    private readonly targets = new Map<string, { connectionId: string; database: string | undefined }>();
    private readonly changes = new SimpleEmitter();
    private readonly subscriptions: Disposable[] = [];

    constructor(private readonly deps: SharedConnectionsDeps) {
        this.api = deps.api;
        this.tokens = new AccessTokenCache(deps.tokens, {
            now: deps.now,
            onDeclined: deps.onAccessDeclined,
        });
        this.pool = new ConnectionPool(deps.api, deps.poolSize ?? DEFAULT_POOL_SIZE, deps.log);
        this.onDidChangeConnections = deps.onDidChangeConnections;
        this.onDidChangeActiveEditorConnection = this.changes.event;

        if (typeof this.api.onDidChangeActiveEditorConnection === 'function') {
            this.subscriptions.push(this.api.onDidChangeActiveEditorConnection(() => this.changes.fire()));
        }
        if (deps.onDidChangeSessions) {
            this.subscriptions.push(deps.onDidChangeSessions(() => void this.handleSessionsChanged()));
        }

        this.runner = {
            executeSimpleQuery: (target, query) =>
                this.withConnection(target, (token, uri) => this.api.executeSimpleQuery(token, uri, query)),
            listDatabases: this.api.listDatabases
                ? (target) => this.withConnection(target, (token, uri) => this.api.listDatabases!(token, uri))
                : undefined,
        };
    }

    async getEditorConnection(
        editorUri: string,
        options: { isActiveEditor: boolean; consent?: ConsentMode },
    ): Promise<EditorConnection | undefined> {
        if (!options.isActiveEditor) {
            return undefined;
        }
        // Senza una connessione mssql sull'editor non serve il token: niente prompt.
        if (this.deps.ownsEditor) {
            try {
                if (!this.deps.ownsEditor(editorUri)) {
                    return undefined;
                }
            } catch {
                // Ownership non verificabile: si chiede a mssql.
            }
        }

        try {
            return await this.withToken(options.consent ?? 'auto', async (token) => {
                const connectionId = await this.api.getActiveEditorConnectionId(token);
                if (!connectionId) {
                    return undefined;
                }
                let database: string | undefined;
                try {
                    database = await this.api.getActiveDatabase(token);
                    if (!database) {
                        database = await this.api.getDatabaseForConnectionId(token, connectionId);
                    }
                } catch (err) {
                    if (mssqlErrorCode(err) === MssqlErrorCode.InvalidAccessToken) {
                        throw err;
                    }
                    database = undefined;
                }
                return { target: this.registerTarget(connectionId, database), connectionId, database };
            });
        } catch (err: any) {
            if (!(err instanceof SchemaAccessNotGrantedError)) {
                this.deps.log?.(`active editor connection unavailable: ${err?.message ?? err}`);
            }
            return undefined;
        }
    }

    async dispose(): Promise<void> {
        disposeAll(this.subscriptions);
        this.changes.clear();
        let token = this.tokens.peek();
        if (!token && this.pool.openCount > 0) {
            token = await this.tokens.get('silent');
        }
        await this.pool.disconnectAll(token);
    }

    /**
     * Sessione creata o chiusa: il token in cache può non valere più. Le
     * connessioni restano nel pool: `acquire` le verifica con `isConnected`
     * (falso per quelle di un'altra sessione) e le riapre. Se l'accesso non c'è
     * più (sign out) vale come un rifiuto: niente prompt automatici.
     */
    private async handleSessionsChanged(): Promise<void> {
        this.tokens.reset();
        // `peek`: il prompt di consenso può essersi concluso nel frattempo.
        if (!(await this.tokens.get('silent')) && !this.tokens.peek()) {
            this.tokens.markDeclined();
        }
        this.changes.fire();
    }

    /** Chiave stabile per profilo e database, risolta in un URI dal runner. */
    private registerTarget(connectionId: string, database: string | undefined): string {
        const target = TARGET_PREFIX + connectionKey(connectionId, database);
        if (!this.targets.has(target)) {
            this.targets.set(target, { connectionId, database });
        }
        return target;
    }

    /** Esegue `op` con un token; se mssql lo rifiuta ne chiede uno nuovo e riprova una volta. */
    private async withToken<T>(consent: ConsentMode, op: (token: string) => Promise<T>): Promise<T> {
        for (let attempt = 0; ; attempt++) {
            const token = await this.tokens.get(attempt === 0 ? consent : 'silent');
            if (!token) {
                throw new SchemaAccessNotGrantedError();
            }
            try {
                return await op(token);
            } catch (err) {
                if (attempt === 0 && mssqlErrorCode(err) === MssqlErrorCode.InvalidAccessToken) {
                    this.tokens.invalidate(token);
                    continue;
                }
                throw err;
            }
        }
    }

    /**
     * Esegue `op` sulla connessione propria di `target`. Un token rifiutato si
     * rinnova una volta; una connessione rifiutata (chiusa, di un'altra
     * sessione) si riapre una volta.
     */
    private async withConnection<T>(
        target: string,
        op: (token: string, uri: string) => Promise<T>,
    ): Promise<T> {
        const ref = this.targets.get(target);
        if (!ref) {
            throw new Error(`unknown shared connection target: ${target}`);
        }
        let tokenRenewed = false;
        let reconnected = false;
        for (;;) {
            // Mai un prompt durante una query: il consenso si chiede alla sincronizzazione.
            const token = await this.tokens.get('silent');
            if (!token) {
                throw new SchemaAccessNotGrantedError();
            }
            try {
                const uri = await this.pool.acquire(token, ref.connectionId, ref.database);
                return await op(token, uri);
            } catch (err) {
                const code = mssqlErrorCode(err);
                if (code === MssqlErrorCode.InvalidAccessToken && !tokenRenewed) {
                    tokenRenewed = true;
                    this.tokens.invalidate(token);
                    continue;
                }
                if (
                    (code === MssqlErrorCode.InvalidConnectionUri || code === MssqlErrorCode.NoActiveConnection) &&
                    !reconnected
                ) {
                    reconnected = true;
                    this.pool.invalidate(ref.connectionId, ref.database);
                    continue;
                }
                throw err;
            }
        }
    }
}
