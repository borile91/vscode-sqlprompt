/**
 * Accesso al database dell'editor attivo, indipendente dall'API mssql sotto.
 *
 * Tutto il resto dell'estensione passa da `SchemaAccessProvider`; quale API
 * mssql c'è davvero lo decide `selectSchemaAccess`:
 *
 *   - `sharedConnections`: `getSharedConnectionsApi(1)` (mssql dopo 1.46.0),
 *     con consenso dell'utente, token e connessioni proprie;
 *   - `legacy`: `connectionSharing`, deprecata ma ancora presente;
 *   - nessuna delle due: nessun provider, con il motivo da mostrare all'utente.
 *
 * Nessuna dipendenza da `vscode`: autenticazione, URI ed eventi arrivano da
 * fuori (vedi `vscodeSchemaAccess.ts`), così la selezione è testabile.
 */

import type { QueryRunner } from '../schema/schemaLoad';
import {
    Event,
    MssqlExtensionApi,
    SHARED_CONNECTIONS_API_VERSION,
} from './mssqlApi';
import { LegacySchemaAccess } from './legacyBackend';
import { SharedConnectionsSchemaAccess, TokenSource } from './sharedConnectionsBackend';

/**
 * Quanto si può disturbare l'utente per ottenere l'accesso (solo nuova API):
 *   - `silent`: mai un prompt;
 *   - `auto`: il prompt di consenso al massimo finché l'utente non lo rifiuta;
 *   - `explicit`: comando lanciato dall'utente, il prompt si ripropone.
 */
export type ConsentMode = 'silent' | 'auto' | 'explicit';

/** La connessione di un editor, come serve per eseguire query e per le cache. */
export interface EditorConnection {
    /**
     * Da passare a `SchemaAccessProvider.runner`: l'URI dell'editor (legacy) o
     * la chiave di una connessione propria (nuova API). Opaco per il chiamante.
     */
    readonly target: string;
    readonly connectionId?: string;
    readonly database?: string;
}

export interface SchemaAccessProvider {
    readonly kind: 'sharedConnections' | 'legacy';
    /** Esegue query su un `target` di `getEditorConnection`. */
    readonly runner: QueryRunner;
    /**
     * Connessione dell'editor `editorUri`, o undefined se non è connesso (o se
     * l'accesso non è concesso). Non lancia. La nuova API conosce solo l'editor
     * attivo: per gli altri restituisce undefined.
     */
    getEditorConnection(
        editorUri: string,
        options: { isActiveEditor: boolean; consent?: ConsentMode },
    ): Promise<EditorConnection | undefined>;
    /** Connessioni aperte o chiuse in mssql. */
    readonly onDidChangeConnections?: Event<void>;
    /**
     * Connessione o database dell'editor attivo cambiati (anche con `USE`), o
     * accesso concesso/revocato. Se c'è, rende inutile il polling del database.
     */
    readonly onDidChangeActiveEditorConnection?: Event<void>;
    /** Chiude le connessioni aperte dal provider. */
    dispose(): Promise<void>;
}

/** Ciò che la selezione prende dall'ambiente (VS Code nel codice reale). */
export interface SchemaAccessDeps {
    /** Id dell'estensione, per l'API legacy. */
    extensionId: string;
    /** Token dal provider di autenticazione indicato dalla nuova API. */
    createTokenSource(authenticationProviderId: string): TokenSource;
    /** Cambi di sessione del provider di autenticazione (accesso concesso o revocato). */
    onDidChangeSessions?(authenticationProviderId: string): Event<void> | undefined;
    /** Stringa URI → oggetto URI accettato da `uriOwnershipApi.ownsUri`. */
    parseUri?(uri: string): unknown;
    /** L'utente ha rifiutato il consenso. */
    onAccessDeclined?(): void;
    log?(message: string): void;
}

export type SchemaAccessSelection =
    | { provider: SchemaAccessProvider; reason?: undefined }
    | { provider?: undefined; reason: string };

/** Sceglie il backend in base a ciò che l'API mssql installata offre davvero. */
export function selectSchemaAccess(
    api: MssqlExtensionApi | undefined,
    deps: SchemaAccessDeps,
): SchemaAccessSelection {
    if (!api || typeof api !== 'object') {
        return { reason: 'the mssql extension did not return an API' };
    }

    const ownership = api.uriOwnershipApi;
    const onDidChangeConnections: Event<void> | undefined =
        typeof ownership?.onDidChangeUriOwnership === 'function'
            ? (listener) => ownership.onDidChangeUriOwnership!(listener)
            : undefined;

    if (typeof api.getSharedConnectionsApi === 'function') {
        try {
            const shared = api.getSharedConnectionsApi(SHARED_CONNECTIONS_API_VERSION);
            if (
                shared &&
                typeof shared.authenticationProviderId === 'string' &&
                typeof shared.connect === 'function' &&
                typeof shared.executeSimpleQuery === 'function' &&
                typeof shared.getActiveEditorConnectionId === 'function'
            ) {
                const parseUri = deps.parseUri;
                const ownsEditor =
                    typeof ownership?.ownsUri === 'function' && parseUri
                        ? (editorUri: string) => ownership.ownsUri!(parseUri(editorUri))
                        : undefined;
                return {
                    provider: new SharedConnectionsSchemaAccess({
                        api: shared,
                        tokens: deps.createTokenSource(shared.authenticationProviderId),
                        onDidChangeSessions: deps.onDidChangeSessions?.(shared.authenticationProviderId),
                        ownsEditor,
                        onDidChangeConnections,
                        onAccessDeclined: deps.onAccessDeclined,
                        log: deps.log,
                    }),
                };
            }
            deps.log?.('getSharedConnectionsApi(1) returned an incomplete API; trying connectionSharing');
        } catch (err: any) {
            // Versione non supportata: si prova l'API vecchia.
            deps.log?.(`getSharedConnectionsApi(1) failed: ${err?.message ?? err}; trying connectionSharing`);
        }
    }

    const legacy = api.connectionSharing;
    if (legacy && typeof legacy.executeSimpleQuery === 'function') {
        return { provider: new LegacySchemaAccess(legacy, deps.extensionId, onDidChangeConnections) };
    }

    return { reason: 'the installed mssql extension offers no connection-sharing API' };
}
