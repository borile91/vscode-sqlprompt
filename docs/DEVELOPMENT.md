# Development Guide

This document is for contributors and maintainers.

## Project structure

```text
vscode-sqlprompt/
├── package.json
├── tsconfig.json
├── client/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── extension.ts
│       ├── alterScaffold.ts
│       ├── mssql/
│       ├── schema/
│       ├── formatter/
│       └── __tests__/
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── server.ts
│       ├── completionEngine.ts
│       ├── cursorContextResolver.ts
│       ├── documentTextService.ts
│       ├── schemaLoader.ts
│       ├── scopeBuilder.ts
│       ├── aliasRename.ts
│       ├── sqlLexer.ts
│       ├── types.ts
│       ├── utils.ts
│       └── __tests__/
└── .vscode/
```

## Architecture overview

- `client/src/extension.ts`: VS Code extension entry point and Language Client lifecycle.
- `client/src/alterScaffold.ts`: pure helpers behind the `ALTER PROCEDURE|VIEW|FUNCTION` scaffolding (header detection, queries, CREATE → ALTER rewrite).
- `client/src/formatter/`: the SQL formatter (style loading, `sql-formatter` options mapping, post-processing passes, safety guard). See [formatting/FORMATTING.md](formatting/FORMATTING.md).
- `client/src/mssql/`: the only place that knows the ms-mssql extension API. `extension.ts` goes through `SchemaAccessProvider` (`connectionProvider.ts`) and never calls the mssql API directly.
  - `connectionProvider.ts`: the provider interface and `selectSchemaAccess`, which picks the backend from what the installed ms-mssql offers (capability detection).
  - `sharedConnectionsBackend.ts`: backend on `getSharedConnectionsApi(1)` (ms-mssql after 1.46.0): access token from the `mssql-shared-connections` authentication provider (user consent, in-memory cache, one renewal when mssql rejects it) and a pool of SQL Prompt's own connections keyed by `connectionId|database`.
  - `legacyBackend.ts`: backend on the deprecated `connectionSharing` API (ms-mssql 1.46.0 and earlier), querying the editor URI directly.
  - `mssqlApi.ts`: minimal local typings of the mssql API (no up-to-date npm package exists).
  - `vscodeSchemaAccess.ts`: the VS Code glue (extension activation, `authentication.getSession`, user messages). Every other file in the folder is free of `vscode` imports and unit-tested with fake API objects.
- `server/src/server.ts`: Language Server Protocol endpoint and request handling.
- `server/src/schemaLoader.ts`: SQL Server schema loading and refresh logic.
- `server/src/completionEngine.ts`: completion generation based on context and schema.
- `server/src/cursorContextResolver.ts`: determines SQL cursor context around current position.
- `server/src/aliasRename.ts`: finds every occurrence of a table alias inside a statement (rename support).

## Local development setup

From repository root:

```bash
npm install
npm run compile
```

## Run in Extension Development Host

1. Open this folder in VS Code.
2. Press `F5` (Run > Start Debugging).
3. In the new Extension Development Host window, open a `.sql` file.
4. Connect using ms-mssql and test completion.

## Build and test notes

- Build task: `npm run compile`
- Watch mode: `npm run watch`
- Server unit tests are under `server/src/__tests__/` (`cd server && npm test`)
- Client unit tests, including the formatter and its example fixtures, are under `client/src/**/__tests__/` (`cd client && npm test`); see [formatting/FORMATTING.md](formatting/FORMATTING.md#tests). New client test files must be added to the `test` script in `client/package.json`

## Release process

1. Run the `Release Extension` workflow manually from GitHub Actions.
2. Select the release type. The default `patch` option increments the revision automatically, for example `0.1.0` to `0.1.1`.
3. The workflow updates `package.json` and `package-lock.json`, builds the extension, packages `vscode-sqlprompt.vsix`, commits the version bump, creates the matching Git tag, and pushes both commit and tag.
4. The workflow uploads the VSIX file to the workflow artifacts and publishes it as a downloadable asset on the GitHub release.

## Contribution language and commits

- Keep repository artifacts in English.
- Follow commit message rules in [COMMIT_GUIDELINES.md](COMMIT_GUIDELINES.md).
- Copilot behavior and language policy are defined in [../.github/copilot-instructions.md](../.github/copilot-instructions.md).

## LSP flow (high level)

1. Client starts the language server.
2. Client tracks active SQL editor and active ms-mssql connection (through `SchemaAccessProvider`).
3. Client sends connection updates to server (`sqlPrompt/updateConnection`).
4. Server refreshes schema when needed.
5. On completion requests, server resolves cursor context and returns completion items.
