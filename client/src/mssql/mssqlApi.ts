/**
 * Tipi minimi dell'API esportata dall'estensione mssql (`ms-mssql.mssql`).
 *
 * Non esiste un pacchetto npm aggiornato con i typings: qui c'è solo la parte
 * che usiamo, ricavata da `extensions/mssql/typings/vscode-mssql.d.ts` su
 * `microsoft/vscode-mssql@main` (PR #23076). Tutto è opzionale dove una
 * versione installata può non averlo: le capacità si verificano a runtime.
 *
 * Nessuna dipendenza da `vscode`: eventi e disposable sono descritti
 * strutturalmente, così i backend restano testabili con Node.
 */

/** Il minimo di `vscode.Disposable`. */
export interface Disposable {
    dispose(): unknown;
}

/** Il minimo di `vscode.Event<T>`. */
export type Event<T> = (listener: (e: T) => unknown) => Disposable;

/**
 * API deprecata `IConnectionSharingService` (fino a mssql 1.46.0 l'unica).
 * Identifica il chiamante con l'id dell'estensione e accetta l'URI dell'editor.
 */
export interface LegacyConnectionSharingApi {
    getActiveEditorConnectionId?(extensionId: string): Promise<string | undefined>;
    getActiveDatabase?(extensionId: string): Promise<string | undefined>;
    getDatabaseForConnectionId?(extensionId: string, connectionId: string): Promise<string | undefined>;
    isConnected?(connectionUri: string): boolean | Promise<boolean>;
    executeSimpleQuery(connectionUri: string, queryString: string): Promise<any>;
    listDatabases?(connectionUri: string): Promise<string[]>;
}

/**
 * Nuova API `ISharedConnectionsService` (`getSharedConnectionsApi(1)`).
 * Ogni chiamata vuole un token di sessione del provider di autenticazione
 * `authenticationProviderId`; i metodi con URI accettano solo URI restituiti
 * da `connect` per la stessa sessione.
 */
export interface SharedConnectionsApi {
    readonly authenticationProviderId: string;
    getActiveEditorConnectionId(accessToken: string): Promise<string | undefined>;
    getActiveDatabase(accessToken: string): Promise<string | undefined>;
    getDatabaseForConnectionId(accessToken: string, connectionId: string): Promise<string | undefined>;
    connect(accessToken: string, connectionId: string, database?: string): Promise<string>;
    disconnect(accessToken: string, connectionUri: string): Promise<void>;
    isConnected(accessToken: string, connectionUri: string): Promise<boolean>;
    executeSimpleQuery(accessToken: string, connectionUri: string, queryString: string): Promise<any>;
    listDatabases?(accessToken: string, connectionUri: string): Promise<string[]>;
    /** Cambio di connessione o database dell'editor attivo (anche `USE`). Nessun token richiesto. */
    readonly onDidChangeActiveEditorConnection?: Event<void>;
}

/** `UriOwnershipApi`: `ownsUri` vuole un `vscode.Uri`, qui opaco. */
export interface UriOwnershipApi {
    ownsUri?(uri: unknown): boolean;
    onDidChangeUriOwnership?: Event<void>;
}

/** `IExtension` di mssql, con le parti che possono mancare a seconda della versione. */
export interface MssqlExtensionApi {
    /** @deprecated da mssql > 1.46.0, sostituita da `getSharedConnectionsApi`. */
    readonly connectionSharing?: LegacyConnectionSharingApi;
    getSharedConnectionsApi?(version: 1): SharedConnectionsApi;
    readonly uriOwnershipApi?: UriOwnershipApi;
}

/** Versione della nuova API per cui è scritto il codice. */
export const SHARED_CONNECTIONS_API_VERSION = 1;

/** Codici di `ConnectionSharingError` (mssql) che gestiamo. */
export const MssqlErrorCode = {
    InvalidAccessToken: 'INVALID_ACCESS_TOKEN',
    InvalidConnectionUri: 'INVALID_CONNECTION_URI',
    NoActiveConnection: 'NO_ACTIVE_CONNECTION',
} as const;

/**
 * Codice mssql di un errore. Il `code` stringa arriva intatto (stesso extension
 * host); il testo è un ripiego se un giorno l'errore venisse serializzato.
 */
export function mssqlErrorCode(err: unknown): string | undefined {
    const e = err as { code?: unknown; message?: unknown } | undefined;
    if (typeof e?.code === 'string') {
        return e.code;
    }
    const message = String(e?.message ?? '').toLowerCase();
    if (message.includes('access token is not valid')) {
        return MssqlErrorCode.InvalidAccessToken;
    }
    if (message.includes('invalid connection uri')) {
        return MssqlErrorCode.InvalidConnectionUri;
    }
    if (message.includes('connection is not active')) {
        return MssqlErrorCode.NoActiveConnection;
    }
    return undefined;
}
