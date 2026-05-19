import * as path from 'path';
import {
    ExtensionContext,
    ExtensionMode,
    commands,
    window,
    extensions,
    Uri,
    workspace,
    ConfigurationTarget,
    languages,
    Location,
    Range,
    EventEmitter,
    TextDocumentContentProvider,
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
let mssqlIntellisenseSuppressed = false;

// ── Go to Definition state ────────────────────────────────────────────────────
let lastOwnerUri: string | undefined;
let lastTablesSnapshot: TableInfo[] = [];
const definitionScriptCache = new Map<string, string>();
const onDefinitionContentChange = new EventEmitter<Uri>();

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

type RoutineParameterInfo = {
    name: string;
    dataType: string;
    maxLength: number | null;
    precision: number | null;
    scale: number | null;
    isOutput: boolean;
    hasDefaultValue: boolean;
};

type ScalarFunctionInfo = {
    schema: string;
    name: string;
    parameters: RoutineParameterInfo[];
};

type TableValuedFunctionInfo = {
    schema: string;
    name: string;
    parameters: RoutineParameterInfo[];
};

type StoredProcedureInfo = {
    schema: string;
    name: string;
    parameters: RoutineParameterInfo[];
};

type SchemaSnapshot = {
    tables: TableInfo[];
    scalarFunctions: ScalarFunctionInfo[];
    tableValuedFunctions: TableValuedFunctionInfo[];
    storedProcedures: StoredProcedureInfo[];
};

function getSchemaObjectCount(snapshot: SchemaSnapshot): number {
    return (
        snapshot.tables.length +
        snapshot.scalarFunctions.length +
        snapshot.tableValuedFunctions.length +
        snapshot.storedProcedures.length
    );
}

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
        return raw.trim();
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

function mapRowsToRoutineSnapshot(rows: any[]): Omit<SchemaSnapshot, "tables"> {
    type RoutineEntry = {
        schema: string;
        name: string;
        objectType: string;
        parameters: RoutineParameterInfo[];
    };

    const routineMap = new Map<string, RoutineEntry>();

    for (const row of rows) {
        const schema = normalizeText(row.schema_name);
        const name = normalizeText(row.routine_name);
        const objectType = normalizeText(row.object_type);
        if (!schema || !name || !objectType) {
            continue;
        }

        const key = `${schema}.${name}::${objectType}`;
        if (!routineMap.has(key)) {
            routineMap.set(key, {
                schema,
                name,
                objectType,
                parameters: [],
            });
        }

        const parameterName = normalizeText(row.parameter_name);
        if (parameterName) {
            const maxLengthRaw = normalizeCellValue(row.max_length);
            const precisionRaw = normalizeCellValue(row.precision);
            const scaleRaw = normalizeCellValue(row.scale);
            const isOutputRaw = normalizeCellValue(row.is_output);
            const hasDefaultRaw = normalizeCellValue(row.has_default_value);

            routineMap.get(key)!.parameters.push({
                name: parameterName,
                dataType: normalizeText(row.data_type) ?? "unknown",
                maxLength: typeof maxLengthRaw === "number" ? maxLengthRaw : null,
                precision: typeof precisionRaw === "number" ? precisionRaw : null,
                scale: typeof scaleRaw === "number" ? scaleRaw : null,
                isOutput: isOutputRaw === true || isOutputRaw === 1,
                hasDefaultValue: hasDefaultRaw === true || hasDefaultRaw === 1,
            });
        }
    }

    const scalarFunctions: ScalarFunctionInfo[] = [];
    const tableValuedFunctions: TableValuedFunctionInfo[] = [];
    const storedProcedures: StoredProcedureInfo[] = [];

    for (const routine of routineMap.values()) {
        if (routine.objectType === "FN" || routine.objectType === "FS" || routine.objectType === "FT") {
            scalarFunctions.push({
                schema: routine.schema,
                name: routine.name,
                parameters: routine.parameters,
            });
            continue;
        }

        if (routine.objectType === "IF" || routine.objectType === "TF") {
            tableValuedFunctions.push({
                schema: routine.schema,
                name: routine.name,
                parameters: routine.parameters,
            });
            continue;
        }

        if (routine.objectType === "P" || routine.objectType === "PC") {
            storedProcedures.push({
                schema: routine.schema,
                name: routine.name,
                parameters: routine.parameters,
            });
        }
    }

    console.log(`[SQL Prompt] Routines parsed: ${scalarFunctions.length} scalar, ${tableValuedFunctions.length} TVF, ${storedProcedures.length} procedures`);

    return { scalarFunctions, tableValuedFunctions, storedProcedures };
}

async function loadSchemaViaConnectionSharing(ownerUri: string): Promise<SchemaSnapshot | undefined> {
    const api = await getMssqlApi();
    if (!api?.connectionSharing) {
        return undefined;
    }

    const schemaQuery = `
            WITH schema_objects AS (
                SELECT
                    o.object_id,
                    o.schema_id,
                    o.name,
                    o.type
                FROM sys.objects o
                WHERE o.type IN ('U', 'V')
                    AND o.is_ms_shipped = 0
            )
            SELECT
                s.name AS schema_name,
                so.name AS table_name,
                c.name AS column_name,
                ty.name AS data_type,
                c.max_length,
                c.is_nullable,
                CASE WHEN so.type = 'U' AND pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS is_primary_key
            FROM schema_objects so
            INNER JOIN sys.schemas s ON so.schema_id = s.schema_id
            INNER JOIN sys.columns c ON so.object_id = c.object_id
            INNER JOIN sys.types ty ON c.user_type_id = ty.user_type_id
            LEFT JOIN (
                SELECT ic.object_id, ic.column_id
                FROM sys.index_columns ic
                INNER JOIN sys.indexes i ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                WHERE i.is_primary_key = 1
            ) pk ON so.object_id = pk.object_id AND c.column_id = pk.column_id
            ORDER BY s.name, so.name, c.column_id
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

    const routinesQuery = `
                        SELECT
                                s.name AS schema_name,
                                o.name AS routine_name,
                                o.type AS object_type,
                                p.parameter_id,
                                p.name AS parameter_name,
                                ty.name AS data_type,
                                p.max_length,
                                p.precision,
                                p.scale,
                                p.is_output,
                                p.has_default_value
                        FROM sys.objects o
                        INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                        LEFT JOIN sys.parameters p ON o.object_id = p.object_id AND p.parameter_id > 0
                        LEFT JOIN sys.types ty ON p.user_type_id = ty.user_type_id
                        WHERE o.type IN ('FN', 'FS', 'FT', 'IF', 'TF', 'P', 'PC')
                            AND o.is_ms_shipped = 0
                        ORDER BY s.name, o.name, p.parameter_id
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
        let routinesResult: any;
        try {
            routinesResult = await api.connectionSharing.executeSimpleQuery?.(
                ownerUri,
                routinesQuery,
            );
        } catch {
            routinesResult = undefined;
        }

        const rows = extractRowsFromSimpleQueryResult(result);
        const fkRows = extractRowsFromSimpleQueryResult(fkResult);
        const routineRows = extractRowsFromSimpleQueryResult(routinesResult);

        console.log(`[SQL Prompt] Schema rows: ${rows.length}, FK rows: ${fkRows.length}, Routine rows: ${routineRows.length}`);

        const schemaTables = mapRowsToSchemaSnapshot(rows);
        const foreignKeys = mapRowsToForeignKeys(fkRows);
        const routineSnapshot = mapRowsToRoutineSnapshot(routineRows);

        console.log(`[SQL Prompt] Routines loaded: ${routineSnapshot.scalarFunctions.length} scalar, ${routineSnapshot.tableValuedFunctions.length} TVF, ${routineSnapshot.storedProcedures.length} procedures`);

        return {
            tables: attachForeignKeysToTables(schemaTables, foreignKeys),
            scalarFunctions: routineSnapshot.scalarFunctions,
            tableValuedFunctions: routineSnapshot.tableValuedFunctions,
            storedProcedures: routineSnapshot.storedProcedures,
        };
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
async function suppressMssqlIntellisense(): Promise<void> {
    if (mssqlIntellisenseSuppressed) {
        return;
    }
    const sqlPromptConfig = workspace.getConfiguration("sqlPrompt");
    const shouldSuppress = sqlPromptConfig.get<boolean>("suppressMssqlIntellisense", true);
    if (!shouldSuppress) {
        return;
    }
    try {
        await workspace.getConfiguration("mssql").update(
            "intelliSense.enableSuggestions",
            false,
            ConfigurationTarget.Workspace,
        );
        mssqlIntellisenseSuppressed = true;
    } catch {
        // Setting may not exist in older versions of the mssql extension — ignore
    }
}

async function restoreMssqlIntellisense(): Promise<void> {
    if (!mssqlIntellisenseSuppressed) {
        return;
    }
    try {
        // Removing the workspace-level override restores the user/default value
        await workspace.getConfiguration("mssql").update(
            "intelliSense.enable",
            undefined,
            ConfigurationTarget.Workspace,
        );
        mssqlIntellisenseSuppressed = false;
    } catch {
        // Ignore
    }
}

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

    // Keep a local copy for Go to Definition (CREATE TABLE generation for tables)
    lastOwnerUri = ownerUri;
    lastTablesSnapshot = schemaSnapshot.tables;

    try {
        const objectCount = getSchemaObjectCount(schemaSnapshot);

        const result = await client.sendRequest<{
            success: boolean;
            tableCount: number;
        }>("sqlPrompt/updateSchemaSnapshot", {
            tables: schemaSnapshot.tables,
            scalarFunctions: schemaSnapshot.scalarFunctions,
            tableValuedFunctions: schemaSnapshot.tableValuedFunctions,
            storedProcedures: schemaSnapshot.storedProcedures,
        });

        if (!result?.success) {
            return false;
        }

        await suppressMssqlIntellisense();

        window.setStatusBarMessage(
            `SQL Prompt: schema loaded — ${objectCount} object(s)`,
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
                `SQL Prompt: connected${dbDetail} — ${objectCount} object(s) loaded`,
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

// ── Go to Definition helpers ──────────────────────────────────────────────────

function formatColumnDataType(dataType: string, maxLength: number | null): string {
    const dt = dataType.toLowerCase();
    const varLenTypes = ['varchar', 'nvarchar', 'char', 'nchar', 'varbinary', 'binary'];
    if (varLenTypes.includes(dt) && maxLength !== null) {
        if (maxLength === -1) {
            return `${dataType}(MAX)`;
        }
        // nvarchar/nchar store max_length in bytes (2 bytes per Unicode char)
        const charLen = (dt === 'nvarchar' || dt === 'nchar') ? maxLength / 2 : maxLength;
        return `${dataType}(${charLen})`;
    }
    return dataType;
}

function generateCreateTableScript(table: TableInfo): string {
    const colDefs = table.columns.map(c => {
        const typeDef = formatColumnDataType(c.dataType, c.maxLength);
        const nullability = c.isNullable ? 'NULL' : 'NOT NULL';
        return `    [${c.name}] ${typeDef} ${nullability}`;
    });

    const pkCols = table.columns.filter(c => c.isPrimaryKey);
    if (pkCols.length > 0) {
        colDefs.push(
            `    CONSTRAINT [PK_${table.name}] PRIMARY KEY (${pkCols.map(c => `[${c.name}]`).join(', ')})`,
        );
    }

    return `CREATE TABLE [${table.schema}].[${table.name}] (\n${colDefs.join(',\n')}\n);`;
}

/**
 * Resolves the qualified SQL identifier (e.g. `dbo.MyTable`, `[MyTable]`)
 * at the given cursor column in a line of text.
 * Returns `{ name, schema? }` or null if no identifier is found.
 */
function resolveIdentifierAtColumn(
    line: string,
    col: number,
): { name: string; schema?: string } | null {
    // Regex matches: optional [schema]. or schema. prefix, then [name] or name
    const pattern = /(?:(\[[\w\s]+\]|\w+)\.)?(\[[\w\s]+\]|\w+)/g;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(line)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (col >= start && col <= end) {
            const rawSchema = match[1];
            const rawName = match[2];
            const name = rawName.replace(/^\[|\]$/g, '');
            const schema = rawSchema ? rawSchema.replace(/^\[|\]$/g, '') : undefined;
            // Skip pure schema-only token (when cursor is on the schema part)
            if (rawSchema && col < start + rawSchema.length) {
                return null;
            }
            return { name, schema };
        }
    }
    return null;
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
                await restoreMssqlIntellisense();
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

    // ── Schema Loading Notifications ──────────────────────────────────────────
    client.onNotification("sqlPrompt/schemaLoadingStarted", (params: any) => {
        const message = params.message || `Loading schema from ${params.server}/${params.database}...`;
        window.showInformationMessage(message);
    });

    client.onNotification("sqlPrompt/schemaLoadingCompleted", (params: any) => {
        const tableCount = params.tableCount ?? 0;
        const scalarFunctionCount = params.scalarFunctionCount ?? 0;
        const tableValuedFunctionCount = params.tableValuedFunctionCount ?? 0;
        const storedProcedureCount = params.storedProcedureCount ?? 0;
        const message = `Schema loaded: ${tableCount} tables, ${scalarFunctionCount} scalar functions, ${tableValuedFunctionCount} table-valued functions, ${storedProcedureCount} stored procedures.`;
        window.showInformationMessage(message);
    });

    client.onNotification("sqlPrompt/schemaLoadingFailed", (params: any) => {
        window.showErrorMessage(`SQL Prompt: schema loading failed — ${params.error}`);
    });

    // ── Go to Definition ──────────────────────────────────────────────────────

    // Virtual document provider for object definition scripts
    const defContentProvider: TextDocumentContentProvider = {
        onDidChange: onDefinitionContentChange.event,
        provideTextDocumentContent(uri: Uri): string {
            return definitionScriptCache.get(uri.toString()) ?? '-- Script not available';
        },
    };
    context.subscriptions.push(
        workspace.registerTextDocumentContentProvider('sqlprompt-def', defContentProvider),
    );

    // DefinitionProvider: F12 on tables, views, procedures, functions
    const sqlDocumentSelector = [
        { scheme: 'file', language: 'sql' },
        { scheme: 'untitled', language: 'sql' },
    ];
    context.subscriptions.push(
        languages.registerDefinitionProvider(sqlDocumentSelector, {
            async provideDefinition(document, position) {
                if (!client) { return null; }

                const line = document.lineAt(position.line).text;
                const col = position.character;
                const ident = resolveIdentifierAtColumn(line, col);
                if (!ident) { return null; }

                type ResolvedObject = {
                    schema: string;
                    name: string;
                    kind: 'tableOrView' | 'procedure' | 'scalarFunction' | 'tableValuedFunction';
                    columns?: Array<{
                        name: string;
                        dataType: string;
                        maxLength: number | null;
                        isNullable: boolean;
                        isPrimaryKey: boolean;
                    }>;
                };

                let resolved: ResolvedObject | null = null;
                try {
                    resolved = await client.sendRequest<ResolvedObject | null>(
                        'sqlPrompt/resolveObject',
                        { name: ident.name, schema: ident.schema },
                    );
                } catch {
                    return null;
                }
                if (!resolved) { return null; }

                let script: string | null = null;

                // Primary path: fetch script via mssql connectionSharing
                const ownerUri = lastOwnerUri ?? document.uri.toString();
                const api = await getMssqlApi();
                if (api?.connectionSharing) {
                    try {
                        const schemaEsc = resolved.schema.replace(/'/g, "''");
                        const nameEsc = resolved.name.replace(/'/g, "''");
                        const scriptQuery = `
                            SELECT sm.definition
                            FROM sys.sql_modules sm
                            INNER JOIN sys.objects o ON sm.object_id = o.object_id
                            INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                            WHERE s.name = N'${schemaEsc}' AND o.name = N'${nameEsc}'
                        `;
                        const result = await api.connectionSharing.executeSimpleQuery?.(
                            ownerUri,
                            scriptQuery,
                        );
                        const rows = extractRowsFromSimpleQueryResult(result);
                        if (rows.length > 0) {
                            script = normalizeText(rows[0].definition) ?? null;
                        }
                    } catch {
                        // fallthrough to other strategies
                    }
                }

                // Secondary path: ask the server (works in direct-connection mode)
                if (script === null) {
                    try {
                        const res = await client.sendRequest<{ script: string | null }>(
                            'sqlPrompt/getObjectScript',
                            { schema: resolved.schema, name: resolved.name },
                        );
                        script = res?.script ?? null;
                    } catch {
                        // ignore
                    }
                }

                // For tables (no sql_modules entry): generate CREATE TABLE from snapshot
                if (script === null && resolved.kind === 'tableOrView') {
                    // Prefer server-returned columns; fall back to local snapshot
                    const columns = resolved.columns ?? lastTablesSnapshot.find(
                        t => t.schema.toLowerCase() === resolved!.schema.toLowerCase() &&
                             t.name.toLowerCase() === resolved!.name.toLowerCase(),
                    )?.columns;

                    if (columns) {
                        const tableInfo: TableInfo = {
                            schema: resolved.schema,
                            name: resolved.name,
                            columns,
                            foreignKeys: [],
                        };
                        script = generateCreateTableScript(tableInfo);
                    }
                }

                if (!script) {
                    window.showWarningMessage(
                        `SQL Prompt: definition not available for [${resolved.schema}].[${resolved.name}].`,
                    );
                    return null;
                }

                // Store script in cache and return a Location pointing to the virtual doc
                const virtualUri = Uri.from({
                    scheme: 'sqlprompt-def',
                    authority: 'definition',
                    path: `/${encodeURIComponent(resolved.schema)}/${encodeURIComponent(resolved.name)}.sql`,
                });
                definitionScriptCache.set(virtualUri.toString(), script);
                onDefinitionContentChange.fire(virtualUri);

                return new Location(virtualUri, new Range(0, 0, 0, 0));
            },
        }),
    );

    // ─────────────────────────────────────────────────────────────────────────

    // Subscribe to mssql connection changes so the schema reloads automatically
    // whenever the user connects/disconnects/switches connection in mssql.
    await setupMssqlConnectionListener(context);

    // Sync connection for the editor that is already open when the extension activates
    setTimeout(() => syncMssqlConnection(), 1500);
}

export async function deactivate() {
    mssqlApiPromise = undefined;
    await restoreMssqlIntellisense();
    if (client) {
        await client.stop();
        client = undefined;
    }
}
