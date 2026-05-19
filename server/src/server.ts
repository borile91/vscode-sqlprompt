import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  CompletionItem,
  TextDocumentPositionParams,
  TextDocumentSyncKind,
  InitializeResult,
} from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";
import {
  SchemaLoader,
  TableInfo,
  RoutineSnapshot,
  ScalarFunctionInfo,
  TableValuedFunctionInfo,
  StoredProcedureInfo,
  RoutineParameterInfo,
} from "./schemaLoader";
import { extractStatementAtOffset } from "./documentTextService";
import { resolveContext } from "./cursorContextResolver";
import { buildCompletions, resolveTableCompletionItem } from "./completionEngine";

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let schemaLoader: SchemaLoader | null = null;
let tables: TableInfo[] = [];
let routines: RoutineSnapshot = emptyRoutineSnapshot();
let hasConfigurationCapability = false;

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
      }

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
      [tables, routines] = await Promise.all([
        schemaLoader.loadSchema(),
        schemaLoader.loadRoutines().catch(() => emptyRoutineSnapshot()),
      ]);
      connection.console.info(
        `SQL Prompt: schema updated via mssql connection. Loaded ${tables.length} tables, ${routines.scalarFunctions.length} scalar function(s), ${routines.tableValuedFunctions.length} table-valued function(s), ${routines.storedProcedures.length} procedure(s).`,
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

connection.onRequest(
  "sqlPrompt/updateSchemaSnapshot",
  async (params: {
    tables: TableInfo[];
    scalarFunctions?: ScalarFunctionInfo[];
    tableValuedFunctions?: TableValuedFunctionInfo[];
    storedProcedures?: StoredProcedureInfo[];
  }) => {
    try {
      if (schemaLoader) {
        await schemaLoader.disconnect();
        schemaLoader = null;
      }

      tables = sanitizeTableSnapshot(Array.isArray(params?.tables) ? params.tables : []);
      routines = sanitizeRoutineSnapshot(params);
      connection.console.info(
        `SQL Prompt: schema updated via connectionSharing snapshot. Loaded ${tables.length} tables, ${routines.scalarFunctions.length} scalar function(s), ${routines.tableValuedFunctions.length} table-valued function(s), ${routines.storedProcedures.length} procedure(s).`,
      );
      return { success: true, tableCount: tables.length };
    } catch (err: any) {
      connection.console.error(
        `SQL Prompt: updateSchemaSnapshot failed — ${err.message}`,
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
  }
  return { success: true };
});

// Custom request: reload schema
connection.onRequest("sqlPrompt/reloadSchema", async () => {
  if (schemaLoader) {
    connection.sendNotification("sqlPrompt/schemaLoadingStarted", {
      message: "Reloading schema...",
    });
    try {
      [tables, routines] = await Promise.all([
        schemaLoader.loadSchema(),
        schemaLoader.loadRoutines().catch(() => emptyRoutineSnapshot()),
      ]);
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

// ── Completion (new pipeline) ─────────────────────────────────────────────────
//
// Pipeline:
//   document text  →  extractStatementAtOffset (GO / ; aware)
//                  →  resolveContext (token-based: clause, dot, function, scope)
//                  →  buildCompletions (routing by context.clause)

connection.onCompletion(
  (params: TextDocumentPositionParams): CompletionItem[] => {
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

    return buildCompletions(context, tables, routines, document, position, statementRange);
  },
);

connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
  return resolveTableCompletionItem(item, tables);
});

// ── Schema sanitization ───────────────────────────────────────────────────────

/**
 * Normalizes a raw value that may be a wrapped mssql cell object
 * (e.g. { displayValue: "foo", ... }) into a plain string.
 */
function unwrapCellValue(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const candidate = obj.displayValue ?? obj.value ?? obj.name ?? obj.column_name;
    if (typeof candidate === 'string') return candidate;
    if (typeof candidate === 'number') return String(candidate);
  }
  return undefined;
}

/**
 * Sanitizes the TableInfo[] snapshot received from the client.
 * Ensures all string fields (schema, name, column names, FK fields) are
 * plain strings — handles cases where the mssql API wraps values as objects.
 */
function sanitizeTableSnapshot(raw: TableInfo[]): TableInfo[] {
  const result: TableInfo[] = [];

  for (const table of raw) {
    const schema = unwrapCellValue(table.schema);
    const name = unwrapCellValue(table.name);
    if (!schema || !name) continue;

    const columns = (table.columns ?? [])
      .map((col) => {
        const colName = unwrapCellValue(col?.name ?? col);
        if (!colName) return null;
        return {
          name: colName,
          dataType: unwrapCellValue(col?.dataType) ?? 'unknown',
          maxLength: typeof col?.maxLength === 'number' ? col.maxLength : null,
          isNullable: !!(col?.isNullable),
          isPrimaryKey: !!(col?.isPrimaryKey),
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    const foreignKeys = (table.foreignKeys ?? [])
      .map((fk) => {
        const fkName = unwrapCellValue(fk?.name);
        const parentSchema = unwrapCellValue(fk?.parentSchema);
        const parentTable = unwrapCellValue(fk?.parentTable);
        const referencedSchema = unwrapCellValue(fk?.referencedSchema);
        const referencedTable = unwrapCellValue(fk?.referencedTable);
        if (!fkName || !parentSchema || !parentTable || !referencedSchema || !referencedTable) {
          return null;
        }
        const mappings = (fk.mappings ?? [])
          .map((m) => {
            const column = unwrapCellValue(m?.column);
            const referencedColumn = unwrapCellValue(m?.referencedColumn);
            if (!column || !referencedColumn) return null;
            return { column, referencedColumn };
          })
          .filter((m): m is NonNullable<typeof m> => m !== null);
        return { name: fkName, parentSchema, parentTable, referencedSchema, referencedTable, mappings };
      })
      .filter((fk): fk is NonNullable<typeof fk> => fk !== null);

    result.push({ schema, name, columns, foreignKeys });
  }

  return result;
}

function emptyRoutineSnapshot(): RoutineSnapshot {
  return {
    scalarFunctions: [],
    tableValuedFunctions: [],
    storedProcedures: [],
  };
}

function sanitizeRoutineParameters(raw: unknown): RoutineParameterInfo[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((param) => {
      const p = param as Record<string, unknown>;
      const name = unwrapCellValue(p?.name);
      if (!name) return null;

      return {
        name,
        dataType: unwrapCellValue(p?.dataType) ?? 'unknown',
        maxLength: typeof p?.maxLength === 'number' ? p.maxLength : null,
        precision: typeof p?.precision === 'number' ? p.precision : null,
        scale: typeof p?.scale === 'number' ? p.scale : null,
        isOutput: !!p?.isOutput,
        hasDefaultValue: !!p?.hasDefaultValue,
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);
}

function sanitizeRoutineList<T extends { schema: string; name: string; parameters: RoutineParameterInfo[] }>(
  raw: unknown,
): T[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((entry) => {
      const e = entry as Record<string, unknown>;
      const schema = unwrapCellValue(e?.schema);
      const name = unwrapCellValue(e?.name);
      if (!schema || !name) return null;

      return {
        schema,
        name,
        parameters: sanitizeRoutineParameters(e?.parameters),
      } as T;
    })
    .filter((item): item is T => item !== null);
}

function sanitizeRoutineSnapshot(raw: {
  scalarFunctions?: unknown;
  tableValuedFunctions?: unknown;
  storedProcedures?: unknown;
}): RoutineSnapshot {
  return {
    scalarFunctions: sanitizeRoutineList<ScalarFunctionInfo>(raw?.scalarFunctions),
    tableValuedFunctions: sanitizeRoutineList<TableValuedFunctionInfo>(raw?.tableValuedFunctions),
    storedProcedures: sanitizeRoutineList<StoredProcedureInfo>(raw?.storedProcedures),
  };
}

documents.listen(connection);
connection.listen();
