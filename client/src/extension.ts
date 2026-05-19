import * as path from 'path';
import {
    ExtensionContext,
    ExtensionMode,
    commands,
    window,
    extensions,
    Uri,
} from "vscode";

import {
    LanguageClient,
    LanguageClientOptions,
    RevealOutputChannelOn,
    ServerOptions,
    TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;
let connectionSyncDebounce: ReturnType<typeof setTimeout> | undefined;
let mssqlApiPromise: Promise<any | undefined> | undefined;

type ColumnInfo = {
    name: string;
    dataType: string;
    maxLength: number | null;
    isNullable: boolean;
    isPrimaryKey: boolean;
};

type TableInfo = {
    schema: string;
    name: string;
    columns: ColumnInfo[];
    foreignKeys: ForeignKeyInfo[];
};

type ForeignKeyMapping = {
    column: string;
    referencedColumn: string;
};

type ForeignKeyInfo = {
    name: string;
    parentSchema: string;
    parentTable: string;
    referencedSchema: string;
    referencedTable: string;
    mappings: ForeignKeyMapping[];
};

// Our extension's identifier as published — used by the mssql connectionSharing
// API so the permission dialog shows "SQL Prompt" and the approval is persisted.
const EXTENSION_ID = "giacomoborile.vscode-sqlprompt";

async function getMssqlApi(): Promise<any | undefined> {
    if (mssqlApiPromise) {
        return mssqlApiPromise;
    }

    const mssqlExt = extensions.getExtension<any>("ms-mssql.mssql");
    if (!mssqlExt) {
        return undefined;
    }

    mssqlApiPromise = (async () => {
        try {
            const api = await mssqlExt.activate();
            if (!api?.connectionSharing) {
                return undefined;
            }
            return api;
        } catch {
            return undefined;
        }
    })();

    return mssqlApiPromise;
}

function extractRowsFromSimpleQueryResult(result: any): any[] {
    const rows = result?.rows;
    const columnInfo = result?.columnInfo;

    if (!Array.isArray(rows)) {
        return [];
    }

    if (!rows.length) {
        return rows;
    }

    if (!Array.isArray(rows[0])) {
        return rows;
    }

    if (!Array.isArray(columnInfo)) {
        return [];
    }

    return rows.map((values: any[]) => {
        const row: Record<string, any> = {};
        for (let i = 0; i < columnInfo.length; i++) {
            const rawName = columnInfo[i]?.columnName ?? columnInfo[i]?.name;
            const name = typeof rawName === "string" ? rawName : `col_${i}`;
            row[name] = values[i];
        }
        return row;
    });
}

function normalizeCellValue(value: any): any {
    if (value == null) {
        return value;
    }

    // mssql simple query rows may wrap values as objects like:
    // { displayValue: 'dbo', ... } or { value: 'dbo', ... }
    if (typeof value === "object") {
        if ("displayValue" in value) {
            return (value as any).displayValue;
        }
        if ("value" in value) {
            return (value as any).value;
        }
    }

    return value;
}

function normalizeText(value: any): string | undefined {
    const raw = normalizeCellValue(value);
    if (raw == null) {
        return undefined;
    }
    if (typeof raw === "string") {
        return raw;
    }
    if (typeof raw === "number" || typeof raw === "boolean") {
        return String(raw);
    }
    return undefined;
}

function mapRowsToSchemaSnapshot(rows: any[]): TableInfo[] {
    const tableMap = new Map<string, TableInfo>();

    for (const row of rows) {
        const schema = normalizeText(row.schema_name);
        const table = normalizeText(row.table_name);
        if (!schema || !table) {
            continue;
        }

        const key = `${schema}.${table}`;
        if (!tableMap.has(key)) {
            tableMap.set(key, {
                schema,
                name: table,
                columns: [],
                foreignKeys: [],
            });
        }

        const columnName = normalizeText(row.column_name);
        if (!columnName) {
            continue;
        }

        const maxLengthRaw = normalizeCellValue(row.max_length);
        const isNullableRaw = normalizeCellValue(row.is_nullable);
        const isPrimaryKeyRaw = normalizeCellValue(row.is_primary_key);

        tableMap.get(key)!.columns.push({
            name: columnName,
            dataType: normalizeText(row.data_type) ?? "unknown",
            maxLength:
                typeof maxLengthRaw === "number" ? maxLengthRaw : null,
            isNullable: isNullableRaw === true || isNullableRaw === 1,
            isPrimaryKey:
                isPrimaryKeyRaw === true || isPrimaryKeyRaw === 1,
        });
    }

    return Array.from(tableMap.values());
}

function mapRowsToForeignKeys(rows: any[]): ForeignKeyInfo[] {
    const fkMap = new Map<string, ForeignKeyInfo>();

    for (const row of rows) {
        const parentSchema = normalizeText(row.parent_schema);
        const parentTable = normalizeText(row.parent_table);
        const fkName = normalizeText(row.fk_name);

        if (!parentSchema || !parentTable || !fkName) {
            continue;
        }

        const fkKey = `${parentSchema}.${parentTable}::${fkName}`;
        if (!fkMap.has(fkKey)) {
            fkMap.set(fkKey, {
                name: fkName,
                parentSchema,
                parentTable,
                referencedSchema: normalizeText(row.referenced_schema) ?? "",
                referencedTable: normalizeText(row.referenced_table) ?? "",
                mappings: [],
            });
        }

        const parentColumn = normalizeText(row.parent_column);
        const referencedColumn = normalizeText(row.referenced_column);
        if (!parentColumn || !referencedColumn) {
            continue;
        }

        fkMap.get(fkKey)!.mappings.push({
            column: parentColumn,
            referencedColumn,
        });
    }

    return Array.from(fkMap.values());
}

function attachForeignKeysToTables(
    tables: TableInfo[],
    foreignKeys: ForeignKeyInfo[],
): TableInfo[] {
    const tableMap = new Map<string, TableInfo>();
    for (const table of tables) {
        tableMap.set(`${table.schema}.${table.name}`.toLowerCase(), table);
    }

    for (const fk of foreignKeys) {
        const key = `${fk.parentSchema}.${fk.parentTable}`.toLowerCase();
        const table = tableMap.get(key);
        if (table) {
            table.foreignKeys.push(fk);
        }
    }

    return tables;
}

async function loadSchemaViaConnectionSharing(ownerUri: string): Promise<TableInfo[] | undefined> {
    const api = await getMssqlApi();
    if (!api?.connectionSharing) {
        return undefined;
    }

    const schemaQuery = `
      SELECT
        s.name AS schema_name,
        t.name AS table_name,
        c.name AS column_name,
        ty.name AS data_type,
        c.max_length,
        c.is_nullable,
        CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS is_primary_key
      FROM sys.tables t
      INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
      INNER JOIN sys.columns c ON t.object_id = c.object_id
      INNER JOIN sys.types ty ON c.user_type_id = ty.user_type_id
      LEFT JOIN (
        SELECT ic.object_id, ic.column_id
        FROM sys.index_columns ic
        INNER JOIN sys.indexes i ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        WHERE i.is_primary_key = 1
      ) pk ON c.object_id = pk.object_id AND c.column_id = pk.column_id
      ORDER BY s.name, t.name, c.column_id
    `;

        const foreignKeysQuery = `
            SELECT
                fk.name AS fk_name,
                sch_parent.name AS parent_schema,
                t_parent.name AS parent_table,
                c_parent.name AS parent_column,
                sch_ref.name AS referenced_schema,
                t_ref.name AS referenced_table,
                c_ref.name AS referenced_column,
                fkc.constraint_column_id
            FROM sys.foreign_keys fk
            INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
            INNER JOIN sys.tables t_parent ON fkc.parent_object_id = t_parent.object_id
            INNER JOIN sys.schemas sch_parent ON t_parent.schema_id = sch_parent.schema_id
            INNER JOIN sys.columns c_parent ON fkc.parent_object_id = c_parent.object_id AND fkc.parent_column_id = c_parent.column_id
            INNER JOIN sys.tables t_ref ON fkc.referenced_object_id = t_ref.object_id
            INNER JOIN sys.schemas sch_ref ON t_ref.schema_id = sch_ref.schema_id
            INNER JOIN sys.columns c_ref ON fkc.referenced_object_id = c_ref.object_id AND fkc.referenced_column_id = c_ref.column_id
            ORDER BY sch_parent.name, t_parent.name, fk.name, fkc.constraint_column_id
        `;

    try {
        const result = await api.connectionSharing.executeSimpleQuery?.(
            ownerUri,
            schemaQuery,
        );
        const fkResult = await api.connectionSharing.executeSimpleQuery?.(
            ownerUri,
            foreignKeysQuery,
        );

        const rows = extractRowsFromSimpleQueryResult(result);
        const fkRows = extractRowsFromSimpleQueryResult(fkResult);

        const schemaTables = mapRowsToSchemaSnapshot(rows);
        const foreignKeys = mapRowsToForeignKeys(fkRows);

        return attachForeignKeysToTables(schemaTables, foreignKeys);
    } catch {
        return undefined;
    }
}

/**
 * Reads the mssql connection for the currently active SQL editor and sends it
 * to the language server so it can (re)load the schema.
 *
 * When showNotification is true (connection just changed), also pops an
 * information message including the active database name.
 */
async function syncMssqlConnection(showNotification = false): Promise<boolean> {
    if (!client) {
        console.log("SQL Prompt: syncMssqlConnection — client not ready");
        return false;
    }

    const editor = window.activeTextEditor;
    if (!editor || editor.document.languageId !== "sql") {
        console.log("SQL Prompt: syncMssqlConnection — no active SQL editor");
        return false;
    }

    const api = await getMssqlApi();
    if (!api?.connectionSharing) {
        return false;
    }

    const ownerUri = editor.document.uri.toString();

    try {
        const isConnected = await api.connectionSharing.isConnected?.(ownerUri);
        if (!isConnected) {
            console.log("SQL Prompt: syncMssqlConnection — active SQL file is not connected in mssql");
            return false;
        }
    } catch {
        return false;
    }

    const schemaSnapshot = await loadSchemaViaConnectionSharing(ownerUri);
    if (!schemaSnapshot) {
        return false;
    }

    try {
        const result = await client.sendRequest<{
            success: boolean;
            tableCount: number;
        }>("sqlPrompt/updateSchemaSnapshot", { tables: schemaSnapshot });

        if (!result?.success) {
            return false;
        }

        window.setStatusBarMessage(
            `SQL Prompt: schema loaded — ${result.tableCount} table(s)`,
            5000,
        );

        if (showNotification) {
            let dbDetail = "";
            try {
                const db: string | undefined =
                    await api.connectionSharing.getActiveDatabase?.(EXTENSION_ID);
                if (db) {
                    dbDetail = ` · ${db}`;
                }
            } catch {
                /* permission not yet granted or no active connection */
            }
            window.showInformationMessage(
                `SQL Prompt: connected${dbDetail} — ${result.tableCount} table(s) loaded`,
            );
        }

        return true;
    } catch {
        return false;
    }
}

/**
 * Subscribes to mssql's URI-ownership change event so that whenever the user
 * connects / disconnects / switches connection in the mssql extension, we
 * automatically re-sync the schema and show a notification.
 *
 * The event is exposed via api.uriOwnershipApi.onDidChangeUriOwnership and
 * is backed internally by connectionManager.onConnectionsChanged.
 */
async function setupMssqlConnectionListener(
    context: ExtensionContext,
): Promise<void> {
    const api = await getMssqlApi();
    if (!api?.uriOwnershipApi?.onDidChangeUriOwnership) {
        return;
    }

    const ownershipEvent = api.uriOwnershipApi.onDidChangeUriOwnership;
    context.subscriptions.push(
        ownershipEvent(() => {
            // Debounce to absorb mssql connection transition bursts.
            if (connectionSyncDebounce) {
                clearTimeout(connectionSyncDebounce);
            }
            connectionSyncDebounce = setTimeout(async () => {
                connectionSyncDebounce = undefined;
                await syncMssqlConnection(true);
            }, 600);
        }),
    );
}

function setupMssqlApiLifetime(context: ExtensionContext): void {
    context.subscriptions.push({
        dispose: () => {
            mssqlApiPromise = undefined;
        },
    });
}

export async function activate(context: ExtensionContext) {
    console.log("SQL Prompt: extension activating...");
    setupMssqlApiLifetime(context);

    const serverModule = context.asAbsolutePath(
        path.join("server", "dist", "server.js"),
    );

    const debugOptions = { execArgv: ["--nolazy", "--inspect-brk=6009"] };

    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            options: debugOptions,
        },
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            { scheme: "file", language: "sql" },
            { scheme: "untitled", language: "sql" },
        ],
        synchronize: {
            configurationSection: "sqlPrompt",
        },
        outputChannelName: "SQL Prompt",
        revealOutputChannelOn: RevealOutputChannelOn.Info,
    };

    // forceDebug: when running in development mode, always start the language
    // server with --inspect=6009 regardless of process.execArgv. This is needed
    // because modern VS Code may not expose --inspect-brk in the extension host's
    // execArgv, which would otherwise prevent the debug server options from being
    // used and make "Attach to Server" fail to find anything on port 6009.
    const forceDebug = context.extensionMode === ExtensionMode.Development;
    client = new LanguageClient(
        "sqlPrompt",
        "SQL Prompt Language Server",
        serverOptions,
        clientOptions,
        forceDebug,
    );

    context.subscriptions.push(
        // Connect: triggers the mssql connect dialog for the current file, then
        // syncs the resulting connection to our language server.
        commands.registerCommand("sqlPrompt.connect", async () => {
            const editor = window.activeTextEditor;
            if (!editor || editor.document.languageId !== "sql") {
                window.showWarningMessage(
                    "SQL Prompt: open a .sql file first.",
                );
                return;
            }

            if (!extensions.getExtension("ms-mssql.mssql")) {
                window.showErrorMessage(
                    "SQL Prompt: the ms-mssql.mssql extension is required. Please install it.",
                );
                return;
            }

            // Let the user connect through the standard mssql dialog
            await commands.executeCommand("mssql.connect");

            // Give the mssql extension a moment to complete the connection, then sync
            setTimeout(() => syncMssqlConnection(), 2000);
        }),

        commands.registerCommand("sqlPrompt.disconnect", async () => {
            if (client) {
                await client.sendRequest("sqlPrompt/disconnect");
                window.showInformationMessage("SQL Prompt: disconnected.");
            }
        }),

        // Manually force a schema reload from the currently active mssql connection.
        commands.registerCommand("sqlPrompt.reloadSchema", async () => {
            const editor = window.activeTextEditor;
            if (!editor || editor.document.languageId !== "sql") {
                window.showWarningMessage(
                    "SQL Prompt: open a .sql file first.",
                );
                return;
            }

            const reloaded = await syncMssqlConnection(true);
            if (!reloaded) {
                window.showWarningMessage(
                    "SQL Prompt: no active mssql connection found. " +
                    "Connect the file via the mssql extension first.",
                );
            }
        }),

        // Auto-sync whenever the user switches to a different SQL file
        window.onDidChangeActiveTextEditor(async (editor) => {
            if (editor && editor.document.languageId === "sql") {
                await syncMssqlConnection();
            }
        }),
    );

    await client.start();
    console.log("SQL Prompt: language server started.");

    // Subscribe to mssql connection changes so the schema reloads automatically
    // whenever the user connects/disconnects/switches connection in mssql.
    await setupMssqlConnectionListener(context);

    // Sync connection for the editor that is already open when the extension activates
    setTimeout(() => syncMssqlConnection(), 1500);
}

export async function deactivate() {
    mssqlApiPromise = undefined;
    if (client) {
        await client.stop();
        client = undefined;
    }
}
