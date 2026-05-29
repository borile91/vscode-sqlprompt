# SQL Prompt for VS Code

SQL Prompt is a SQL Server IntelliSense and formatting extension for VS Code. It provides schema-aware table completion with automatic aliasing and a configurable SQL formatter driven by style files, inspired by tools like Redgate SQL Prompt.

## What this extension does

- Uses your active ms-mssql connection for the current SQL file
- Suggests schema-qualified table names after `FROM` and `JOIN`
- Inserts automatic aliases, for example `dbo.TABLE_NAME AS tn`
- Reloads schema context when you switch to another `.sql` file with a different active connection
- Formats SQL documents using configurable style files (JSON exports from Redgate SQL Prompt)

## Requirements

- VS Code 1.75+
- SQL Server for VS Code extension (`ms-mssql.mssql`)
- A reachable SQL Server database

Note: `ms-mssql.mssql` is an extension dependency and is installed automatically when needed.

## First-time setup

1. Open a `.sql` file in VS Code.
2. Connect to your database using ms-mssql:
   - Status bar button, or
   - Command Palette > `MS SQL: Connect`
3. Wait a moment for SQL Prompt to detect the active connection and load schema metadata.
4. Start typing a query and trigger completion after `FROM` or `JOIN`.

Example:

```sql
SELECT *
FROM |
```

Typical suggestions:

- `dbo.TABLE_NAME AS tn`
- `dbo.Orders AS o`
- `dbo.OrderDetails AS od`

## SQL Formatter

SQL Prompt includes a document formatter that integrates with VS Code's **Format Document** command (`⇧⌥F`).

### Style selection

The active formatting style is shown in the status bar. Click it to open the style picker, or use:

- Command Palette > `SQL Prompt: Select Formatting Style`
- `SQL Prompt: Format with <Style Name>` — one command per loaded style file, bindable to keyboard shortcuts

To make SQL Prompt the default formatter for SQL files, add this to your `settings.json`:

```json
{
  "[sql]": {
    "editor.defaultFormatter": "borile91.vscode-sqlprompt"
  }
}
```

### Configuring the styles folder

Style files are standard JSON exports from Redgate SQL Prompt. Point the extension to the folder that contains them:

```json
{
  "sqlPrompt.formatting.stylesFolder": "/path/to/your/styles"
}
```

The folder is scanned immediately — no reload required. Every `.json` file in that folder is loaded as a named style. The active style is persisted per workspace via `sqlPrompt.formatting.activeStyle`.

**Example style file** (`MyStyle.json`):

```json
{
  "metadata": { "name": "My Style" },
  "casing": {
    "reservedKeywords": "uppercase"
  },
  "lists": {
    "placeCommasBeforeItems": true,
    "commaAlignment": "toList"
  },
  "whitespace": {
    "wrapLinesLongerThan": 200
  }
}
```

See [docs/formatting/Defaults.json](docs/formatting/Defaults.json) for the full set of supported keys, and [docs/formatting/FORMATTING.md](docs/formatting/FORMATTING.md) for the complete option reference.

## Commands

| Command | Description |
|---|---|
| `SQL Prompt: Connect to Database` | Opens the ms-mssql connection flow for the current file |
| `SQL Prompt: Disconnect` | Disconnects the SQL Prompt language server |
| `SQL Prompt: Reload Schema` | Forces a schema reload |
| `SQL Prompt: Select Formatting Style` | Opens the style picker |
| `SQL Prompt: Format with <Style Name>` | Formats the document using a specific style |

## Settings reference

| Setting | Type | Default | Description |
|---|---|---|---|
| `sqlPrompt.suppressMssqlIntellisense` | `boolean` | `true` | Suppresses ms-mssql completion suggestions while SQL Prompt is connected |
| `sqlPrompt.formatting.stylesFolder` | `string` | — | Absolute path to the folder containing `.json` style files |
| `sqlPrompt.formatting.activeStyle` | `string` | — | Name of the active style (filename without `.json`, or `metadata.name` from the file) |

## IntelliSense behavior and automatic suppression

SQL Prompt can automatically suppress the ms-mssql extension's IntelliSense so that SQL Prompt completions appear first while you are connected. This suppression only affects completion suggestions — other ms-mssql features (Script As, Alter/Modify Procedure, Execute Query, connection sharing, etc.) remain available.

Set `sqlPrompt.suppressMssqlIntellisense` to `false` to let both providers coexist (you may see duplicate suggestions).

If changes do not apply immediately, run `Developer: Reload Window` from the Command Palette.

## Packaging and local install (VSIX)

```bash
npm install -g @vscode/vsce
vsce package
code --install-extension vscode-sqlprompt-0.1.0.vsix
```

## Additional documentation

- Development documentation: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
- Formatting guide: [docs/formatting/FORMATTING.md](docs/formatting/FORMATTING.md)
- Planned next work: [docs/ROADMAP.md](docs/ROADMAP.md)
- Commit guidelines: [docs/COMMIT_GUIDELINES.md](docs/COMMIT_GUIDELINES.md)