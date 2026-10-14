/**
 * Backend sull'API deprecata `connectionSharing` (mssql fino a 1.46.0).
 *
 * Le query vanno direttamente sull'URI dell'editor, come prima
 * dell'astrazione: il comportamento resta quello di sempre.
 */

import type { QueryRunner } from '../schema/schemaLoad';
import type { ConsentMode, EditorConnection, SchemaAccessProvider } from './connectionProvider';
import { Event, LegacyConnectionSharingApi } from './mssqlApi';

export class LegacySchemaAccess implements SchemaAccessProvider {
    readonly kind = 'legacy' as const;
    readonly runner: QueryRunner;

    constructor(
        private readonly api: LegacyConnectionSharingApi,
        private readonly extensionId: string,
        readonly onDidChangeConnections?: Event<void>,
    ) {
        this.runner = {
            executeSimpleQuery: (uri, query) => api.executeSimpleQuery(uri, query),
            listDatabases: api.listDatabases ? (uri) => api.listDatabases!(uri) : undefined,
        };
    }

    async getEditorConnection(
        editorUri: string,
        options: { isActiveEditor: boolean; consent?: ConsentMode },
    ): Promise<EditorConnection | undefined> {
        try {
            if (!(await this.api.isConnected?.(editorUri))) {
                return undefined;
            }
        } catch {
            return undefined;
        }

        // Id e database descrivono l'editor attivo: per gli altri non valgono.
        let connectionId: string | undefined;
        let database: string | undefined;
        if (options.isActiveEditor) {
            try {
                connectionId = await this.api.getActiveEditorConnectionId?.(this.extensionId);
            } catch {
                connectionId = undefined;
            }
            try {
                database = await this.api.getActiveDatabase?.(this.extensionId);
                if (!database && connectionId) {
                    database = await this.api.getDatabaseForConnectionId?.(this.extensionId, connectionId);
                }
            } catch {
                database = undefined;
            }
        }
        return { target: editorUri, connectionId, database };
    }

    async dispose(): Promise<void> {
        // Le connessioni sono quelle degli editor: non sono nostre da chiudere.
    }
}
