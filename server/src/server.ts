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

type QueryTableRef = {
  table: TableInfo;
  alias: string;
};

type StatementContext = {
  text: string;
  startOffset: number;
  cursorOffset: number;
};

function getStatementContext(
  document: TextDocument,
  position: Position,
): StatementContext {
  const fullText = document.getText();
  const cursorAbsolute = document.offsetAt(position);

  const statementStart = fullText.lastIndexOf(";", Math.max(0, cursorAbsolute - 1)) + 1;
  const statementEndCandidate = fullText.indexOf(";", cursorAbsolute);
  const statementEnd = statementEndCandidate === -1 ? fullText.length : statementEndCandidate;

  return {
    text: fullText.slice(statementStart, statementEnd),
    startOffset: statementStart,
    cursorOffset: cursorAbsolute - statementStart,
  };
}

function resolveTableIdentifier(identifier: string): TableInfo | undefined {
  const cleaned = identifier.trim();
  if (!cleaned) {
    return undefined;
  }

  const parts = cleaned.split(".");
  if (parts.length >= 2) {
    const schema = parts[parts.length - 2];
    const tableName = parts[parts.length - 1];
    return tables.find(
      (t) =>
        t.schema.toLowerCase() === schema.toLowerCase() &&
        t.name.toLowerCase() === tableName.toLowerCase(),
    );
  }

  return tables.find((t) => t.name.toLowerCase() === cleaned.toLowerCase());
}

function parseQueryTables(sqlText: string): QueryTableRef[] {
  const refs: QueryTableRef[] = [];
  const pattern =
    /\b(?:FROM|(?:INNER|LEFT|RIGHT|FULL|CROSS)(?:\s+OUTER)?\s+JOIN|JOIN)\s+((?:\w+\.)?\w+)(?:\s+(?:AS\s+)?(\w+))?/gi;
  const reserved = new Set([
    "ON",
    "WHERE",
    "GROUP",
    "ORDER",
    "HAVING",
    "JOIN",
    "INNER",
    "LEFT",
    "RIGHT",
    "FULL",
    "CROSS",
  ]);

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sqlText)) !== null) {
    const tableIdentifier = match[1];
    const parsedAlias = match[2];
    const table = resolveTableIdentifier(tableIdentifier);
    if (!table) {
      continue;
    }

    const fallbackAlias = table.name;
    const aliasCandidate = parsedAlias || fallbackAlias;
    const alias = reserved.has(aliasCandidate.toUpperCase())
      ? fallbackAlias
      : aliasCandidate;

    refs.push({ table, alias });
  }

  return refs;
}

function isCursorInSelectProjection(statementText: string, cursorOffset: number): boolean {
  const beforeCursor = statementText.slice(0, cursorOffset);
  const lowerBefore = beforeCursor.toLowerCase();
  const selectPos = lowerBefore.lastIndexOf("select");
  if (selectPos === -1) {
    return false;
  }

  const lowerStatement = statementText.toLowerCase();
  const fromPos = lowerStatement.indexOf(" from ", selectPos);
  return fromPos === -1 || cursorOffset <= fromPos;
}

function buildJoinOnClauseCompletions(
  refs: QueryTableRef[],
  position: Position,
): CompletionItem[] {
  if (refs.length < 2) {
    return [];
  }

  const joinRef = refs[refs.length - 1];
  const previousRefs = refs.slice(0, -1);
  const generated = new Set<string>();
  const items: CompletionItem[] = [];

  for (const prevRef of previousRefs) {
    for (const fk of joinRef.table.foreignKeys || []) {
      const matchesPrev =
        fk.referencedSchema.toLowerCase() === prevRef.table.schema.toLowerCase() &&
        fk.referencedTable.toLowerCase() === prevRef.table.name.toLowerCase();
      if (!matchesPrev || !fk.mappings.length) {
        continue;
      }

      const predicate = fk.mappings
        .map(
          (m) =>
            `${joinRef.alias}.${m.column} = ${prevRef.alias}.${m.referencedColumn}`,
        )
        .join(" AND ");
      const clause = `ON ${predicate}`;

      if (generated.has(clause)) {
        continue;
      }
      generated.add(clause);

      items.push({
        label: `ON (${joinRef.alias} -> ${prevRef.alias})`,
        kind: CompletionItemKind.Keyword,
        detail: `FK ${joinRef.table.schema}.${joinRef.table.name} -> ${prevRef.table.schema}.${prevRef.table.name}`,
        textEdit: TextEdit.replace(
          Range.create(position.line, position.character, position.line, position.character),
          `${clause} `,
        ),
        sortText: `00_${joinRef.alias}_${prevRef.alias}`,
      });
    }

    for (const fk of prevRef.table.foreignKeys || []) {
      const matchesJoin =
        fk.referencedSchema.toLowerCase() === joinRef.table.schema.toLowerCase() &&
        fk.referencedTable.toLowerCase() === joinRef.table.name.toLowerCase();
      if (!matchesJoin || !fk.mappings.length) {
        continue;
      }

      const predicate = fk.mappings
        .map(
          (m) =>
            `${prevRef.alias}.${m.column} = ${joinRef.alias}.${m.referencedColumn}`,
        )
        .join(" AND ");
      const clause = `ON ${predicate}`;

      if (generated.has(clause)) {
        continue;
      }
      generated.add(clause);

      items.push({
        label: `ON (${prevRef.alias} -> ${joinRef.alias})`,
        kind: CompletionItemKind.Keyword,
        detail: `FK ${prevRef.table.schema}.${prevRef.table.name} -> ${joinRef.table.schema}.${joinRef.table.name}`,
        textEdit: TextEdit.replace(
          Range.create(position.line, position.character, position.line, position.character),
          `${clause} `,
        ),
        sortText: `00_${prevRef.alias}_${joinRef.alias}`,
      });
    }
  }

  return items;
}

function buildStarExpansionCompletion(
  document: TextDocument,
  statement: StatementContext,
  refs: QueryTableRef[],
): CompletionItem[] {
  if (!refs.length) {
    return [];
  }

  const beforeCursor = statement.text.slice(0, statement.cursorOffset);
  const aliasStarMatch = /(\b\w+)\.\*$/.exec(beforeCursor);
  const plainStarMatch = !aliasStarMatch ? /\*$/.exec(beforeCursor) : null;

  if (!aliasStarMatch && !plainStarMatch) {
    return [];
  }

  const absoluteEnd = statement.startOffset + statement.cursorOffset;
  let absoluteStart = absoluteEnd - 1;
  let replacement = "";

  if (aliasStarMatch) {
    const alias = aliasStarMatch[1];
    absoluteStart = absoluteEnd - (alias.length + 2);

    const ref = refs.find((r) => r.alias.toLowerCase() === alias.toLowerCase());
    if (!ref) {
      return [];
    }
    replacement = ref.table.columns
      .map((c) => `${ref.alias}.${c.name}`)
      .join(", ");
  } else {
    replacement = refs
      .flatMap((ref) => ref.table.columns.map((c) => `${ref.alias}.${c.name}`))
      .join(", ");
  }

  if (!replacement) {
    return [];
  }

  const startPos = document.positionAt(absoluteStart);
  const endPos = document.positionAt(absoluteEnd);

  return [
    {
      label: "Expand wildcard to columns",
      kind: CompletionItemKind.Snippet,
      detail: "Expand * using tables in current query",
      textEdit: TextEdit.replace(
        Range.create(startPos.line, startPos.character, endPos.line, endPos.character),
        replacement,
      ),
      insertTextFormat: InsertTextFormat.PlainText,
      sortText: "00_expand_star",
    },
  ];
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
  const statement = getStatementContext(document, position);
  const queryRefs = parseQueryTables(statement.text);

  connection.console.info(`SQL Prompt: lineText = "${lineText}"`);
    const completions: CompletionItem[] = [];

  const afterJoinTargetPattern =
    /\b(?:JOIN|INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|CROSS\s+JOIN|LEFT\s+OUTER\s+JOIN|RIGHT\s+OUTER\s+JOIN|FULL\s+JOIN|FULL\s+OUTER\s+JOIN)\s+(?:\w+\.)?\w+(?:\s+(?:AS\s+)?\w+)?\s*$/i;
  const beforeCursorStatement = statement.text.slice(0, statement.cursorOffset);
  const shouldSuggestOnClause = afterJoinTargetPattern.test(beforeCursorStatement);

  if (shouldSuggestOnClause && queryRefs.length > 1) {
    completions.push(...buildJoinOnClauseCompletions(queryRefs, position));
  }

  if (isCursorInSelectProjection(statement.text, statement.cursorOffset) && queryRefs.length) {
    for (const ref of queryRefs) {
      for (const column of ref.table.columns) {
        const qualified = `${ref.alias}.${column.name}`;
        completions.push({
          label: qualified,
          kind: CompletionItemKind.Field,
          detail: `${ref.table.schema}.${ref.table.name}`,
          insertText: qualified,
          insertTextFormat: InsertTextFormat.PlainText,
          sortText: `10_${qualified}`,
        });
      }
    }

    completions.push(...buildStarExpansionCompletion(document, statement, queryRefs));
  }

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
