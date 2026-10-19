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
    Position,
    CompletionItem,
    CompletionItemKind,
    CompletionList,
    EventEmitter,
    TextDocumentContentProvider,
    StatusBarAlignment,
    StatusBarItem,
    ProgressLocation,
    WorkspaceEdit,
    TextDocument,
} from "vscode";

import {
    LanguageClient,
    LanguageClientOptions,
    RevealOutputChannelOn,
    ServerOptions,
    State,
    TransportKind,
} from "vscode-languageclient/node";

import { loadStylesFromFolder, LoadedStyle } from './formatter/styleLoader';
import { FormattingEngine, SqlFormattingProvider } from './formatter/sqlFormattingProvider';
import { DotnetFormatterHost } from './formatter/dotnetFormatter';
import { StyleEditorPanel, StyleEditorHost, PreviewResult } from './formatter/styleEditor';
import { formatSqlText } from './formatter/formatPipeline';
import { normalizeMode, planSuggestions } from './mssqlSuggestions';
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
    loadTableColumns,
    loadModuleDefinition,
    DefinitionTruncatedError,
    queryRowsText,
} from './schema/schemaLoad';
import {
    WireColumns,
    WireForeignKey,
    WireObject,
    WireRoutine,
    WireSnapshot,
} from './schema/wireFormat';
import {
    AlterObjectKind,
    parseAlterHeader,
    buildObjectListQuery,
    toAlterScript,
    bracketIdentifier,
    bracketQualifiedName,
} from './alterScaffold';
import { ConsentMode, SchemaAccessProvider } from './mssql/connectionProvider';
import { createSchemaAccess } from './mssql/vscodeSchemaAccess';

let client: LanguageClient | undefined;
let connectionSyncDebounce: ReturnType<typeof setTimeout> | undefined;
let databaseCheckDebounce: ReturnType<typeof setTimeout> | undefined;
let schemaAccessPromise: Promise<SchemaAccessProvider | undefined> | undefined;
const SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;

/** Tracks the database that was active when the schema was last synced, keyed by ownerUri. */
const lastSyncedDatabasePerUri = new Map<string, string>();

// ── Go to Definition state ────────────────────────────────────────────────────
/** Editor dell'ultima sincronizzazione riuscita. */
let lastOwnerUri: string | undefined;
/** Connessione (`EditorConnection.target`) dell'ultima sincronizzazione riuscita. */
let lastQueryTarget: string | undefined;
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

/**
 * Generazione dello stadio 0 sul server: cresce a ogni sostituzione degli oggetti.
 * Gli stadi successivi di un caricamento superato (es. l'utente è passato a un
 * editor su un altro database) non vanno più pubblicati, altrimenti colonne e FK
 * di un database finirebbero sulle tabelle omonime dell'altro.
 */
let schemaPublishGeneration = 0;

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
 *
 * Senza un database d'uso (token non disponibile) pubblica uno storico vuoto:
 * altrimenti il server continuerebbe a ordinare con quello del DB precedente,
 * le cui chiavi `schema.nome` coincidono con oggetti omonimi di questo.
 */
/** Invia al server le scorciatoie di statement dell'utente (`sqlPrompt.snippets.shortcuts`). */
async function publishStatementShortcuts(): Promise<void> {
    if (!client) {
        return;
    }
    try {
        await client.sendRequest('sqlPrompt/setStatementShortcuts', {
            shortcuts: workspace.getConfiguration('sqlPrompt.snippets').get('shortcuts', {}),
        });
    } catch (err: any) {
        console.error(`[SQL Prompt] setStatementShortcuts failed: ${err?.message ?? err}`);
    }
}

async function publishUsageScores(): Promise<void> {
    if (!client) {
        return;
    }
    try {
        await client.sendRequest('sqlPrompt/updateUsageScores', {
            entries: usageStore && usageDatabase ? usageStore.scores(usageDatabase) : [],
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

// Our extension's identifier as published — used by the legacy mssql
// connectionSharing API so the permission dialog shows "SQL Prompt" and the
// approval is persisted. Must match `publisher`.`name` from package.json: mssql
// resolves the caller by this id, and a wrong one makes getActiveDatabase /
// getActiveEditorConnectionId return undefined, which silently disables the
// schema cache and the detection of a database change. La nuova API
// (getSharedConnectionsApi) identifica il chiamante da sé, tramite VS Code.
const EXTENSION_ID = "borile91.vscode-sqlprompt";

/**
 * Accesso al database tramite mssql: nuova API, `connectionSharing` o nessuno
 * (in quel caso l'utente è già stato avvisato). Vedi `mssql/connectionProvider.ts`.
 */
function getSchemaAccess(): Promise<SchemaAccessProvider | undefined> {
    if (!schemaAccessPromise) {
        schemaAccessPromise = createSchemaAccess(EXTENSION_ID).catch((err: any) => {
            console.error(`[SQL Prompt] mssql connection API setup failed: ${err?.message ?? err}`);
            return undefined;
        });
    }
    return schemaAccessPromise;
}

/** L'editor del documento è quello attivo. */
function isActiveDocument(document: TextDocument): boolean {
    return window.activeTextEditor?.document === document;
}

/**
 * Fetches the stored definition of a module (procedure, view, function).
 * Primary path is the mssql connection API (`target` from the schema access
 * provider); the language server is the fallback for direct-connection mode.
 * Returns undefined when unavailable.
 * Una definizione arrivata troncata lancia `DefinitionTruncatedError`: meglio
 * nessuno script che uno tagliato.
 */
async function fetchModuleDefinition(
    target: string,
    schema: string,
    name: string,
): Promise<string | undefined> {
    const access = await getSchemaAccess();
    if (access) {
        try {
            const definition = await loadModuleDefinition(
                access.runner,
                target,
                schema,
                name,
            );
            if (definition) {
                return definition;
            }
        } catch (err) {
            if (err instanceof DefinitionTruncatedError) {
                throw err;
            }
            // fall through to the server
        }
    }
    try {
        const res = await client?.sendRequest<{ script: string | null }>(
            'sqlPrompt/getObjectScript',
            { schema, name },
        );
        return res?.script ?? undefined;
    } catch {
        return undefined;
    }
}

/**
 * Attende `task` mostrando una notifica con avanzamento indefinito, ma solo se
 * dura più di `delayMs`: le letture veloci non fanno comparire nulla.
 */
async function withDelayedProgress<T>(title: string, task: Promise<T>, delayMs = 300): Promise<T> {
    const timer = setTimeout(() => {
        void window.withProgress(
            { location: ProgressLocation.Notification, title },
            () => task.then(() => undefined, () => undefined),
        );
    }, delayMs);
    try {
        return await task;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Lists the user objects of a kind through the mssql connection API.
 * In direct-connection mode (no mssql API) the list comes from the
 * language server's schema snapshot.
 */
async function listModules(
    target: string,
    kind: AlterObjectKind,
): Promise<Array<{ schema: string; name: string }>> {
    const access = await getSchemaAccess();
    if (!access) {
        if (!client) {
            throw new Error('language server not ready');
        }
        return client.sendRequest<Array<{ schema: string; name: string }>>(
            'sqlPrompt/listModules',
            { kind },
        );
    }
    const rows = await queryRowsText(
        access.runner,
        target,
        buildObjectListQuery(kind),
        ['schema_name', 'object_name'],
    );
    const modules: Array<{ schema: string; name: string }> = [];
    for (const [schema, name] of rows) {
        if (schema && name) {
            modules.push({ schema, name });
        }
    }
    return modules;
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
    // Incrementata prima di ogni await: chi chiama legge la propria generazione
    // subito dopo la chiamata (vedi loadSchemaStaged).
    schemaPublishGeneration++;
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
): Promise<StagedLoad | undefined> {
    report("objects…");
    let objects: WireObject[];
    let databases: string[];
    try {
        objects = await loadObjects(runner, ownerUri);
        databases = await loadDatabases(runner, ownerUri);
    } catch (err: any) {
        console.error(`[SQL Prompt] stage 0 (objects) failed: ${err?.message ?? err}`);
        return undefined;
    }

    const snapshot: WireSnapshot = {
        objects,
        columns: [],
        foreignKeys: [],
        routines: [],
        databases,
        database,
    };

    const stageZero = publishSchemaObjects(snapshot);
    const generation = schemaPublishGeneration;
    if (!(await stageZero)) {
        return undefined;
    }
    publishedSnapshot = snapshot;
    console.log(
        `[SQL Prompt] stage 0: ${objects.length} object(s), ${databases.length} database(s)`,
    );

    let complete = true;
    let superseded = false;
    /** Pubblica uno stadio solo se il server ha ancora lo stadio 0 di questo caricamento. */
    const publishStage = async (details: Parameters<typeof publishSchemaDetails>[0]) => {
        if (generation !== schemaPublishGeneration) {
            superseded = true;
            return;
        }
        await publishSchemaDetails(details);
    };

    report("columns…");
    try {
        snapshot.columns = await loadColumns(runner, ownerUri);
        await publishStage({ columns: snapshot.columns });
        console.log(`[SQL Prompt] stage 1: columns for ${snapshot.columns.length} object(s)`);
    } catch (err: any) {
        console.error(`[SQL Prompt] stage 1 (columns) failed: ${err?.message ?? err}`);
        complete = false;
    }

    report("relationships…");
    try {
        snapshot.foreignKeys = await loadForeignKeys(runner, ownerUri);
        await publishStage({ foreignKeys: snapshot.foreignKeys });
        console.log(`[SQL Prompt] stage 2: ${snapshot.foreignKeys.length} foreign key(s)`);
    } catch (err: any) {
        console.error(`[SQL Prompt] stage 2 (foreign keys) failed: ${err?.message ?? err}`);
        complete = false;
    }

    report("routine signatures…");
    try {
        snapshot.routines = await loadRoutines(runner, ownerUri);
        await publishStage({ routines: snapshot.routines });
        console.log(`[SQL Prompt] stage 3: ${snapshot.routines.length} routine(s)`);
    } catch (err: any) {
        console.error(`[SQL Prompt] stage 3 (routines) failed: ${err?.message ?? err}`);
        complete = false;
    }

    if (superseded) {
        console.log("[SQL Prompt] staged load superseded by another database: later stages not published");
    }
    return { snapshot, complete, superseded };
}

/** Esito di `loadSchemaStaged`. */
interface StagedLoad {
    snapshot: WireSnapshot;
    /** Falso se uno degli stadi 1-3 è fallito: lo snapshot non va messo in cache. */
    complete: boolean;
    /** Vero se nel frattempo il server ha ricevuto lo schema di un altro database. */
    superseded: boolean;
}

/**
 * Reads the mssql connection for the currently active SQL editor and sends it
 * to the language server so it can (re)load the schema.
 *
 * When showNotification is true (connection just changed), also pops an
 * information message including the active database name.
 */
const MSSQL_SUGGESTIONS_KEY = 'intelliSense.enableSuggestions';
const OWN_GLOBAL_KEY = 'sqlPrompt.mssqlSuggestions.ownGlobal';
const OWN_WORKSPACE_KEY = 'sqlPrompt.mssqlSuggestions.ownWorkspace';
const NOTICE_SHOWN_KEY = 'sqlPrompt.mssqlSuggestions.noticeShown';

/**
 * Porta `mssql.intelliSense.enableSuggestions` dove dice
 * `sqlPrompt.suppressMssqlIntellisense` (vedi mssqlSuggestions.ts). Si scrive
 * solo quando cambia qualcosa: niente più modifiche al workspace a ogni connessione.
 */
async function applyMssqlSuggestionsPolicy(context: ExtensionContext): Promise<void> {
    const mode = normalizeMode(
        workspace.getConfiguration('sqlPrompt').get('suppressMssqlIntellisense'),
    );
    const mssqlConfig = workspace.getConfiguration('mssql');
    const current = mssqlConfig.inspect<boolean>(MSSQL_SUGGESTIONS_KEY);
    const plan = planSuggestions(mode, {
        globalValue: current?.globalValue,
        workspaceValue: current?.workspaceValue,
        ownGlobal: context.globalState.get<boolean>(OWN_GLOBAL_KEY, false),
        ownWorkspace: context.workspaceState.get<boolean>(OWN_WORKSPACE_KEY, false),
    });

    try {
        if (plan.global !== undefined) {
            await mssqlConfig.update(MSSQL_SUGGESTIONS_KEY, plan.global ?? undefined, ConfigurationTarget.Global);
            await context.globalState.update(OWN_GLOBAL_KEY, plan.global === false);
        }
        if (plan.workspace !== undefined && workspace.workspaceFolders?.length) {
            await mssqlConfig.update(MSSQL_SUGGESTIONS_KEY, plan.workspace ?? undefined, ConfigurationTarget.Workspace);
            await context.workspaceState.update(OWN_WORKSPACE_KEY, plan.workspace === false);
        }
    } catch (err: any) {
        // Chiave non registrata (mssql assente o troppo vecchia): niente da spegnere.
        console.log(`[SQL Prompt] mssql suggestions setting not updated: ${err?.message ?? err}`);
        return;
    }

    if (plan.global === false && !context.globalState.get<boolean>(NOTICE_SHOWN_KEY, false)) {
        await context.globalState.update(NOTICE_SHOWN_KEY, true);
        void showMssqlSuggestionsNotice();
    }
}

/** Avviso una tantum: la scelta resta all'utente, che può cambiarla da qui. */
async function showMssqlSuggestionsNotice(): Promise<void> {
    const onlyWorkspace = 'Only this workspace';
    const keepBoth = 'Keep mssql suggestions';
    const picked = await window.showInformationMessage(
        "SQL Prompt turned off the mssql extension's suggestions in your User settings, " +
        'so only SQL Prompt completions appear. Change it any time with sqlPrompt.suppressMssqlIntellisense.',
        onlyWorkspace,
        keepBoth,
    );
    const mode = picked === onlyWorkspace ? 'workspace' : picked === keepBoth ? 'off' : undefined;
    if (mode) {
        await workspace
            .getConfiguration('sqlPrompt')
            .update('suppressMssqlIntellisense', mode, ConfigurationTarget.Global);
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

    const access = await getSchemaAccess();
    // Con l'evento di cambio connessione (nuova API) il polling non serve.
    if (!access || access.onDidChangeActiveEditorConnection) {
        return;
    }

    const ownerUri = editor.document.uri.toString();

    const connection = await access.getEditorConnection(ownerUri, {
        isActiveEditor: true,
        consent: 'silent',
    });
    const activeDatabase = connection?.database;
    const lastDatabase = lastSyncedDatabasePerUri.get(ownerUri);

    if (activeDatabase && lastDatabase !== undefined && activeDatabase !== lastDatabase) {
        console.log(`[SQL Prompt] Database changed: ${lastDatabase} → ${activeDatabase}, re-syncing schema.`);
        try {
            await syncMssqlConnection();
        } catch {
            // Riprova al prossimo controllo.
        }
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
 * `consent` dice se (con la nuova API mssql) si può mostrare il prompt di
 * consenso all'accesso alle connessioni: vedi `ConsentMode`.
 */
async function syncMssqlConnection(
    options: { showNotification?: boolean; force?: boolean; consent?: ConsentMode } = {},
): Promise<boolean> {
    const { showNotification = false, force = false, consent = 'auto' } = options;

    if (!client) {
        console.log("SQL Prompt: syncMssqlConnection — client not ready");
        return false;
    }

    const editor = window.activeTextEditor;
    if (!editor || editor.document.languageId !== "sql") {
        console.log("SQL Prompt: syncMssqlConnection — no active SQL editor");
        return false;
    }

    const access = await getSchemaAccess();
    if (!access) {
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
            const runner = access.runner;

            // The connection id and database name key the in-memory cache, and
            // the database name lets checkForDatabaseChange() notice a later USE.
            // `target` è dove vanno le query: l'URI dell'editor o una connessione propria.
            const connection = await access.getEditorConnection(ownerUri, {
                isActiveEditor: true,
                consent,
            });
            if (!connection) {
                console.log(
                    "SQL Prompt: syncMssqlConnection — active SQL file is not connected in mssql",
                );
                return false;
            }
            const target = connection.target;
            const activeConnectionId = connection.connectionId;
            const activeDatabase = connection.connectionId ? connection.database : undefined;

            const cacheKey = activeConnectionId
                ? buildSchemaCacheKey(activeConnectionId, activeDatabase)
                : undefined;

            /** Bookkeeping and user feedback for a snapshot that went through. */
            const announce = (snapshot: WireSnapshot, fromCache: boolean): boolean => {
                lastOwnerUri = ownerUri;
                lastQueryTarget = target;
                if (activeDatabase !== undefined) {
                    lastSyncedDatabasePerUri.set(ownerUri, activeDatabase);
                }

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
                token = await loadSchemaToken(runner, target);
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
            const staged = await window.withProgress(
                { location: ProgressLocation.Window, title: "SQL Prompt: loading schema" },
                (progress) =>
                    loadSchemaStaged(
                        runner,
                        target,
                        token?.databaseName ?? activeDatabase,
                        (message) => progress.report({ message }),
                    ),
            );

            if (!staged) {
                return false;
            }
            const { snapshot, complete, superseded } = staged;

            // Uno snapshot con uno stadio fallito non va in cache: resterebbe
            // valido (su disco fino a 14 giorni) senza colonne, FK o parametri.
            if (complete && cacheKey) {
                setCachedSchemaSnapshot(cacheKey, snapshot, token);
            }

            // Persisting is what makes the *next* window reload cheap, so it
            // must not delay this one: fire it off and let it finish on its own.
            if (complete && token && schemaDiskCache) {
                void schemaDiskCache.write(token, snapshot);
            }

            // Il server ora ha lo schema di un altro database: questo resta solo in cache.
            if (superseded) {
                return true;
            }

            await publishUsageScores();
            return announce(snapshot, false);
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

/** Una notifica è stata chiesta da almeno uno degli eventi assorbiti dal debounce. */
let pendingSyncNotification = false;

/**
 * Debounce condiviso dagli eventi di connessione: un solo sync per raffica, con
 * la notifica se almeno un evento la voleva (altrimenti il sync senza notifica
 * potrebbe assorbire quello con, tramite `inFlightSchemaSyncs`).
 */
function scheduleConnectionSync(showNotification: boolean): void {
    pendingSyncNotification ||= showNotification;
    if (connectionSyncDebounce) {
        clearTimeout(connectionSyncDebounce);
    }
    connectionSyncDebounce = setTimeout(async () => {
        connectionSyncDebounce = undefined;
        const notify = pendingSyncNotification;
        pendingSyncNotification = false;
        try {
            await syncMssqlConnection({ showNotification: notify });
        } catch (err: any) {
            console.error(`[SQL Prompt] schema sync failed: ${err?.message ?? err}`);
        }
    }, 600);
}

/**
 * Subscribes to the mssql connection events through the schema access provider:
 *
 *  - connections opened / closed / switched (URI ownership): re-sync the
 *    schema and show a notification;
 *  - active editor connection or database changed (new mssql API only, also
 *    after `USE`, or when access is granted / revoked): re-sync quietly. It
 *    replaces the polling in `checkForDatabaseChange`.
 */
async function setupMssqlConnectionListener(
    context: ExtensionContext,
): Promise<void> {
    const access = await getSchemaAccess();
    if (!access) {
        return;
    }

    if (access.onDidChangeConnections) {
        // Debounce to absorb mssql connection transition bursts.
        context.subscriptions.push(access.onDidChangeConnections(() => scheduleConnectionSync(true)));
    }
    if (access.onDidChangeActiveEditorConnection) {
        context.subscriptions.push(
            access.onDidChangeActiveEditorConnection(() => scheduleConnectionSync(false)),
        );
    }
}

function setupMssqlApiLifetime(context: ExtensionContext): void {
    context.subscriptions.push({
        dispose: () => {
            void releaseSchemaAccess();
        },
    });
}

/** Chiude le connessioni aperte dal provider e lo dimentica. */
async function releaseSchemaAccess(): Promise<void> {
    const pending = schemaAccessPromise;
    schemaAccessPromise = undefined;
    const access = await pending;
    try {
        await access?.dispose();
    } catch (err: any) {
        console.error(`[SQL Prompt] closing the mssql connections failed: ${err?.message ?? err}`);
    }
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
    void applyMssqlSuggestionsPolicy(context);

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
            // Comando esplicito: se serve, il consenso si chiede anche dopo un rifiuto.
            setTimeout(() => syncMssqlConnection({ consent: 'explicit' }), 2000);
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

            const reloaded = await syncMssqlConnection({
                showNotification: true,
                force: true,
                consent: 'explicit',
            });
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

    // Un server riavviato (es. dopo un crash) riparte senza schema: il prossimo
    // sync deve ripubblicarlo anche se lo snapshot in cache è lo stesso.
    client.onDidChangeState((event) => {
        if (event.newState === State.Running) {
            publishedSnapshot = undefined;
        }
    });

    await client.start();
    console.log("SQL Prompt: language server started.");
    await publishStatementShortcuts();

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
        const access = await getSchemaAccess();
        if (!ownerUri || !access) {
            return { objects: [], columns: [] };
        }
        const connection = await access.getEditorConnection(ownerUri, {
            isActiveEditor: true,
            consent: 'silent',
        });
        if (!connection) {
            return { objects: [], columns: [] };
        }
        try {
            return await loadCrossDatabaseSchema(
                access.runner,
                connection.target,
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

                // Primary path: fetch script via the mssql connection API, on the
                // connection of the last sync (or, failing that, of this document).
                const access = await getSchemaAccess();
                const target = access
                    ? lastQueryTarget ??
                      (await access.getEditorConnection(document.uri.toString(), {
                          isActiveEditor: isActiveDocument(document),
                          consent: 'silent',
                      }))?.target
                    : undefined;
                if (access && target) {
                    try {
                        script = await loadModuleDefinition(
                            access.runner,
                            target,
                            resolved.schema,
                            resolved.name,
                        ) ?? null;
                    } catch (err) {
                        if (err instanceof DefinitionTruncatedError) {
                            window.showWarningMessage(
                                `SQL Prompt: the definition of [${resolved.schema}].[${resolved.name}] arrived truncated ` +
                                `(${err.received} of ${err.expected} characters).`,
                            );
                            return null;
                        }
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
                    let columns: ResolvedColumn[] = resolved.columns ?? [];
                    // Prima dello stadio 1 (o se è fallito) il server non ha le
                    // colonne: lette al volo, mai uno script `CREATE TABLE` vuoto.
                    if (columns.length === 0 && access && target) {
                        try {
                            columns = await loadTableColumns(
                                access.runner,
                                target,
                                resolved.schema,
                                resolved.name,
                            );
                        } catch (err: any) {
                            console.error(
                                `[SQL Prompt] column lookup for Go to Definition failed: ${err?.message ?? err}`,
                            );
                        }
                    }
                    if (columns.length > 0) {
                        script = generateCreateTableScript(
                            resolved.schema,
                            resolved.name,
                            columns,
                        );
                    } else {
                        window.showWarningMessage(
                            `SQL Prompt: the columns of [${resolved.schema}].[${resolved.name}] are not available yet — try again once the schema has loaded.`,
                        );
                        return null;
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

    // ── ALTER scaffolding ─────────────────────────────────────────────────────
    // `ALTER PROCEDURE|VIEW|FUNCTION <name>` → pick an existing object and its
    // current definition replaces the header, ready to be edited.

    const ALTER_LIST_TTL_MS = 60 * 1000;
    // Errori ed elenchi vuoti (disconnesso, schema non ancora caricato) restano in
    // cache poco: abbastanza da non rifare la query a ogni tasto.
    const ALTER_LIST_NEGATIVE_TTL_MS = 10 * 1000;
    type ModuleList = Array<{ schema: string; name: string }>;
    const alterListCache = new Map<string, { expiresAt: number; modules?: ModuleList }>();
    // Una sola lettura per elenco anche se si continua a scrivere mentre carica.
    const alterListInFlight = new Map<string, Promise<ModuleList>>();
    const alterKindPlural = { procedure: 'procedures', view: 'views', function: 'functions' } as const;

    /**
     * Connessione da cui leggere elenco e definizioni: quella del documento se è
     * connesso (più editor possono puntare a database diversi), altrimenti l'ultima
     * sincronizzata, come per Go to Definition. Il database attivo entra nella
     * chiave di cache, così un `USE` non lascia l'elenco del database precedente.
     */
    async function resolveAlterSource(
        document: TextDocument,
    ): Promise<{ ownerUri: string; database: string }> {
        const documentUri = document.uri.toString();
        const access = await getSchemaAccess();
        if (!access) {
            // Connessione diretta: l'elenco viene dallo snapshot del server.
            return { ownerUri: lastQueryTarget ?? documentUri, database: '' };
        }
        // Il database descrive l'editor attivo: vale solo se è questo documento.
        // Durante la digitazione mai un prompt di consenso.
        const isActive = isActiveDocument(document);
        const connection = await access.getEditorConnection(documentUri, {
            isActiveEditor: isActive,
            consent: 'silent',
        });
        const ownerUri = connection ? connection.target : lastQueryTarget ?? documentUri;
        const database = connection && isActive ? connection.database : undefined;
        const syncedEditor = connection ? documentUri : lastOwnerUri ?? documentUri;
        return { ownerUri, database: database ?? lastSyncedDatabasePerUri.get(syncedEditor) ?? '' };
    }

    context.subscriptions.push(
        languages.registerCompletionItemProvider(
            sqlDocumentSelector,
            {
                async provideCompletionItems(document, position) {
                    const before = document
                        .lineAt(position.line)
                        .text.slice(0, position.character);
                    const header = parseAlterHeader(before);
                    if (!header) { return undefined; }

                    const { ownerUri, database } = await resolveAlterSource(document);
                    const cacheKey = `${ownerUri}|${database.toLowerCase()}|${header.kind}`;
                    let cached = alterListCache.get(cacheKey);
                    if (!cached || Date.now() > cached.expiresAt) {
                        let loading = alterListInFlight.get(cacheKey);
                        if (!loading) {
                            loading = withDelayedProgress(
                                `SQL Prompt: loading ${alterKindPlural[header.kind]}…`,
                                listModules(ownerUri, header.kind),
                            );
                            alterListInFlight.set(cacheKey, loading);
                            void loading.then(
                                () => alterListInFlight.delete(cacheKey),
                                () => alterListInFlight.delete(cacheKey),
                            );
                        }
                        let modules: ModuleList | undefined;
                        try {
                            modules = await loading;
                        } catch {
                            modules = undefined;
                        }
                        const ttl = modules?.length ? ALTER_LIST_TTL_MS : ALTER_LIST_NEGATIVE_TTL_MS;
                        cached = { expiresAt: Date.now() + ttl, modules };
                        alterListCache.set(cacheKey, cached);
                    }
                    if (!cached.modules) { return undefined; }

                    const nameRange = new Range(position.line, header.nameStart, position.line, position.character);
                    const alterStart = new Position(position.line, header.alterStart);
                    // Il filtro confronta il testo digitato: se è delimitato, anche filterText lo è.
                    const delimiter = header.typed.startsWith('[')
                        ? '['
                        : header.typed.startsWith('"') ? '"' : '';
                    const delimit = (name: string) =>
                        delimiter === '[' ? bracketIdentifier(name) : delimiter ? `"${name}"` : name;
                    const items = cached.modules.map((module, index) => {
                        const fullName = `${module.schema}.${module.name}`;
                        const item = new CompletionItem(fullName, CompletionItemKind.Function);
                        item.filterText =
                            `${delimit(module.name)} ${delimit(module.schema)}.${delimit(module.name)}`;
                        item.sortText = `00_${String(index).padStart(6, '0')}`;
                        item.detail = 'Fill in the current definition';
                        item.range = nameRange;
                        // Sempre delimitato: valido anche con spazi o parole riservate nel nome.
                        item.insertText = bracketQualifiedName(module.schema, module.name);
                        item.command = {
                            command: 'sqlPrompt.scaffoldAlter',
                            title: 'Fill in the current definition',
                            arguments: [document.uri, ownerUri, module, alterStart],
                        };
                        return item;
                    });
                    return new CompletionList(items, false);
                },
            },
            ' ',
            '.',
        ),
        commands.registerCommand(
            'sqlPrompt.scaffoldAlter',
            async (
                documentUri: Uri,
                ownerUri: string,
                module: { schema: string; name: string },
                alterStart: Position,
            ) => {
                const editor = window.activeTextEditor;
                if (!editor || editor.document.uri.toString() !== documentUri.toString()) { return; }

                // Il nome accettato è appena stato inserito: l'intervallo da sostituire
                // (da ALTER al cursore) va fissato prima della query, che può durare secondi.
                const document = editor.document;
                const end = editor.selection.active;
                const version = document.version;

                let definition: string | undefined;
                try {
                    definition = await withDelayedProgress(
                        `SQL Prompt: loading the definition of [${module.schema}].[${module.name}]…`,
                        fetchModuleDefinition(ownerUri, module.schema, module.name),
                    );
                } catch (err) {
                    if (err instanceof DefinitionTruncatedError) {
                        window.showErrorMessage(
                            `SQL Prompt: the definition of [${module.schema}].[${module.name}] arrived truncated ` +
                            `(${err.received} of ${err.expected} characters); not inserted.`,
                        );
                        return;
                    }
                    throw err;
                }
                // Il nome nell'header viene dall'oggetto scelto, non dal testo salvato
                // (obsoleto dopo sp_rename / ALTER SCHEMA ... TRANSFER).
                const script = definition ? toAlterScript(definition, module) : undefined;
                if (!script) {
                    window.showWarningMessage(
                        `SQL Prompt: definition not available for [${module.schema}].[${module.name}] (encrypted, or VIEW DEFINITION permission missing).`,
                    );
                    return;
                }

                // Se nel frattempo l'utente ha scritto, l'intervallo non è più affidabile:
                // meglio non toccare il documento che sovrascrivere il suo testo.
                if (document.isClosed || document.version !== version) {
                    window.showInformationMessage(
                        `SQL Prompt: the document changed while loading [${module.schema}].[${module.name}]; definition not inserted.`,
                    );
                    return;
                }

                const edit = new WorkspaceEdit();
                edit.replace(documentUri, new Range(alterStart, end), script);
                await workspace.applyEdit(edit);
            },
        ),
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

    const formattingConfig = () => workspace.getConfiguration('sqlPrompt.formatting');
    const dotnetFormatter = new DotnetFormatterHost(
        context.extensionPath,
        context.extension.id,
        () => formattingConfig().get<string>('dotnetPath', ''),
    );
    // Editor degli stili: anteprima con il motore scelto, ripiego sul formatter TypeScript
    const styleEditorHost: StyleEditorHost = {
        getStylesFolder: () => formattingConfig().get<string>('stylesFolder', ''),
        setStylesFolder: folder => formattingConfig().update('stylesFolder', folder, ConfigurationTarget.Global),
        getActiveStyleName: () => formattingConfig().get<string>('activeStyle', ''),
        setActiveStyleName: name => formattingConfig().update(
            'activeStyle', name,
            workspace.workspaceFolders?.length ? ConfigurationTarget.Workspace : ConfigurationTarget.Global,
        ),
        formatPreview: async (sql, style): Promise<PreviewResult> => {
            if (formattingConfig().get<FormattingEngine>('engine', 'dotnet') === 'dotnet') {
                try {
                    const result = await dotnetFormatter.format(sql, style);
                    if (result.ok) { return { text: result.text, engine: 'dotnet' }; }
                    const first = result.errors[0];
                    return {
                        text: sql, engine: 'dotnet',
                        error: first ? `Syntax error at line ${first.line}, column ${first.column}: ${first.message}` : 'The SQL could not be parsed.',
                    };
                } catch (err: any) {
                    const text = formatSqlText(sql, style);
                    return { text, engine: 'legacy', error: `.NET engine unavailable (${err?.message ?? err}): preview from the built-in formatter.` };
                }
            }
            return { text: formatSqlText(sql, style), engine: 'legacy' };
        },
        stylesChanged: async () => {
            const folder = formattingConfig().get<string>('stylesFolder', '');
            loadedStyles = folder ? await loadStylesFromFolder(folder) : [];
            updateFormatterStatusBar();
        },
    };

    context.subscriptions.push(
        { dispose: () => dotnetFormatter.dispose() },
        languages.registerDocumentFormattingEditProvider(
            [{ scheme: 'file', language: 'sql' }, { scheme: 'untitled', language: 'sql' }],
            new SqlFormattingProvider(
                getActiveStyle,
                () => formattingConfig().get<FormattingEngine>('engine', 'dotnet'),
                dotnetFormatter,
            ),
        ),
        commands.registerCommand('sqlPrompt.editFormattingStyles', () => {
            StyleEditorPanel.show(context.extensionUri, styleEditorHost);
        }),
        commands.registerCommand('sqlPrompt.selectFormattingStyle', async () => {
            const stylesFolder = workspace
                .getConfiguration('sqlPrompt.formatting')
                .get<string>('stylesFolder', '');
            if (stylesFolder) {
                loadedStyles = await loadStylesFromFolder(stylesFolder);
            }
            const editItem = { label: '$(edit) Edit formatting styles…', description: '', edit: true };
            if (loadedStyles.length === 0) {
                const choice = await window.showWarningMessage(
                    'SQL Prompt: no style files found. Set sqlPrompt.formatting.stylesFolder to a folder containing .json style files, or create one in the style editor.',
                    'Open style editor',
                );
                if (choice) { StyleEditorPanel.show(context.extensionUri, styleEditorHost); }
                return;
            }
            const items = [
                ...loadedStyles.map(s => ({ label: s.name, description: s.filePath, edit: false })),
                editItem,
            ];
            const picked = await window.showQuickPick(items, {
                placeHolder: 'Select a SQL formatting style',
            });
            if (!picked) { return; }
            if (picked.edit) {
                StyleEditorPanel.show(context.extensionUri, styleEditorHost);
                return;
            }
            await workspace.getConfiguration('sqlPrompt.formatting').update(
                'activeStyle',
                picked.label,
                ConfigurationTarget.Workspace,
            );
            updateFormatterStatusBar();
        }),
        workspace.onDidChangeConfiguration(async (event) => {
            if (event.affectsConfiguration('sqlPrompt.suppressMssqlIntellisense')) {
                await applyMssqlSuggestionsPolicy(context);
            }
            if (event.affectsConfiguration('sqlPrompt.snippets.shortcuts')) {
                await publishStatementShortcuts();
            }
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
    await releaseSchemaAccess();

    // A completion accepted in the last second and a half is still only in
    // memory; flush it before the debounce would have.
    if (usageFlushDebounce) {
        clearTimeout(usageFlushDebounce);
        usageFlushDebounce = undefined;
        await usageStore?.persist();
    }

    if (client) {
        await client.stop();
        client = undefined;
    }
}

