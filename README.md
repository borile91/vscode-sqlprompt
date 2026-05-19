# SQL Prompt for VS Code

SQL Prompt is a SQL Server IntelliSense extension for VS Code. It provides schema-aware table completion and automatically adds aliases, inspired by tools like Redgate SQL Prompt.

## What this extension does

- Uses your active ms-mssql connection for the current SQL file
- Suggests schema-qualified table names after `FROM` and `JOIN`
- Inserts automatic aliases, for example `dbo.OrderDetails AS od`
- Reloads schema context when you switch to another `.sql` file with a different active connection

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

- `dbo.PRESTITI_DETTAGLIO AS od`
- `dbo.OrderDetails AS od`
- `dbo.Orders AS o`

## Commands

| Command | Description |
|---|---|
| `SQL Prompt: Connect to Database` | Opens the ms-mssql connection flow for the current file |
| `SQL Prompt: Disconnect` | Disconnects the SQL Prompt language server |
| `SQL Prompt: Reload Schema` | Forces a schema reload |

## IntelliSense behavior and automatic suppression

SQL Prompt can automatically suppress the ms-mssql extension's IntelliSense so that SQL Prompt completions appear first while you are connected. This suppression only affects completion suggestions — other ms-mssql features (Script As, Alter/Modify Procedure, Execute Query, connection sharing, etc.) remain available.

Control this behaviour with the `sqlPrompt.suppressMssqlIntellisense` setting (default: `true`). When enabled, SQL Prompt will set a workspace-level override to disable ms-mssql's suggestion provider while SQL Prompt is connected. Set it to `false` to let both providers coexist (you may see duplicate suggestions).

Example:

```json
{
  "sqlPrompt.suppressMssqlIntellisense": true
}
```

If changes do not apply immediately, run `Developer: Reload Window` from the Command Palette.

## Packaging and local install (VSIX)

```bash
npm install -g @vscode/vsce
vsce package
code --install-extension vscode-sqlprompt-0.1.0.vsix
```

## Additional documentation

- Development documentation: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
- Planned next work: [docs/ROADMAP.md](docs/ROADMAP.md)
- Commit guidelines: [docs/COMMIT_GUIDELINES.md](docs/COMMIT_GUIDELINES.md)
- Copilot instructions: [.github/copilot-instructions.md](.github/copilot-instructions.md)