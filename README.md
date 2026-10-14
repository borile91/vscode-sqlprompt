# SQL Prompt for VS Code

SQL Prompt is a SQL Server IntelliSense and formatting extension for VS Code, inspired by Redgate SQL Prompt. It reads the schema of the database you are connected to through the ms-mssql extension and uses it for completion, navigation and scaffolding, and it formats T-SQL with style files exported from Redgate SQL Prompt.

## Features at a glance

**Completion**
- Tables, views and table-valued functions after `FROM`, `JOIN`, `APPLY`, `INSERT INTO`, `UPDATE` and `MERGE`, with an automatic alias (`dbo.PRESTITI_TESTATA AS ot`)
- After `JOIN`, the tables related by a foreign key come first, with the `ON` condition already written (`dbo.Customers AS c ON o.CustomerId = c.CustomerId`); all columns of a composite key are joined with `AND`
- `ON` predicates from foreign keys, column completion qualified with the right alias, `★ Expand all columns` for `SELECT *`
- After `INSERT INTO <table>`: the column list with a matching `VALUES` row; inside `VALUES (...)`: `NULL`, `DEFAULT`, `GETDATE()` and similar
- The keyword that comes next: `ON` after a joined table, `BY` after `ORDER`/`GROUP`, the object type after `ALTER`/`CREATE`/`DROP`, `SET` after `UPDATE <table>`, `AND`/`OR` after a complete predicate…
- Other databases on the same server: `OtherDb.schema.` loads that database on demand
- Scalar functions with their parameters, stored procedures with named parameters after `EXEC`

**Ranking**
- What starts with what you typed comes first: typing `libr` puts `dbo.LIBRI` before `ui.vwLibri`
- Then foreign keys to the tables already in the query, the objects you pick most often (per database), tables before views, leftovers such as `_BAK` and `_OLD` last

**Writing faster**
- Statement shortcuts: `ssf`, `scf`/`sct`, `st<N>`, `ap`/`av`/`af`, plus your own ([details](#statement-shortcuts))
- ALTER scaffolding: `ALTER PROCEDURE ` → pick an object → its current definition replaces the header ([details](#alter-scaffolding))
- Accepting a suggestion replaces the whole word being typed, wherever the cursor is in it (`Biblioteca.dbo.prestitite` → `Biblioteca.dbo.PRESTITI_TESTATA AS ot`)

**Navigation and editing**
- Go to Definition (`F12`) on tables, views, procedures and functions: opens the object's script
- Rename a table alias with `F2`, updating every reference in the statement

**Formatting**
- Format Document with style files exported from Redgate SQL Prompt, leading commas included ([details](#sql-formatter))

## Requirements

- VS Code 1.75+
- SQL Server for VS Code extension (`ms-mssql.mssql`), installed automatically as a dependency
- A reachable SQL Server database

## Getting started

1. Open a `.sql` file.
2. Connect it with ms-mssql (status bar button, or Command Palette > `MS SQL: Connect`).
3. SQL Prompt loads the schema in the background: the status bar shows the progress (`objects…`, `columns…`, `relationships…`, `routine signatures…`). Table completion works as soon as the objects are in; columns, foreign keys and parameters follow.
4. Type `SELECT * FROM ` and pick a table.

```sql
SELECT *
FROM dbo.Orders AS o
    JOIN dbo.Customers AS c ON o.CustomerId = c.CustomerId   -- picked from the JOIN suggestions
WHERE o.
```

## Schema loading and cache

- The schema is loaded **in stages**, so completion is usable before the whole load is done.
- Each database's schema is **cached on disk** and reused after a window reload until the database changes (DDL changes are detected with a cheap check). The cache keeps at most 24 databases for up to 14 days.
- Switching to an editor connected to another database, or running `USE OtherDb`, reloads the schema for that database.
- `SQL Prompt: Reload Schema` forces a fresh load, skipping every cache.
- Long object definitions are read in chunks, so procedures longer than 65,535 characters arrive whole in Go to Definition and ALTER scaffolding. A definition that still arrives incomplete is never inserted.

## Statement shortcuts

Type a shortcut at the start of a line and accept it from the completion list.

| Shortcut | Inserts |
|---|---|
| `ssf` | `SELECT * FROM ` |
| `scf`, `sct` | `SELECT COUNT(*) FROM ` |
| `st<N>` (`st10`, `st25`, `st100`…) | `SELECT TOP N * FROM ` |
| `ap` / `av` / `af` | `ALTER PROCEDURE ` / `ALTER VIEW ` / `ALTER FUNCTION `, then the list of existing objects |

Add your own, or change or remove the built-in ones, with `sqlPrompt.snippets.shortcuts`. `$CURSOR$` marks where the cursor ends up, `\n` starts a new line, and an empty string removes a shortcut:

```json
{
  "sqlPrompt.snippets.shortcuts": {
    "sd": "SELECT DISTINCT ",
    "bt": "BEGIN TRAN;\n$CURSOR$\nROLLBACK;",
    "ssf": "SELECT *\nFROM ",
    "av": ""
  }
}
```

Changes apply immediately, without a reload.

## ALTER scaffolding

Type `ALTER PROCEDURE `, `ALTER VIEW ` or `ALTER FUNCTION ` (also after `CREATE OR`), or use the `ap`/`av`/`af` shortcuts, and start typing a name. The existing objects of that kind are suggested; accepting one replaces the `ALTER ...` header with the **current definition** of the object, with `CREATE` rewritten to `ALTER`, ready to edit.

- The header is rewritten with the object's real `[schema].[name]`, so a definition saved before an `sp_rename` or a schema transfer still alters the right object.
- `ALTER` inside a comment or a string does not trigger it; bracketed names (`[My Proc`) work.
- The list comes from the database of the current editor and is cached for 60 seconds. A notification appears if loading takes longer than a moment.
- If you keep typing while the definition loads, nothing is inserted: your text is never overwritten.
- Encrypted objects, or a missing `VIEW DEFINITION` permission, leave no readable definition: a warning is shown and nothing changes.

## Access to your mssql connections

SQL Prompt reads the schema through the connections you open in the ms-mssql extension; it never asks for credentials itself. Which mssql API it uses depends on the installed version:

- **Newer ms-mssql versions** (shared connections API, after 1.46.0): the first time a connected `.sql` file is synced, **VS Code asks whether SQL Prompt may use your SQL Server (mssql) connections**. Allow it once and later syncs no longer ask. SQL Prompt then opens its own connections from the same connection profiles (one per connection and database, closed when VS Code shuts down). If you decline, SQL Prompt shows one warning and stops asking; run `SQL Prompt: Reload Schema` to be asked again, or allow it from the **Accounts** menu. You can revoke access at any time from **Accounts > Manage Trusted Extensions**, or by signing out of **Shared connections** under **SQL Server (mssql)**.
- **ms-mssql 1.46.0 and earlier**: SQL Prompt uses the older connection sharing API, which ms-mssql has deprecated. ms-mssql shows its own approval dialog, and may show a notice that the API is being retired.
- If the installed ms-mssql offers neither API, SQL Prompt shows one warning and schema-aware features (completion of objects and columns, Go to Definition, ALTER scaffolding) are unavailable; formatting keeps working.

## The mssql extension's own suggestions

ms-mssql has its own IntelliSense, and its suggestions would appear in the same list as SQL Prompt's. VS Code has no way to hide another extension's suggestions other than through a setting, so SQL Prompt turns off `mssql.intelliSense.enableSuggestions` **once**, where `sqlPrompt.suppressMssqlIntellisense` says:

| Value | Effect |
|---|---|
| `user` (default) | Written once in your **User** settings: no project or `.code-workspace` file is touched |
| `workspace` | Written once in this workspace's settings |
| `off` | mssql's suggestions stay on; both lists appear together |

The first time, a notification explains what was changed and lets you pick another option. The value is never toggled on connect or disconnect, and the value that earlier versions left in the workspace settings is removed. Only completion suggestions are affected: Script As, Execute Query and the other ms-mssql features keep working.

## SQL Formatter

SQL Prompt includes a document formatter that integrates with VS Code's **Format Document** command (`⇧⌥F`).

### Style selection

The active formatting style is shown in the status bar. Click it to open the style picker, or use Command Palette > `SQL Prompt: Select Formatting Style`. **Format Document** always uses the active style.

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

The folder is scanned immediately, with no reload required. Every `.json` file in that folder is loaded as a named style. The active style is persisted per workspace via `sqlPrompt.formatting.activeStyle`.

**Example style file** (`MyStyle.json`), with leading commas:

```json
{
  "metadata": { "name": "My Style" },
  "casing": {
    "reservedKeywords": "uppercase"
  },
  "lists": {
    "placeSubsequentItemsOnNewLines": "always",
    "placeCommasBeforeItems": true,
    "addSpaceBeforeComma": true,
    "commaAlignment": "beforeItem"
  },
  "whitespace": {
    "wrapLinesLongerThan": 200
  }
}
```

A safety guard compares the formatted text with the original and discards the result if any code would be lost or moved into a comment.

See [docs/formatting/FORMATTING.md](docs/formatting/FORMATTING.md) for the options the formatter applies today, and [docs/formatting/Defaults.json](docs/formatting/Defaults.json) for the full set of SQL Prompt keys (not all of them are implemented yet).

## Commands

| Command | Description |
|---|---|
| `SQL Prompt: Connect to Database` | Opens the ms-mssql connection flow for the current file |
| `SQL Prompt: Disconnect` | Disconnects the SQL Prompt language server |
| `SQL Prompt: Reload Schema` | Reloads the schema, skipping the caches (also asks again for access to mssql connections if it was declined) |
| `SQL Prompt: Select Formatting Style` | Opens the style picker |

## Settings reference

| Setting | Type | Default | Description |
|---|---|---|---|
| `sqlPrompt.suppressMssqlIntellisense` | `user` \| `workspace` \| `off` | `user` | Where to turn off the ms-mssql extension's own suggestions ([details](#the-mssql-extensions-own-suggestions)) |
| `sqlPrompt.snippets.shortcuts` | object | `{}` | Your statement shortcuts, added to the built-in ones ([details](#statement-shortcuts)) |
| `sqlPrompt.formatting.stylesFolder` | `string` | — | Absolute path to the folder containing `.json` style files |
| `sqlPrompt.formatting.activeStyle` | `string` | — | Name of the active style (filename without `.json`, or `metadata.name` from the file) |
| `sqlPrompt.trace.server` | `off` \| `messages` \| `verbose` | `off` | Traces the communication between VS Code and the language server |

## Packaging and local install (VSIX)

```bash
npm install -g @vscode/vsce
vsce package
code --install-extension vscode-sqlprompt-<version>.vsix
```

Releases are published to the Visual Studio Marketplace and to GitHub Releases automatically on every push to `main` that changes the extension (see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#release-process)).

## Additional documentation

- Development documentation: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
- Formatting guide: [docs/formatting/FORMATTING.md](docs/formatting/FORMATTING.md)
- Planned next work: [docs/ROADMAP.md](docs/ROADMAP.md)
- Commit guidelines: [docs/COMMIT_GUIDELINES.md](docs/COMMIT_GUIDELINES.md)
