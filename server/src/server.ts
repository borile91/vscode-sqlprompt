import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  CompletionItem,
  CompletionList,
  TextDocumentPositionParams,
  TextDocumentSyncKind,
  InitializeResult,
  RenameParams,
  WorkspaceEdit,
  TextEdit,
  Range,
  ResponseError,
  ErrorCodes,
} from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";
import { SchemaLoader, TableInfo, RoutineSnapshot } from "./schemaLoader";
import { extractStatementAtOffset } from "./documentTextService";
import { resolveContext } from "./cursorContextResolver";
import { buildCompletionList, resolveTableCompletionItem, setUsageScores } from "./completionEngine";
import { collidesWithExistingAlias, findAliasRenameTarget, formatAliasName } from "./aliasRename";
import { listModulesFromSnapshot, ModuleName } from "./alterModules";
import {
  WireColumns,
  WireForeignKey,
  WireObject,
  WireRoutine,
  mergeColumns,
  mergeForeignKeys,
  mergeRoutineParameters,
  splitWireObjects,
} from "./schemaWire";

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let schemaLoader: SchemaLoader | null = null;
let tables: TableInfo[] = [];
let routines: RoutineSnapshot = emptyRoutineSnapshot();
let databases: string[] = [];
/**
 * The database stage 0 described, if the client knew it.
 *
 * Stages 1-3 are scoped to it: `tables` also holds demand-loaded schemas from
 * other databases, and a same-named table there must not be overwritten.
 */
let connectedDatabase: string | undefined;
let hasConfigurationCapability = false;

/** Lowercase database names whose schema has already been loaded (or attempted). */
const loadedDatabaseNames = new Set<string>();
/** Lowercase database names whose schema load is in progress (to avoid duplicate requests). */
const loadingDatabaseNames = new Set<string>();

/**
 * Appends demand-loaded tables, dropping any that is already known.
 *
 * The same table can arrive twice — most easily by demand-loading the database
 * that is already connected — and a duplicate is not harmless: it shows up as a
 * repeated entry in every completion list.
 */
function appendTables(existing: TableInfo[], incoming: TableInfo[]): TableInfo[] {
  const key = (t: TableInfo) =>
    `${(t.database ?? '').toLowerCase()}|${t.schema.toLowerCase()}|${t.name.toLowerCase()}`;
  const known = new Set(existing.map(key));
  const fresh = incoming.filter((t) => !known.has(key(t)));
  return fresh.length === incoming.length ? [...existing, ...incoming] : [...existing, ...fresh];
}

function preloadCrossDatabaseSchemas(currentDatabase: string | undefined): void {
  if (!schemaLoader || databases.length === 0) {
    return;
  }

  const targetDatabases = databases.filter((db) => {
    const lower = db.toLowerCase();
    if (currentDatabase && lower === currentDatabase.toLowerCase()) {
      return false;
    }
    return !loadedDatabaseNames.has(lower) && !loadingDatabaseNames.has(lower);
  });

  if (targetDatabases.length === 0) {
    return;
  }

  targetDatabases.forEach((db) => loadingDatabaseNames.add(db.toLowerCase()));
  connection.console.info(
    `SQL Prompt: preloading cross-database schemas for ${targetDatabases.join(', ')}`,
  );

  void schemaLoader.loadAllDatabaseSchemas(targetDatabases)
    .then((extraTables) => {
      tables = appendTables(tables, extraTables);
      targetDatabases.forEach((db) => {
        const lower = db.toLowerCase();
        loadingDatabaseNames.delete(lower);
        loadedDatabaseNames.add(lower);
      });
      connection.console.info(
        `SQL Prompt: cross-database preload completed, added ${extraTables.length} table(s).`,
      );
    })
    .catch((err: any) => {
      targetDatabases.forEach((db) => {
        const lower = db.toLowerCase();
        loadingDatabaseNames.delete(lower);
        loadedDatabaseNames.add(lower);
      });
      connection.console.error(
        `SQL Prompt: cross-database preload failed — ${err?.message ?? err}`,
      );
    });
}

connection.onInitialize((params: InitializeParams) => {
  connection.console.info("SQL Prompt server: onInitialize called");
  const capabilities = params.capabilities;

  hasConfigurationCapability = !!(
    capabilities.workspace && !!capabilities.workspace.configuration
  );

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: true,
        triggerCharacters: [".", "*", ",", " "],
      },
      renameProvider: {
        prepareProvider: true,
      },
    },
  };

  return result;
});



// ── New request: connect via mssql connection string ──────────────────────────
connection.onRequest(
  "sqlPrompt/updateConnection",
  async (params: { connectionString: string }) => {
    try {
      if (schemaLoader) {
        await schemaLoader.disconnect();
        schemaLoader = null;
        tables = [];
        routines = emptyRoutineSnapshot();
        databases = [];
      }
      loadedDatabaseNames.clear();
      loadingDatabaseNames.clear();

      // Log the connection string with password masked for debugging
      const masked = params.connectionString.replace(
        /(Password|PWD)=([^;]*)/gi,
        '$1=***'
      );
      connection.console.info(`SQL Prompt: connecting with — ${masked}`);
      connection.sendNotification("sqlPrompt/schemaLoadingStarted", {
        message: "Loading schema...",
      });

      schemaLoader = new SchemaLoader(params.connectionString);
      await schemaLoader.connect();
      [tables, routines, databases] = await Promise.all([
        schemaLoader.loadSchema(),
        schemaLoader.loadRoutines().catch(() => emptyRoutineSnapshot()),
        schemaLoader.loadDatabases().catch((e) => {
          connection.console.error(`SQL Prompt: loadDatabases failed — ${e?.message ?? e}`);
          return [];
        }),
      ]);

      // Mark the connected database as loaded.
      const currentDbName = tables[0]?.database;
      if (currentDbName) {
        loadedDatabaseNames.add(currentDbName.toLowerCase());
        connection.console.info(`SQL Prompt: connected database is [${currentDbName}].`);
      }
      preloadCrossDatabaseSchemas(currentDbName);
      connection.console.info(
        `SQL Prompt: schema updated via mssql connection. Loaded ${tables.length} tables, ${routines.scalarFunctions.length} scalar function(s), ${routines.tableValuedFunctions.length} table-valued function(s), ${routines.storedProcedures.length} procedure(s), ${databases.length} database(s) visible.`,
      );
      connection.console.info(
        `SQL Prompt: other databases available for demand-loading: ${databases
          .filter((d) => d.toLowerCase() !== (currentDbName ?? '').toLowerCase())
          .join(', ') || '(none)'}`,
      );
      connection.sendNotification("sqlPrompt/schemaLoadingCompleted", {
        tableCount: tables.length,
        scalarFunctionCount: routines.scalarFunctions.length,
        tableValuedFunctionCount: routines.tableValuedFunctions.length,
        storedProcedureCount: routines.storedProcedures.length,
      });
      return { success: true, tableCount: tables.length };
    } catch (err: any) {
      connection.console.error(
        `SQL Prompt: updateConnection failed — ${err.message}`,
      );
      connection.sendNotification("sqlPrompt/schemaLoadingFailed", {
        error: err.message,
      });
      return { success: false, message: err.message };
    }
  },
);

// ── Staged schema snapshot (connectionSharing path) ───────────────────────────
//
// The client publishes the schema in stages so that table completion becomes
// available long before the columns have finished loading:
//
//   sqlPrompt/setSchemaObjects    stage 0 — replaces everything, names only
//   sqlPrompt/mergeSchemaDetails  stages 1-3 — fills in columns, FKs, parameters
//
// See `schemaWire.ts` for the packed payload format and why it exists.

connection.onRequest(
  "sqlPrompt/setSchemaObjects",
  async (params: {
    objects?: WireObject[];
    databases?: string[];
    database?: string;
  }) => {
    try {
      if (schemaLoader) {
        await schemaLoader.disconnect();
        schemaLoader = null;
      }

      connectedDatabase =
        typeof params?.database === 'string' && params.database ? params.database : undefined;

      const split = splitWireObjects(
        Array.isArray(params?.objects) ? params.objects : [],
        connectedDatabase,
      );

      tables = split.tables;
      routines = split.routines;
      databases = Array.isArray(params?.databases)
        ? params.databases.filter((d) => typeof d === 'string' && d.length > 0)
        : [];

      // A fresh stage 0 replaces everything, so the demand-load bookkeeping has
      // to start over — and the database this snapshot covers must be marked as
      // loaded. Without this, typing the name of the *connected* database
      // triggered a demand-load that appended its tables a second time, and
      // every table appeared twice in the completions.
      loadedDatabaseNames.clear();
      loadingDatabaseNames.clear();
      if (params?.database) {
        loadedDatabaseNames.add(params.database.toLowerCase());
      }

      connection.console.info(
        `SQL Prompt: stage 0 published — ${tables.length} table(s)/view(s), ` +
        `${routines.scalarFunctions.length} scalar function(s), ` +
        `${routines.tableValuedFunctions.length} table-valued function(s), ` +
        `${routines.storedProcedures.length} procedure(s), ` +
        `${databases.length} database(s).`,
      );
      return { success: true, tableCount: tables.length };
    } catch (err: any) {
      connection.console.error(
        `SQL Prompt: setSchemaObjects failed — ${err.message}`,
      );
      return { success: false, message: err.message };
    }
  },
);

connection.onRequest(
  "sqlPrompt/mergeSchemaDetails",
  (params: {
    columns?: WireColumns[];
    foreignKeys?: WireForeignKey[];
    routines?: WireRoutine[];
  }) => {
    try {
      const parts: string[] = [];

      if (Array.isArray(params?.columns)) {
        const count = mergeColumns(tables, params.columns, connectedDatabase);
        parts.push(`${count} column(s)`);
      }
      if (Array.isArray(params?.foreignKeys)) {
        const count = mergeForeignKeys(tables, params.foreignKeys, connectedDatabase);
        parts.push(`${count} foreign key(s)`);
      }
      if (Array.isArray(params?.routines)) {
        const count = mergeRoutineParameters(routines, params.routines);
        parts.push(`${count} routine signature(s)`);
      }

      connection.console.info(`SQL Prompt: schema details merged — ${parts.join(', ') || 'nothing'}.`);
      return { success: true };
    } catch (err: any) {
      connection.console.error(
        `SQL Prompt: mergeSchemaDetails failed — ${err.message}`,
      );
      return { success: false, message: err.message };
    }
  },
);



// Custom request: disconnect
connection.onRequest("sqlPrompt/disconnect", async () => {
  if (schemaLoader) {
    await schemaLoader.disconnect();
    schemaLoader = null;
    tables = [];
    routines = emptyRoutineSnapshot();
    databases = [];
  }
  connectedDatabase = undefined;
  loadedDatabaseNames.clear();
  loadingDatabaseNames.clear();
  return { success: true };
});

// Custom request: reload schema
connection.onRequest("sqlPrompt/reloadSchema", async () => {
  if (schemaLoader) {
    connection.sendNotification("sqlPrompt/schemaLoadingStarted", {
      message: "Reloading schema...",
    });
    try {
      loadedDatabaseNames.clear();
      loadingDatabaseNames.clear();
      [tables, routines, databases] = await Promise.all([
        schemaLoader.loadSchema(),
        schemaLoader.loadRoutines().catch(() => emptyRoutineSnapshot()),
        schemaLoader.loadDatabases().catch((e) => {
          connection.console.error(`SQL Prompt: loadDatabases (reload) failed — ${e?.message ?? e}`);
          return [];
        }),
      ]);

      const currentDbNameReload = tables[0]?.database;
      if (currentDbNameReload) {
        loadedDatabaseNames.add(currentDbNameReload.toLowerCase());
      }

      preloadCrossDatabaseSchemas(currentDbNameReload);

      connection.sendNotification("sqlPrompt/schemaLoadingCompleted", {
        tableCount: tables.length,
        scalarFunctionCount: routines.scalarFunctions.length,
        tableValuedFunctionCount: routines.tableValuedFunctions.length,
        storedProcedureCount: routines.storedProcedures.length,
      });
      return { success: true, tableCount: tables.length };
    } catch (err: any) {
      connection.sendNotification("sqlPrompt/schemaLoadingFailed", {
        error: err.message,
      });
      throw err;
    }
  }
  return { success: false, message: "Not connected" };
});

// ── Go to Definition ──────────────────────────────────────────────────────────

interface ResolvedObjectInfo {
  schema: string;
  name: string;
  kind: 'tableOrView' | 'procedure' | 'scalarFunction' | 'tableValuedFunction';
  /** Column metadata — present for tableOrView so the client can generate CREATE TABLE. */
  columns?: Array<{
    name: string;
    dataType: string;
    maxLength: number | null;
    isNullable: boolean;
    isPrimaryKey: boolean;
  }>;
}

// Resolve a SQL identifier to a known schema object (tables, views, routines).
connection.onRequest(
  "sqlPrompt/resolveObject",
  (params: { name: string; schema?: string }): ResolvedObjectInfo | null => {
    const nameLower = params.name.toLowerCase();
    const schemaLower = params.schema?.toLowerCase();

    for (const t of tables) {
      if (
        t.name.toLowerCase() === nameLower &&
        (!schemaLower || t.schema.toLowerCase() === schemaLower)
      ) {
        return { schema: t.schema, name: t.name, kind: 'tableOrView', columns: t.columns };
      }
    }
    for (const p of routines.storedProcedures) {
      if (
        p.name.toLowerCase() === nameLower &&
        (!schemaLower || p.schema.toLowerCase() === schemaLower)
      ) {
        return { schema: p.schema, name: p.name, kind: 'procedure' };
      }
    }
    for (const f of routines.scalarFunctions) {
      if (
        f.name.toLowerCase() === nameLower &&
        (!schemaLower || f.schema.toLowerCase() === schemaLower)
      ) {
        return { schema: f.schema, name: f.name, kind: 'scalarFunction' };
      }
    }
    for (const f of routines.tableValuedFunctions) {
      if (
        f.name.toLowerCase() === nameLower &&
        (!schemaLower || f.schema.toLowerCase() === schemaLower)
      ) {
        return { schema: f.schema, name: f.name, kind: 'tableValuedFunction' };
      }
    }
    return null;
  },
);

// Fetch the T-SQL script for an object via the direct SchemaLoader connection.
// Only available when the extension was configured via settings (not connectionSharing).
connection.onRequest(
  "sqlPrompt/getObjectScript",
  async (params: { schema: string; name: string }): Promise<{ script: string | null }> => {
    if (!schemaLoader) {
      return { script: null };
    }
    try {
      const script = await schemaLoader.getObjectScript(params.schema, params.name);
      return { script };
    } catch (err: any) {
      connection.console.error(`SQL Prompt: getObjectScript failed — ${err.message}`);
      return { script: null };
    }
  },
);

// ALTER scaffolding in modalità connessione diretta: il client non può
// interrogare sys.objects, quindi l'elenco viene dallo snapshot del server.
connection.onRequest(
  "sqlPrompt/listModules",
  (params: { kind?: string }): ModuleName[] => {
    const kind = params?.kind;
    if (kind !== 'procedure' && kind !== 'view' && kind !== 'function') {
      return [];
    }
    // In connessione diretta le tabelle del database connesso precedono quelle
    // caricate a richiesta da altri database.
    const database = connectedDatabase ?? (schemaLoader ? tables[0]?.database : undefined);
    return listModulesFromSnapshot(kind, tables, routines, database);
  },
);

// ── Completion ranking: usage history ─────────────────────────────────────────
//
// The extension host owns the history because it is the side that can persist
// across sessions, so it pushes a decayed snapshot whenever it changes. Entries
// arrive as pairs rather than an object: a Map is what the ranker wants, and
// JSON has no Map.

connection.onRequest(
  "sqlPrompt/updateUsageScores",
  (params: { entries?: Array<[string, number]> }) => {
    const entries = Array.isArray(params?.entries) ? params.entries : [];
    const usable = entries.filter(
      (entry): entry is [string, number] =>
        Array.isArray(entry) &&
        typeof entry[0] === 'string' &&
        typeof entry[1] === 'number' &&
        Number.isFinite(entry[1]),
    );
    setUsageScores(new Map(usable));
    connection.console.info(`SQL Prompt: usage history updated — ${usable.length} object(s).`);
    return { success: true };
  },
);

// ── Completion (new pipeline) ─────────────────────────────────────────────────
//
// Pipeline:
//   document text  →  extractStatementAtOffset (GO / ; aware)
//                  →  resolveContext (token-based: clause, dot, function, scope)
//                  →  buildCompletions (routing by context.clause)

connection.onCompletion(
  (params: TextDocumentPositionParams): CompletionItem[] | CompletionList => {
    connection.console.info(
      `SQL Prompt: onCompletion called, tables loaded: ${tables.length}, ` +
      `procedures loaded: ${routines.storedProcedures.length}, ` +
      `scalar functions: ${routines.scalarFunctions.length}, ` +
      `table-valued functions: ${routines.tableValuedFunctions.length}`,
    );

    const document = documents.get(params.textDocument.uri);
    if (!document) {
      connection.console.info("SQL Prompt: document not found in manager");
      return [];
    }

    const position = params.position;
    const fullText = document.getText();
    const cursorAbsolute = document.offsetAt(position);

    const statementRange = extractStatementAtOffset(fullText, cursorAbsolute);

    connection.console.info(
      `SQL Prompt: statement [${statementRange.start}–${statementRange.end}] ` +
      `cursorOffset=${statementRange.cursorOffset}`,
    );

    const context = resolveContext(
      statementRange.text,
      statementRange.start,
      cursorAbsolute,
      tables,
    );

    connection.console.info(
      `SQL Prompt: clause=${context.clause} statementKind=${context.statementKind} ` +
      `isAfterDot=${context.isAfterDot} sources=${context.visibleSources.length}`,
    );

    // ── Demand-load cross-database schema ─────────────────────────────────────
    // When the user types "DBName." in a FROM/JOIN, trigger schema load for that
    // database if it hasn't been loaded yet.  The current request returns
    // immediately (possibly with empty results); the next keystroke will have the
    // loaded schema available.
    if (context.isAfterDot && context.qualifierChain?.length) {
      const topQualifier = context.qualifierChain[0];
      const topLower = topQualifier.toLowerCase();
      const knownDb = databases.find((d) => d.toLowerCase() === topLower);

      if (knownDb && !loadedDatabaseNames.has(topLower) && !loadingDatabaseNames.has(topLower)) {
        loadingDatabaseNames.add(topLower);
        connection.console.info(`SQL Prompt: demand-loading schema for [${knownDb}]...`);
        connection.sendNotification('sqlPrompt/schemaLoadingStarted', {
          database: knownDb,
          message: `Loading schema for ${knownDb}...`,
        });

        if (schemaLoader) {
          schemaLoader
            .loadSchemaForDatabase(knownDb)
            .then((extraTables) => {
              tables = appendTables(tables, extraTables);
              loadedDatabaseNames.add(topLower);
              loadingDatabaseNames.delete(topLower);
              connection.console.info(
                `SQL Prompt: demand-loaded ${extraTables.length} table(s) for [${knownDb}].`,
              );
              connection.sendNotification('sqlPrompt/schemaLoadingCompleted', {
                database: knownDb,
                tableCount: tables.length,
                message: `Schema loaded for ${knownDb}: ${extraTables.length} table(s)`,
              });
            })
            .catch((err: any) => {
              loadingDatabaseNames.delete(topLower);
              loadedDatabaseNames.add(topLower); // avoid infinite retry on permission errors
              connection.console.error(
                `SQL Prompt: demand-load failed for [${knownDb}]: ${err?.message ?? err}`,
              );
              connection.sendNotification('sqlPrompt/schemaLoadingFailed', {
                database: knownDb,
                error: err?.message ?? String(err),
              });
            });
        } else {
          // Send request to client to use connectionSharing
          connection.sendRequest<{ objects?: WireObject[]; columns?: WireColumns[] }>(
            'sqlPrompt/loadCrossDatabaseSchema',
            { database: knownDb },
          )
            .then((result) => {
              const extraTables = splitWireObjects(
                Array.isArray(result?.objects) ? result.objects : [],
                knownDb,
              ).tables;
              if (Array.isArray(result?.columns)) {
                mergeColumns(extraTables, result.columns, knownDb);
              }
              tables = appendTables(tables, extraTables);
              loadingDatabaseNames.delete(topLower);
              // An empty result is not a loaded database: the client answers
              // `{ tables: [] }` both when no editor is active and when the
              // query failed. Marking it as loaded would freeze the database
              // out of completions until the window is reloaded, so leave it
              // unmarked and let the next keystroke try again.
              if (extraTables.length === 0) {
                connection.console.info(
                  `SQL Prompt: [${knownDb}] returned no tables — not marking it as loaded, will retry.`,
                );
                connection.sendNotification('sqlPrompt/schemaLoadingFailed', {
                  database: knownDb,
                  error: `No tables returned for ${knownDb}. Keep the .sql editor focused and try again.`,
                });
                return;
              }
              loadedDatabaseNames.add(topLower);
              connection.console.info(
                `SQL Prompt: connectionSharing demand-loaded ${extraTables.length} table(s) for [${knownDb}].`,
              );
              connection.sendNotification('sqlPrompt/schemaLoadingCompleted', {
                database: knownDb,
                tableCount: tables.length,
                message: `Schema loaded for ${knownDb}: ${extraTables.length} table(s)`,
              });
            })
            .catch((err: any) => {
              loadingDatabaseNames.delete(topLower);
              loadedDatabaseNames.add(topLower);
              connection.console.error(
                `SQL Prompt: connectionSharing demand-load failed for [${knownDb}]: ${err?.message ?? err}`,
              );
              connection.sendNotification('sqlPrompt/schemaLoadingFailed', {
                database: knownDb,
                error: err?.message ?? String(err),
              });
            });
        }
      } else if (knownDb && loadingDatabaseNames.has(topLower)) {
        connection.console.info(`SQL Prompt: schema for [${knownDb}] is already loading...`);
      }
    }

    return buildCompletionList(context, tables, routines, document, position, statementRange, databases, loadingDatabaseNames);
  },
);

connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
  return resolveTableCompletionItem(item, tables);
});

// ── Rename of a table alias ───────────────────────────────────────────────────
//
// Aliases are scoped to their statement, so both the search and the edits stay
// inside the statement under the cursor.

/** Locates the alias under the cursor, or null when there is none. */
function resolveAliasRename(uri: string, position: TextDocumentPositionParams["position"]) {
  const document = documents.get(uri);
  if (!document) return null;

  const cursorAbsolute = document.offsetAt(position);
  const statementRange = extractStatementAtOffset(document.getText(), cursorAbsolute);
  const target = findAliasRenameTarget(statementRange.text, statementRange.cursorOffset);
  if (!target) return null;

  return { document, statementStart: statementRange.start, target };
}

connection.onPrepareRename((params: TextDocumentPositionParams) => {
  const resolved = resolveAliasRename(params.textDocument.uri, params.position);
  if (!resolved) return null;

  const { document, statementStart, target } = resolved;
  return {
    range: Range.create(
      document.positionAt(statementStart + target.current.start),
      document.positionAt(statementStart + target.current.end),
    ),
    placeholder: target.alias,
  };
});

connection.onRenameRequest((params: RenameParams): WorkspaceEdit | ResponseError<void> => {
  const resolved = resolveAliasRename(params.textDocument.uri, params.position);
  if (!resolved) {
    return new ResponseError(
      ErrorCodes.InvalidRequest,
      "SQL Prompt renames table aliases: place the cursor on one.",
    );
  }

  const newName = formatAliasName(params.newName);
  if (!newName) {
    return new ResponseError(
      ErrorCodes.InvalidRequest,
      `"${params.newName}" is not a valid alias.`,
    );
  }

  const { document, statementStart, target } = resolved;

  if (collidesWithExistingAlias(target, newName)) {
    return new ResponseError(
      ErrorCodes.InvalidRequest,
      `"${params.newName}" is already used by another table in this statement.`,
    );
  }

  const edits = target.occurrences.map((occurrence) =>
    TextEdit.replace(
      Range.create(
        document.positionAt(statementStart + occurrence.start),
        document.positionAt(statementStart + occurrence.end),
      ),
      newName,
    ),
  );

  connection.console.info(
    `SQL Prompt: renaming alias [${target.alias}] to [${newName}] in ${edits.length} place(s).`,
  );

  return { changes: { [params.textDocument.uri]: edits } };
});

/** The routine snapshot for "no routines loaded yet". */
function emptyRoutineSnapshot(): RoutineSnapshot {
  return {
    scalarFunctions: [],
    tableValuedFunctions: [],
    storedProcedures: [],
  };
}

documents.listen(connection);
connection.listen();
