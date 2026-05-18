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
  InsertTextFormat
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import { SchemaLoader, TableInfo } from './schemaLoader';

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let schemaLoader: SchemaLoader | null = null;
let tables: TableInfo[] = [];
let hasConfigurationCapability = false;

connection.onInitialize((params: InitializeParams) => {
  connection.console.log('SQL Prompt server: onInitialize called');
  const capabilities = params.capabilities;

  hasConfigurationCapability = !!(
    capabilities.workspace && !!capabilities.workspace.configuration
  );

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: true,
        triggerCharacters: ['.']
      }
    }
  };

  return result;
});

connection.onInitialized(async () => {
  // Auto-connect on startup using settings
  await connectFromSettings();
});

async function connectFromSettings() {
  try {
    const config = await connection.workspace.getConfiguration('sqlPrompt');
    const connConfig = config?.connection;
    if (connConfig && connConfig.server && connConfig.database) {
      schemaLoader = new SchemaLoader(connConfig);
      await schemaLoader.connect();
      tables = await schemaLoader.loadSchema();
      connection.console.log(
        `SQL Prompt: Connected to ${connConfig.server}/${connConfig.database}. Loaded ${tables.length} tables.`
      );
    }
  } catch (err: any) {
    connection.console.error(`SQL Prompt: Connection failed - ${err.message}`);
  }
}

// Custom request: connect
connection.onRequest('sqlPrompt/connect', async () => {
  await connectFromSettings();
  return { success: true, tableCount: tables.length };
});

// Custom request: disconnect
connection.onRequest('sqlPrompt/disconnect', async () => {
  if (schemaLoader) {
    await schemaLoader.disconnect();
    schemaLoader = null;
    tables = [];
  }
  return { success: true };
});

// Custom request: reload schema
connection.onRequest('sqlPrompt/reloadSchema', async () => {
  if (schemaLoader) {
    tables = await schemaLoader.loadSchema();
    return { success: true, tableCount: tables.length };
  }
  return { success: false, message: 'Not connected' };
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
  if (tableName.includes('_')) {
    return tableName
      .split('_')
      .map(part => part.charAt(0).toLowerCase())
      .join('');
  }

  // Case 2: PascalCase or camelCase -> take uppercase letters
  const upperLetters = tableName.match(/[A-Z]/g);
  if (upperLetters && upperLetters.length > 1) {
    return upperLetters.map(l => l.toLowerCase()).join('');
  }

  // Case 3: single word -> first letter
  return tableName.charAt(0).toLowerCase();
}

connection.onCompletion(
  (textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
    connection.console.log(`SQL Prompt: onCompletion called, tables loaded: ${tables.length}`);
    const document = documents.get(textDocumentPosition.textDocument.uri);
    if (!document) {
      connection.console.log('SQL Prompt: document not found in manager');
      return [];
    }

    const position = textDocumentPosition.position;
    const lineText = document.getText({
      start: { line: position.line, character: 0 },
      end: position
    });

    connection.console.log(`SQL Prompt: lineText = "${lineText}"`);
    const completions: CompletionItem[] = [];

    // Check if we're after FROM or JOIN keywords
    const fromJoinPattern = /\b(FROM|JOIN|INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|CROSS\s+JOIN|LEFT\s+OUTER\s+JOIN|RIGHT\s+OUTER\s+JOIN|FULL\s+JOIN|FULL\s+OUTER\s+JOIN)\s+$/i;
    const isAfterFrom = fromJoinPattern.test(lineText);
    connection.console.log(`SQL Prompt: isAfterFrom = ${isAfterFrom}`);

    // Check if we're after a schema prefix like "dbo."
    const schemaPattern = /\b(FROM|JOIN|INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|CROSS\s+JOIN|LEFT\s+OUTER\s+JOIN|RIGHT\s+OUTER\s+JOIN|FULL\s+JOIN|FULL\s+OUTER\s+JOIN)\s+(\w+)\.\s*$/i;
    const schemaMatch = schemaPattern.exec(lineText);

    if (isAfterFrom) {
      // Suggest schema.table AS alias
      tables.forEach((table, index) => {
        const alias = generateAlias(table.name);
        const fullName = `${table.schema}.${table.name}`;
        completions.push({
          label: fullName,
          kind: CompletionItemKind.Class,
          detail: `Table (${table.schema}) - alias: ${alias}`,
          insertText: `${fullName} AS ${alias}`,
          insertTextFormat: InsertTextFormat.PlainText,
          sortText: `0${table.name}`,
          data: { type: 'table', index }
        });
      });
    } else if (schemaMatch) {
      // Filter tables by schema
      const schemaName = schemaMatch[2];
      tables
        .filter(t => t.schema.toLowerCase() === schemaName.toLowerCase())
        .forEach((table, index) => {
          const alias = generateAlias(table.name);
          completions.push({
            label: table.name,
            kind: CompletionItemKind.Class,
            detail: `Table - alias: ${alias}`,
            insertText: `${table.name} AS ${alias}`,
            insertTextFormat: InsertTextFormat.PlainText,
            sortText: `0${table.name}`,
            data: { type: 'table', index }
          });
        });
    } else if (tables.length > 0) {
      // General context: still suggest tables but with lower priority
      // Check if line contains SELECT or common SQL keywords
      const isSqlContext = /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|AND|OR|JOIN)\b/i.test(lineText);
      if (isSqlContext) {
        tables.forEach((table, index) => {
          const alias = generateAlias(table.name);
          const fullName = `${table.schema}.${table.name}`;
          completions.push({
            label: fullName,
            kind: CompletionItemKind.Class,
            detail: `Table (${table.columns.length} columns)`,
            insertText: fullName,
            insertTextFormat: InsertTextFormat.PlainText,
            sortText: `9${table.name}`,
            data: { type: 'table', index }
          });
        });
      }
    }

    return completions;
  }
);

connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
  if (item.data?.type === 'table') {
    const table = tables[item.data.index];
    if (table) {
      item.documentation = {
        kind: 'markdown',
        value: `**${table.schema}.${table.name}**\n\nColumns:\n${table.columns
          .map(c => `- \`${c.name}\` (${c.dataType}${c.isNullable ? ', nullable' : ''})`)
          .join('\n')}`
      };
    }
  }
  return item;
});

documents.listen(connection);
connection.listen();
