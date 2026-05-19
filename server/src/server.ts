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
import { SchemaLoader, TableInfo } from "./schemaLoader";
import { extractStatementAtOffset } from "./documentTextService";
import { resolveContext } from "./cursorContextResolver";
import { buildCompletions, resolveTableCompletionItem } from "./completionEngine";

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let schemaLoader: SchemaLoader | null = null;
let tables: TableInfo[] = [];
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

const onInitializedHandler = async () => {
// Auto-connect on startup using legacy settings (backwards compat)
  await connectFromSettings();
};

connection.onInitialized(onInitializedHandler);

async function connectFromSettings() {
  try {
    const config = await connection.workspace.getConfiguration("sqlPrompt");
    const connConfig = config?.connection;
    if (connConfig && connConfig.server && connConfig.database) {
      schemaLoader = new SchemaLoader(connConfig);
      await schemaLoader.connect();
      tables = await schemaLoader.loadSchema();
      connection.console.info(
        `SQL Prompt: connected to ${connConfig.server}/${connConfig.database}. Loaded ${tables.length} tables.`,
      );
    }
  } catch (err: any) {
    connection.console.error(
      `SQL Prompt: connection failed — ${err.message}`,
    );
  }
}

// ── New request: connect via mssql connection string ──────────────────────────
connection.onRequest(
  "sqlPrompt/updateConnection",
  async (params: { connectionString: string }) => {
    try {
      if (schemaLoader) {
        await schemaLoader.disconnect();
        schemaLoader = null;
        tables = [];
      }

      // Log the connection string with password masked for debugging
      const masked = params.connectionString.replace(
        /(Password|PWD)=([^;]*)/gi,
        '$1=***'
      );
      connection.console.info(`SQL Prompt: connecting with — ${masked}`);

      schemaLoader = new SchemaLoader(params.connectionString);
      await schemaLoader.connect();
      tables = await schemaLoader.loadSchema();
      connection.console.info(
        `SQL Prompt: schema updated via mssql connection. Loaded ${tables.length} tables.`,
      );
      return { success: true, tableCount: tables.length };
    } catch (err: any) {
      connection.console.error(
        `SQL Prompt: updateConnection failed — ${err.message}`,
      );
      return { success: false, message: err.message };
    }
  },
);

connection.onRequest(
  "sqlPrompt/updateSchemaSnapshot",
  async (params: { tables: TableInfo[] }) => {
    try {
      if (schemaLoader) {
        await schemaLoader.disconnect();
        schemaLoader = null;
      }

      tables = sanitizeTableSnapshot(Array.isArray(params?.tables) ? params.tables : []);
      connection.console.info(
        `SQL Prompt: schema updated via connectionSharing snapshot. Loaded ${tables.length} tables.`,
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

// Custom request: connect (legacy – uses settings)
connection.onRequest("sqlPrompt/connect", async () => {
  await connectFromSettings();
  return { success: true, tableCount: tables.length };
});

// Custom request: disconnect
connection.onRequest("sqlPrompt/disconnect", async () => {
  if (schemaLoader) {
    await schemaLoader.disconnect();
    schemaLoader = null;
    tables = [];
  }
  return { success: true };
});

// Custom request: reload schema
connection.onRequest("sqlPrompt/reloadSchema", async () => {
  if (schemaLoader) {
    tables = await schemaLoader.loadSchema();
    return { success: true, tableCount: tables.length };
  }
  return { success: false, message: "Not connected" };
});

// ── Completion (new pipeline) ─────────────────────────────────────────────────
//
// Pipeline:
//   document text  →  extractStatementAtOffset (GO / ; aware)
//                  →  resolveContext (token-based: clause, dot, function, scope)
//                  →  buildCompletions (routing by context.clause)

connection.onCompletion(
  (params: TextDocumentPositionParams): CompletionItem[] => {
    connection.console.info(
      `SQL Prompt: onCompletion called, tables loaded: ${tables.length}`,
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

    return buildCompletions(context, tables, document, position, statementRange);
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

documents.listen(connection);
connection.listen();
