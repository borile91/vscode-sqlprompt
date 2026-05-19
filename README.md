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

## Recommended setting (avoid duplicate completion items)

Because ms-mssql also provides IntelliSense for `.sql` files, you may see duplicate suggestions if both engines are active.

To use SQL Prompt completion only, disable ms-mssql IntelliSense:

```json
{
  "mssql.intelliSense.enableIntellisense": false
}
```

You can set this in workspace settings (`.vscode/settings.json`) or user settings.

If changes do not apply immediately, run `Developer: Reload Window` from the Command Palette.

## Optional fallback connection setting

If ms-mssql is not connected, SQL Prompt can use `sqlPrompt.connection` from your settings:

```json
{
  "sqlPrompt.connection": {
    "server": "localhost",
    "database": "MyDatabase",
    "user": "sa",
    "password": "YourPassword",
    "port": 1433,
    "trustServerCertificate": true
  }
}
```

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