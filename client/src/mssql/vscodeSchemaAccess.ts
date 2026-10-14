/**
 * Collega `selectSchemaAccess` a VS Code: attiva mssql, fornisce token
 * (`authentication.getSession`), URI ed eventi, e avvisa l'utente.
 *
 * Unico file della cartella che importa `vscode`.
 */

import { authentication, commands, extensions, Uri, window } from 'vscode';
import { MssqlExtensionApi } from './mssqlApi';
import { SchemaAccessProvider, selectSchemaAccess } from './connectionProvider';

const MSSQL_EXTENSION_ID = 'ms-mssql.mssql';

/** Il messaggio "API non disponibile" compare una sola volta per finestra. */
let unavailableNotified = false;

function notifyUnavailable(reason: string): void {
    console.warn(`[SQL Prompt] mssql connection API unavailable: ${reason}`);
    if (unavailableNotified) {
        return;
    }
    unavailableNotified = true;
    void window.showWarningMessage(
        `SQL Prompt: ${reason}, so schema completion, Go to Definition and ALTER scaffolding ` +
        'are unavailable. Install or update the SQL Server (mssql) extension.',
    );
}

/** Rifiuto del consenso: un solo avviso per rifiuto, con un modo per tornare indietro. */
function notifyAccessDeclined(authenticationProviderId: () => string | undefined): void {
    console.warn('[SQL Prompt] access to the mssql shared connections was declined');
    // Richiesta non bloccante nel menu Accounts, per concedere l'accesso più tardi.
    const providerId = authenticationProviderId();
    if (providerId) {
        void Promise.resolve(authentication.getSession(providerId, [], {})).catch(() => undefined);
    }
    void window
        .showWarningMessage(
            'SQL Prompt needs access to your SQL Server (mssql) connections to load the schema. ' +
            'Allow it from the Accounts menu, or run "SQL Prompt: Reload Schema" to be asked again.',
            'Allow Access',
        )
        .then((choice) => {
            if (choice === 'Allow Access') {
                void commands.executeCommand('sqlPrompt.reloadSchema');
            }
        });
}

/**
 * Attiva mssql e sceglie il backend. Undefined (dopo un avviso all'utente,
 * una volta sola) se nessuna API di condivisione è disponibile.
 */
export async function createSchemaAccess(extensionId: string): Promise<SchemaAccessProvider | undefined> {
    const mssqlExt = extensions.getExtension<MssqlExtensionApi>(MSSQL_EXTENSION_ID);
    if (!mssqlExt) {
        notifyUnavailable('the SQL Server (mssql) extension is not installed');
        return undefined;
    }

    let api: MssqlExtensionApi | undefined;
    try {
        api = await mssqlExt.activate();
    } catch (err: any) {
        notifyUnavailable(`the SQL Server (mssql) extension failed to activate (${err?.message ?? err})`);
        return undefined;
    }

    let providerId: string | undefined;
    const selection = selectSchemaAccess(api, {
        extensionId,
        createTokenSource: (id) => {
            providerId = id;
            return {
                async getAccessToken(mode) {
                    const session = await authentication.getSession(
                        id,
                        [],
                        mode === 'silent' ? { silent: true } : { createIfNone: true },
                    );
                    return session?.accessToken;
                },
            };
        },
        onDidChangeSessions: (id) => (listener) =>
            authentication.onDidChangeSessions((event) => {
                if (event.provider.id === id) {
                    listener(undefined);
                }
            }),
        parseUri: (uri) => Uri.parse(uri),
        onAccessDeclined: () => notifyAccessDeclined(() => providerId),
        log: (message) => console.log(`[SQL Prompt] ${message}`),
    });

    if (!selection.provider) {
        notifyUnavailable(selection.reason);
        return undefined;
    }
    console.log(`[SQL Prompt] mssql connection API: ${selection.provider.kind}`);
    return selection.provider;
}
