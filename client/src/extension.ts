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
    StatusBarAlignment,
    StatusBarItem,
    ProgressLocation,
} from "vscode";

import {
    LanguageClient,
    LanguageClientOptions,
    RevealOutputChannelOn,
    ServerOptions,
    TransportKind,
} from "vscode-languageclient/node";

import { loadStylesFromFolder, LoadedStyle } from './formatter/styleLoader';
import { SqlFormattingProvider } from './formatter/sqlFormattingProvider';
import { SchemaDiskCache, SchemaToken } from './schema/schemaCache';
import { CompletionUsageStore, usageDatabaseKey } from './schema/usageStore';
import {
    QueryRunner,
    loadColumns,
    loadCrossDatabaseSchema,
    loadDatabases,
    loadForeignKeys,
    loadObjects,
    loadRoutines,
    loadSchemaToken,
    queryFirstCellText,
} from './schema/schemaLoad';
import {
    WireColumns,
    WireForeignKey,
    WireRoutine,
    WireSnapshot,
} from './schema/wireFormat';

let client: LanguageClient | undefined;
let connectionSyncDebounce: ReturnType<typeof setTimeout> | undefined;
let databaseCheckDebounce: ReturnType<typeof setTimeout> | undefined;
let mssqlApiPromise: Promise<any | undefined> | undefined;
let mssqlIntellisenseSuppressed = false;
const SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;

/** Tracks the database that was active when the schema was last synced, keyed by ownerUri. */
const lastSyncedDatabasePerUri = new Map<string, string>();

// ── Go to Definition state ────────────────────────────────────────────────────
let lastOwnerUri: string | undefined;
const definitionScriptCache = new Map<string, string>();
const onDefinitionContentChange = new EventEmitter<Uri>();
const inFlightSchemaSyncs = new Map<string, Promise<boolean>>();

// ── Formatting state ──────────────────────────────────────────────────────────
let loadedStyles: LoadedStyle[] = [];
let formatterStatusBarItem: StatusBarItem | undefined;

/**
 * The columns of a table, as `sqlPrompt/resolveObject` reports them.
 *
 * This is all the schema detail the extension host still holds: it is needed to
 * generate a `CREATE TABLE` for Go to Definition, since a table has no
 * `sys.sql_modules` entry to script. Everything else about the schema lives in
 * the language server.
 */
type ResolvedColumn = {
    name: string;
    dataType: string;
    maxLength: number | null;
    isNullable: boolean;
    isPrimaryKey: boolean;
};


/**
 * In-memory snapshot cache, keyed by connection and database.
 *
 * First of two cache levels. A hit here short-circuits the entire sync — not
 * even the change-detection query runs — which is what makes switching between
 * `.sql` files on the same connection free. The second level is
 * `SchemaDiskCache`: it survives a window reload, and it is validated against
 * the database itself rather than against a clock.
 */
const schemaSnapshotCache = new Map<
    string,
    {
        snapshot: WireSnapshot;
        cachedAt: number;
        /** Identity of the database the snapshot came from, when it was known. */
        token?: SchemaToken;
    }
>();

/** Second-level cache. Created in `activate`, once the storage URI is known. */
let schemaDiskCache: SchemaDiskCache | undefined;

/**
 * The snapshot the language server is currently holding.
 *
 * Switching between `.sql` files on the same connection is the most frequent
 * sync of all, and it always hits the in-memory cache. Without this, each of
 * those hits would re-serialise the whole schema over the LSP connection to
 * tell the server something it already knows.
 */
let publishedSnapshot: WireSnapshot | undefined;

// ── Completion usage history ──────────────────────────────────────────────────

/** What the user has accepted before, per database. Created in `activate`. */
let usageStore: CompletionUsageStore | undefined;

/** Which database the accepted completions belong to, from the schema token. */
let usageDatabase: string | undefined;

/** Coalesces the persist-and-publish that follows each accepted completion. */
let usageFlushDebounce: ReturnType<typeof setTimeout> | undefined;

/**
 * Sends the decayed usage history for `usageDatabase` to the language server.
 *
 * Called after a schema sync — so a fresh server process is ranking with the
 * history from the start — and after an accepted completion has been recorded.
 */
async function publishUsageScores(): Promise<void> {
    if (!client || !usageStore || !usageDatabase) {
        return;
    }
    try {
        await client.sendRequest('sqlPrompt/updateUsageScores', {
            entries: usageStore.scores(usageDatabase),
        });
    } catch (err: any) {
        console.error(`[SQL Prompt] updateUsageScores failed: ${err?.message ?? err}`);
    }
}

/**
 * Records one accepted completion and schedules the follow-up work.
 *
 * Persisting to `globalState` and re-publishing on every keystroke-accepted
 * item would be wasteful, and the ranking does not need to change until the
 * next completion request, so both are debounced.
 */
function recordCompletionUse(objectKey: unknown): void {
    if (typeof objectKey !== 'string' || !objectKey || !usageStore || !usageDatabase) {
        return;
    }

    usageStore.record(usageDatabase, objectKey);

    if (usageFlushDebounce) {
        clearTimeout(usageFlushDebounce);
    }
    usageFlushDebounce = setTimeout(async () => {
        usageFlushDebounce = undefined;
        await usageStore?.persist();
        await publishUsageScores();
    }, 1500);
}

/** Number of schema objects in a snapshot, for the status message. */
function getSchemaObjectCount(snapshot: WireSnapshot): number {
    return snapshot.objects.length;
}

function buildSchemaCacheKey(connectionId: string, database: string | undefined): string {
    return `${connectionId.toLowerCase()}::${(database ?? "").toLowerCase()}`;
}

function getCachedSchemaSnapshot(
    cacheKey: string,
): { snapshot: WireSnapshot; token?: SchemaToken } | undefined {
    const cachedEntry = schemaSnapshotCache.get(cacheKey);
    if (!cachedEntry) {
        return undefined;
    }

    if (Date.now() - cachedEntry.cachedAt > SCHEMA_CACHE_TTL_MS) {
        schemaSnapshotCache.delete(cacheKey);
        return undefined;
    }

    return { snapshot: cachedEntry.snapshot, token: cachedEntry.token };
}

function setCachedSchemaSnapshot(
    cacheKey: string,
    snapshot: WireSnapshot,
    token?: SchemaToken,
): void {
    schemaSnapshotCache.set(cacheKey, {
        snapshot,
        cachedAt: Date.now(),
        token,
    });
}

// Our extension's identifier as published — used by the mssql connectionSharing
// API so the permission dialog shows "SQL Prompt" and the approval is persisted.
// Must match `publisher`.`name` from package.json: mssql resolves the caller by
// this id, and a wrong one makes getActiveDatabase / getActiveEditorConnectionId
// return undefined, which silently disables the schema cache and the detection
// of a database change.
const EXTENSION_ID = "borile91.vscode-sqlprompt";

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

// ── Publishing the schema to the language server ──────────────────────────────

/**
 * Publishes stage 0: the object names, replacing whatever the server had.
 *
 * This is the payload that makes the extension useful — table completion after
 * `FROM` / `JOIN` / `INSERT INTO` needs nothing else — and it is also by far
 * the smallest, a couple of thousand rows even on a large database.
 */
async function publishSchemaObjects(snapshot: WireSnapshot): Promise<boolean> {
    if (!client) {
        return false;
    }
    try {
        const result = await client.sendRequest<{ success: boolean }>(
            "sqlPrompt/setSchemaObjects",
            {
                objects: snapshot.objects,
                databases: snapshot.databases,
                database: snapshot.database,
            },
        );
        return result?.success === true;
    } catch (err: any) {
        console.error(`[SQL Prompt] setSchemaObjects failed: ${err?.message ?? err}`);
        return false;
    }
}

/** Publishes one or more of the later stages, merging them into stage 0. */
async function publishSchemaDetails(details: {
    columns?: WireColumns[];
    foreignKeys?: WireForeignKey[];
    routines?: WireRoutine[];
}): Promise<void> {
    if (!client) {
        return;
    }
    try {
        await client.sendRequest("sqlPrompt/mergeSchemaDetails", details);
    } catch (err: any) {
        console.error(`[SQL Prompt] mergeSchemaDetails failed: ${err?.message ?? err}`);
    }
}

/**
 * Republishes a complete snapshot. Used when one is restored from a cache.
 *
 * Publishing the snapshot the server already holds is a no-op, so it is skipped
 * rather than paid for.
 */
async function publishCachedSnapshot(snapshot: WireSnapshot): Promise<boolean> {
    if (publishedSnapshot === snapshot) {
        return true;
    }
    if (!(await publishSchemaObjects(snapshot))) {
        return false;
    }
    await publishSchemaDetails({
        columns: snapshot.columns,
        foreignKeys: snapshot.foreignKeys,
        routines: snapshot.routines,
    });
    publishedSnapshot = snapshot;
    return true;
}

/**
 * Runs the staged load, publishing each stage the moment it lands.
 *
 * Stage 0 is published before anything expensive starts, so the user can type
 * against the schema while the rest is still loading.
 *
 * A stage that fails is logged and skipped rather than aborting the load:
 * losing the foreign keys costs the `ON` suggestions, not the whole schema.
 * `undefined` comes back only when stage 0 itself could not be published,
 * because then there is nothing to cache and nothing to report.
 */
async function loadSchemaStaged(
    runner: QueryRunner,
    ownerUri: string,
    database: string | undefined,
    report: (message: string) => void,
): Promise<WireSnapshot | undefined> {
    report("objects…");
    const objects = await loadObjects(runner, ownerUri);
    const databases = await loadDatabases(runner, ownerUri);

    const snapshot: WireSnapshot = {
        objects,
        columns: [],
        foreignKeys: [],
        routines: [],
        databases,
        database,
    };

    if (!(await publishSchemaObjects(snapshot))) {
        return undefined;
    }
    publishedSnapshot = snapshot;
    console.log(
        `[SQL Prompt] stage 0: ${objects.length} object(s), ${databases.length} database(s)`,
    );

    report("columns…");
    try {
        snapshot.columns = await loadColumns(runner, ownerUri);
        await publishSchemaDetails({ columns: snapshot.columns });
        console.log(`[SQL Prompt] stage 1: columns for ${snapshot.columns.length} object(s)`);
    } catch (err: any) {
        console.error(`[SQL Prompt] stage 1 (columns) failed: ${err?.message ?? err}`);
    }

    report("relationships…");
    try {
        snapshot.foreignKeys = await loadForeignKeys(runner, ownerUri);
        await publishSchemaDetails({ foreignKeys: snapshot.foreignKeys });
        console.log(`[SQL Prompt] stage 2: ${snapshot.foreignKeys.length} foreign key(s)`);
    } catch (err: any) {
        console.error(`[SQL Prompt] stage 2 (foreign keys) failed: ${err?.message ?? err}`);
    }

    report("routine signatures…");
    try {
        snapshot.routines = await loadRoutines(runner, ownerUri);
        await publishSchemaDetails({ routines: snapshot.routines });
        console.log(`[SQL Prompt] stage 3: ${snapshot.routines.length} routine(s)`);
    } catch (err: any) {
        console.error(`[SQL Prompt] stage 3 (routines) failed: ${err?.message ?? err}`);
    }

    return snapshot;
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

/**
 * Polls the mssql extension for the currently active database.
 * If it differs from the last synced database for the active SQL editor,
 * triggers a full schema re-sync (e.g. after the user executes USE <db>).
 */
async function checkForDatabaseChange(): Promise<void> {
    const editor = window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') {
        return;
    }

    const api = await getMssqlApi();
    if (!api?.connectionSharing) {
        return;
    }

    const ownerUri = editor.document.uri.toString();

    try {
        const isConnected = await api.connectionSharing.isConnected?.(ownerUri);
        if (!isConnected) {
            return;
        }

        const activeDatabase = await api.connectionSharing.getActiveDatabase?.(EXTENSION_ID);
        const lastDatabase = lastSyncedDatabasePerUri.get(ownerUri);

        if (activeDatabase && lastDatabase !== undefined && activeDatabase !== lastDatabase) {
            console.log(`[SQL Prompt] Database changed: ${lastDatabase} → ${activeDatabase}, re-syncing schema.`);
            await syncMssqlConnection();
        }
    } catch {
        // API may be unavailable — ignore
    }
}

/**
 * Brings the language server's schema up to date with the mssql connection of
 * the active SQL editor.
 *
 * Three paths, cheapest first:
 *
 *  1. **In-memory cache** — same connection and database, seen within the last
 *     few minutes. Publishes immediately and runs no query at all.
 *  2. **Disk cache** — one small change-detection query decides whether the
 *     stored snapshot still describes the database. This is the path a window
 *     reload takes, and the reason reopening VS Code no longer costs a full
 *     reload on an unchanged database.
 *  3. **Staged load** — object names first, then columns, foreign keys and
 *     routine signatures, each published as it lands.
 *
 * `force` skips both caches; that is what `SQL Prompt: Reload Schema` needs in
 * order to pick up a change the token cannot see, such as a renamed column.
 */
async function syncMssqlConnection(
    options: { showNotification?: boolean; force?: boolean } = {},
): Promise<boolean> {
    const { showNotification = false, force = false } = options;

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

    // Several events can ask for the same URI at once (editor switch, ownership
    // change, the activation timer). A forced reload is the one case that has to
    // run even so, because the user asked for it explicitly.
    const existingSync = inFlightSchemaSyncs.get(ownerUri);
    if (existingSync && !force) {
        return existingSync;
    }

    if (force) {
        publishedSnapshot = undefined;
    }

    let syncPromise!: Promise<boolean>;
    syncPromise = (async (): Promise<boolean> => {
        try {
            const runner = api.connectionSharing as QueryRunner;

            try {
                const isConnected = await api.connectionSharing.isConnected?.(ownerUri);
                if (!isConnected) {
                    console.log(
                        "SQL Prompt: syncMssqlConnection — active SQL file is not connected in mssql",
                    );
                    return false;
                }
            } catch {
                return false;
            }

            // The connection id and database name key the in-memory cache, and
            // the database name lets checkForDatabaseChange() notice a later USE.
            let activeConnectionId: string | undefined;
            let activeDatabase: string | undefined;
            try {
                activeConnectionId = await api.connectionSharing.getActiveEditorConnectionId?.(
                    EXTENSION_ID,
                );
                if (activeConnectionId) {
                    activeDatabase = await api.connectionSharing.getActiveDatabase?.(EXTENSION_ID);
                    if (!activeDatabase) {
                        activeDatabase = await api.connectionSharing.getDatabaseForConnectionId?.(
                            EXTENSION_ID,
                            activeConnectionId,
                        );
                    }
                }
            } catch {
                activeConnectionId = undefined;
                activeDatabase = undefined;
            }

            const cacheKey = activeConnectionId
                ? buildSchemaCacheKey(activeConnectionId, activeDatabase)
                : undefined;

            /** Bookkeeping and user feedback for a snapshot that went through. */
            const announce = (snapshot: WireSnapshot, fromCache: boolean): boolean => {
                lastOwnerUri = ownerUri;
                if (activeDatabase !== undefined) {
                    lastSyncedDatabasePerUri.set(ownerUri, activeDatabase);
                }
                void suppressMssqlIntellisense();

                const objectCount = getSchemaObjectCount(snapshot);
                window.setStatusBarMessage(
                    fromCache
                        ? `SQL Prompt: schema restored from cache — ${objectCount} object(s)`
                        : `SQL Prompt: schema loaded — ${objectCount} object(s)`,
                    5000,
                );

                if (showNotification) {
                    const dbDetail = activeDatabase ? ` · ${activeDatabase}` : "";
                    window.showInformationMessage(
                        `SQL Prompt: connected${dbDetail} — ${objectCount} object(s) loaded`,
                    );
                }

                return true;
            };

            /** Points the usage history at the database now in play. */
            const adoptUsageDatabase = (identity: SchemaToken | undefined) => {
                usageDatabase = identity
                    ? usageDatabaseKey(identity.serverName, identity.databaseName)
                    : undefined;
            };

            // 1. In-memory cache.
            if (!force && cacheKey) {
                const cached = getCachedSchemaSnapshot(cacheKey);
                if (cached && (await publishCachedSnapshot(cached.snapshot))) {
                    adoptUsageDatabase(cached.token);
                    await publishUsageScores();
                    return announce(cached.snapshot, true);
                }
            }

            // The token both keys the disk cache and says whether its entry is
            // still valid. A failure here is not fatal: it only costs the cache.
            let token: SchemaToken | undefined;
            try {
                token = await loadSchemaToken(runner, ownerUri);
            } catch (err: any) {
                console.error(`[SQL Prompt] schema token query failed: ${err?.message ?? err}`);
            }

            adoptUsageDatabase(token);

            // 2. Disk cache.
            if (token && schemaDiskCache) {
                if (force) {
                    await schemaDiskCache.invalidate(token);
                } else {
                    const cached = await schemaDiskCache.read(token);
                    if (cached && (await publishCachedSnapshot(cached))) {
                        if (cacheKey) {
                            setCachedSchemaSnapshot(cacheKey, cached, token);
                        }
                        await publishUsageScores();
                        return announce(cached, true);
                    }
                }
            }

            // 3. Staged load.
            const snapshot = await window.withProgress(
                { location: ProgressLocation.Window, title: "SQL Prompt: loading schema" },
                (progress) =>
                    loadSchemaStaged(
                        runner,
                        ownerUri,
                        token?.databaseName ?? activeDatabase,
                        (message) => progress.report({ message }),
                    ),
            );

            if (!snapshot) {
                return false;
            }

            if (cacheKey) {
                setCachedSchemaSnapshot(cacheKey, snapshot, token);
            }

            await publishUsageScores();
            const announced = announce(snapshot, false);

            // Persisting is what makes the *next* window reload cheap, so it
            // must not delay this one: fire it off and let it finish on its own.
            if (token && schemaDiskCache) {
                void schemaDiskCache.write(token, snapshot);
            }

            return announced;
        } finally {
            const currentSync = inFlightSchemaSyncs.get(ownerUri);
            if (currentSync === syncPromise) {
                inFlightSchemaSyncs.delete(ownerUri);
            }
        }
    })();

    inFlightSchemaSyncs.set(ownerUri, syncPromise);
    return syncPromise;
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
                await syncMssqlConnection({ showNotification: true });
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

function generateCreateTableScript(
    schema: string,
    name: string,
    columns: ResolvedColumn[],
): string {
    const colDefs = columns.map(c => {
        const typeDef = formatColumnDataType(c.dataType, c.maxLength);
        const nullability = c.isNullable ? 'NULL' : 'NOT NULL';
        return `    [${c.name}] ${typeDef} ${nullability}`;
    });

    const pkCols = columns.filter(c => c.isPrimaryKey);
    if (pkCols.length > 0) {
        colDefs.push(
            `    CONSTRAINT [PK_${name}] PRIMARY KEY (${pkCols.map(c => `[${c.name}]`).join(', ')})`,
        );
    }

    return `CREATE TABLE [${schema}].[${name}] (\n${colDefs.join(',\n')}\n);`;
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
    schemaDiskCache = new SchemaDiskCache(context.globalStorageUri);
    usageStore = new CompletionUsageStore(context.globalState);

    const serverModule = context.asAbsolutePath(
        path.join("server", "dist", "server.js"),
    );

    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
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

    client = new LanguageClient(
        "sqlPrompt",
        "SQL Prompt Language Server",
        serverOptions,
        clientOptions,
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

        // Fired by an accepted completion item, never from the palette — which
        // is why it is not declared in package.json `contributes.commands`.
        commands.registerCommand(
            "sqlPrompt.recordCompletionUse",
            (objectKey: unknown) => recordCompletionUse(objectKey),
        ),

        commands.registerCommand("sqlPrompt.disconnect", async () => {
            if (client) {
                await client.sendRequest("sqlPrompt/disconnect");
                publishedSnapshot = undefined;
                schemaSnapshotCache.clear();
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

            const reloaded = await syncMssqlConnection({ showNotification: true, force: true });
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

        // Detect USE <database> execution: debounce on text changes so that after
        // the user runs a query the active database is checked and schema re-synced.
        workspace.onDidChangeTextDocument((event) => {
            if (event.document.languageId !== "sql") {
                return;
            }
            if (databaseCheckDebounce) {
                clearTimeout(databaseCheckDebounce);
            }
            databaseCheckDebounce = setTimeout(async () => {
                databaseCheckDebounce = undefined;
                await checkForDatabaseChange();
            }, 2000);
        }),

        // Also check when VS Code window regains focus (user ran query and switched back).
        window.onDidChangeWindowState((state) => {
            if (state.focused) {
                if (databaseCheckDebounce) {
                    clearTimeout(databaseCheckDebounce);
                }
                databaseCheckDebounce = setTimeout(async () => {
                    databaseCheckDebounce = undefined;
                    await checkForDatabaseChange();
                }, 500);
            }
        }),
    );

    await client.start();
    console.log("SQL Prompt: language server started.");

    // ── Schema Loading Notifications ──────────────────────────────────────────
    // Pending progress resolvers for cross-DB demand loads (keyed by db name).
    const pendingCrossDbProgress = new Map<string, () => void>();

    client.onNotification("sqlPrompt/schemaLoadingStarted", (params: any) => {
        if (params.database) {
            // Cross-DB demand load: show notification progress bar that stays
            // open until schemaLoadingCompleted (or Failed) resolves it.
            window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: `SQL Prompt: Loading [${params.database}]…`,
                    cancellable: false,
                },
                () =>
                    new Promise<void>((resolve) => {
                        pendingCrossDbProgress.set(
                            params.database.toLowerCase(),
                            resolve,
                        );
                    }),
            );
        } else {
            // Initial schema load (direct connection): use status bar.
            window.setStatusBarMessage(params.message || "Loading schema...");
        }
    });

    client.onNotification("sqlPrompt/schemaLoadingCompleted", (params: any) => {
        if (params.database) {
            // Resolve the pending progress bar for this database.
            const key = params.database.toLowerCase();
            pendingCrossDbProgress.get(key)?.();
            pendingCrossDbProgress.delete(key);
            const msg = params.message ?? `Schema loaded for ${params.database}`;
            window.showInformationMessage(`SQL Prompt: ${msg}`);
        } else {
            // Initial schema load: keep existing status-bar behaviour.
            const tableCount = params.tableCount ?? 0;
            const scalarFunctionCount = params.scalarFunctionCount ?? 0;
            const tableValuedFunctionCount = params.tableValuedFunctionCount ?? 0;
            const storedProcedureCount = params.storedProcedureCount ?? 0;
            const message =
                params.message ??
                `Schema loaded: ${tableCount} tables, ${scalarFunctionCount} scalar functions, ${tableValuedFunctionCount} table-valued functions, ${storedProcedureCount} stored procedures.`;
            window.setStatusBarMessage(message, 5000);
        }
    });

    client.onNotification("sqlPrompt/schemaLoadingFailed", (params: any) => {
        if (params.database) {
            const key = params.database.toLowerCase();
            pendingCrossDbProgress.get(key)?.();
            pendingCrossDbProgress.delete(key);
        }
        window.showErrorMessage(`SQL Prompt: schema loading failed — ${params.error}`);
    });

    client.onRequest("sqlPrompt/loadCrossDatabaseSchema", async (params: { database: string }) => {
        const ownerUri = window.activeTextEditor?.document.uri.toString();
        const api = await getMssqlApi();
        if (!ownerUri || !api?.connectionSharing) {
            return { objects: [], columns: [] };
        }
        try {
            return await loadCrossDatabaseSchema(
                api.connectionSharing as QueryRunner,
                ownerUri,
                params.database,
            );
        } catch (e: any) {
            console.error(`[SQL Prompt] loadCrossDatabaseSchema failed: ${e.message}`);
            return { objects: [], columns: [] };
        }
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
                    columns?: ResolvedColumn[];
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
                        script = await queryFirstCellText(
                            api.connectionSharing as QueryRunner,
                            ownerUri,
                            scriptQuery,
                        ) ?? null;
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
                    if (resolved.columns) {
                        script = generateCreateTableScript(
                            resolved.schema,
                            resolved.name,
                            resolved.columns,
                        );
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

    // ── Formatting ────────────────────────────────────────────────────────────

    const initialStylesFolder = workspace
        .getConfiguration('sqlPrompt.formatting')
        .get<string>('stylesFolder', '');
    if (initialStylesFolder) {
        loadedStyles = await loadStylesFromFolder(initialStylesFolder);
    }

    function getActiveStyle(): LoadedStyle | undefined {
        const name = workspace
            .getConfiguration('sqlPrompt.formatting')
            .get<string>('activeStyle', '');
        return loadedStyles.find(s => s.name === name);
    }

    function updateFormatterStatusBar(): void {
        if (!formatterStatusBarItem) { return; }
        const style = getActiveStyle();
        formatterStatusBarItem.text = style
            ? `$(symbol-string) ${style.name}`
            : `$(symbol-string) No SQL style`;
        formatterStatusBarItem.tooltip = style
            ? `SQL Prompt: formatting with "${style.name}" — click to change`
            : 'SQL Prompt: click to select a formatting style';
    }

    formatterStatusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, 90);
    formatterStatusBarItem.command = 'sqlPrompt.selectFormattingStyle';
    context.subscriptions.push(formatterStatusBarItem);

    context.subscriptions.push(
        languages.registerDocumentFormattingEditProvider(
            [{ scheme: 'file', language: 'sql' }, { scheme: 'untitled', language: 'sql' }],
            new SqlFormattingProvider(getActiveStyle),
        ),
        commands.registerCommand('sqlPrompt.selectFormattingStyle', async () => {
            const stylesFolder = workspace
                .getConfiguration('sqlPrompt.formatting')
                .get<string>('stylesFolder', '');
            if (stylesFolder) {
                loadedStyles = await loadStylesFromFolder(stylesFolder);
            }
            if (loadedStyles.length === 0) {
                window.showWarningMessage(
                    'SQL Prompt: no style files found. Set sqlPrompt.formatting.stylesFolder to a folder containing .json style files.',
                );
                return;
            }
            const items = loadedStyles.map(s => ({ label: s.name, description: s.filePath }));
            const picked = await window.showQuickPick(items, {
                placeHolder: 'Select a SQL formatting style',
            });
            if (!picked) { return; }
            await workspace.getConfiguration('sqlPrompt.formatting').update(
                'activeStyle',
                picked.label,
                ConfigurationTarget.Workspace,
            );
            updateFormatterStatusBar();
        }),
        workspace.onDidChangeConfiguration(async (event) => {
            if (event.affectsConfiguration('sqlPrompt.formatting.stylesFolder')) {
                const newFolder = workspace
                    .getConfiguration('sqlPrompt.formatting')
                    .get<string>('stylesFolder', '');
                loadedStyles = newFolder ? await loadStylesFromFolder(newFolder) : [];
                updateFormatterStatusBar();
            } else if (event.affectsConfiguration('sqlPrompt.formatting.activeStyle')) {
                updateFormatterStatusBar();
            }
        }),
    );

    updateFormatterStatusBar();
    formatterStatusBarItem.show();

    // ─────────────────────────────────────────────────────────────────────────

    // Subscribe to mssql connection changes so the schema reloads automatically
    // whenever the user connects/disconnects/switches connection in mssql.
    await setupMssqlConnectionListener(context);

    // Sync connection for the editor that is already open when the extension activates
    setTimeout(() => syncMssqlConnection(), 1500);
}

export async function deactivate() {
    mssqlApiPromise = undefined;

    // A completion accepted in the last second and a half is still only in
    // memory; flush it before the debounce would have.
    if (usageFlushDebounce) {
        clearTimeout(usageFlushDebounce);
        usageFlushDebounce = undefined;
        await usageStore?.persist();
    }

    await restoreMssqlIntellisense();
    if (client) {
        await client.stop();
        client = undefined;
    }
}

