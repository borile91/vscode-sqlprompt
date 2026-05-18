import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  CompletionItem,
  CompletionItemKind,
  TextDocumentPositionParams,
  TextDocumentSyncKind,
  InitializeResult,
  InsertTextFormat,
  TextEdit,
  Range,
  Position,
} from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";
import { SchemaLoader, TableInfo } from "./schemaLoader";

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
        triggerCharacters: ["."],
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

      tables = Array.isArray(params?.tables) ? params.tables : [];
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

/**
 * Generates an alias from a table name.
 * Examples:
 *   PRESTITI_DETTAGLIO -> od
 *   ClientiAttivi -> ca
 *   Orders -> o
 *   OrderDetails -> od
 */
function generateAlias(tableName: string): string {
  // Case 1: UPPER_CASE_WITH_UNDERSCORES -> take first letter of each word
  if (tableName.includes("_")) {
    return tableName
      .split("_")
      .map((part) => part.charAt(0).toLowerCase())
      .join("");
  }

  // Case 2: PascalCase or camelCase -> take uppercase letters
  const upperLetters = tableName.match(/[A-Z]/g);
  if (upperLetters && upperLetters.length > 1) {
    return upperLetters.map((l) => l.toLowerCase()).join("");
  }

  // Case 3: single word -> first letter
  return tableName.charAt(0).toLowerCase();
}

/**
 * Computes the Range that should be replaced when a completion item is accepted.
 *
 * Going backwards from the cursor, the range extends over all word chars (\w).
 * When includeDot is true the range also extends over a leading "schema." prefix
 * so that "dbo.Ord" is replaced as a whole by "dbo.Orders AS o".
 */
function computeReplaceRange(
  lineText: string,
  position: Position,
  includeDot: boolean,
): Range {
  const end = position.character;
  let start = end;

  // Extend backwards over word characters (letters, digits, _)
  while (start > 0 && /\w/.test(lineText[start - 1])) {
    start--;
  }

  if (includeDot && start > 0 && lineText[start - 1] === ".") {
    // Also include the dot and the schema prefix
    start--; // consume the dot
    while (start > 0 && /\w/.test(lineText[start - 1])) {
      start--;
    }
  }

  return Range.create(position.line, start, position.line, end);
}

const onCompletionHandler = (
  textDocumentPosition: TextDocumentPositionParams,
): CompletionItem[] => {
  connection.console.info(
    `SQL Prompt: onCompletion called, tables loaded: ${tables.length}`,
  );
    const document = documents.get(textDocumentPosition.textDocument.uri);
    if (!document) {
      connection.console.info("SQL Prompt: document not found in manager");
      return [];
    }

    const position = textDocumentPosition.position;
    const lineText = document.getText({
      start: { line: position.line, character: 0 },
      end: position,
    });

  connection.console.info(`SQL Prompt: lineText = "${lineText}"`);
    const completions: CompletionItem[] = [];

  // Matches: FROM/JOIN followed by whitespace + optional partial word (no dot)
  // e.g. "FROM " or "FROM dbo" — triggers alias-aware completions
  const FROM_PATTERN =
    /\b(FROM|JOIN|INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|CROSS\s+JOIN|LEFT\s+OUTER\s+JOIN|RIGHT\s+OUTER\s+JOIN|FULL\s+JOIN|FULL\s+OUTER\s+JOIN)\s+\w*$/i;
  const isAfterFrom = FROM_PATTERN.test(lineText);

  // Matches: FROM/JOIN + schema + dot + optional partial table name
  // e.g. "FROM dbo." or "FROM dbo.Ord"
  const SCHEMA_PATTERN =
    /\b(FROM|JOIN|INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|CROSS\s+JOIN|LEFT\s+OUTER\s+JOIN|RIGHT\s+OUTER\s+JOIN|FULL\s+JOIN|FULL\s+OUTER\s+JOIN)\s+(\w+)\.\s*(\w*)$/i;
  const schemaMatch = SCHEMA_PATTERN.exec(lineText);

  connection.console.info(
    `SQL Prompt: isAfterFrom=${isAfterFrom}, schemaMatch=${!!schemaMatch}`,
  );

  if (schemaMatch) {
    // ── Schema-qualified context: "dbo.Ord" ──────────────────────────────
    const schemaName = schemaMatch[2];
    // Replace only the part after the dot (wordStart after dot)
    const replaceRange = computeReplaceRange(lineText, position, false);

    tables
      .filter((t) => t.schema.toLowerCase() === schemaName.toLowerCase())
      .forEach((table, index) => {
        const alias = generateAlias(table.name);
        completions.push({
          label: table.name,
          kind: CompletionItemKind.Class,
          detail: `Table — alias: ${alias}`,
          filterText: table.name,
          textEdit: TextEdit.replace(
            replaceRange,
            `${table.name} AS ${alias}`,
          ),
          insertTextFormat: InsertTextFormat.PlainText,
          sortText: `0${table.name}`,
          data: { type: "table", index },
        });
      });
  } else if (isAfterFrom) {
    // ── After FROM/JOIN, no schema dot yet: "FROM " or "FROM dbo" ────────
    // Replace the typed prefix including any partial schema ("dbo" → "dbo.Orders AS o")
    const replaceRange = computeReplaceRange(lineText, position, false);

    tables.forEach((table, index) => {
      const alias = generateAlias(table.name);
      const fullName = `${table.schema}.${table.name}`;
          completions.push({
            label: fullName,
            kind: CompletionItemKind.Class,
            detail: `Table (${table.schema}) — alias: ${alias}`,
            filterText: fullName,
            textEdit: TextEdit.replace(
              replaceRange,
              `${fullName} AS ${alias}`,
            ),
            insertTextFormat: InsertTextFormat.PlainText,
            sortText: `0${table.name}`,
            data: { type: "table", index },
          });
        });
    } else if (tables.length > 0) {
    // ── General SQL context: no alias, lower priority ─────────────────────
    const isSqlContext =
      /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|AND|OR|JOIN)\b/i.test(
        lineText,
      );
      if (isSqlContext) {
        tables.forEach((table, index) => {
          const fullName = `${table.schema}.${table.name}`;
          completions.push({
            label: fullName,
            kind: CompletionItemKind.Class,
            detail: `Table (${table.columns.length} columns)`,
            filterText: fullName,
            insertText: fullName,
            insertTextFormat: InsertTextFormat.PlainText,
            sortText: `9${table.name}`,
            data: { type: "table", index },
          });
        });
      }
    }

    return completions;
};

connection.onCompletion(onCompletionHandler);

connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
  if (item.data?.type === "table") {
    const table = tables[item.data.index];
    if (table) {
      item.documentation = {
        kind: "markdown",
        value: `**${table.schema}.${table.name}**\n\nColumns:\n${table.columns
          .map(
            (c) =>
              `- \`${c.name}\` (${c.dataType}${c.isNullable ? ", nullable" : ""})`,
          )
          .join("\n")}`,
      };
    }
  }
  return item;
});

documents.listen(connection);
connection.listen();
