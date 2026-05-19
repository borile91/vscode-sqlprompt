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
│       └── extension.ts
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
│       ├── sqlLexer.ts
│       ├── types.ts
│       ├── utils.ts
│       └── __tests__/
└── .vscode/
```

## Architecture overview

- `client/src/extension.ts`: VS Code extension entry point and Language Client lifecycle.
- `server/src/server.ts`: Language Server Protocol endpoint and request handling.
- `server/src/schemaLoader.ts`: SQL Server schema loading and refresh logic.
- `server/src/completionEngine.ts`: completion generation based on context and schema.
- `server/src/cursorContextResolver.ts`: determines SQL cursor context around current position.

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
- Unit tests are under `server/src/__tests__/`

## Contribution language and commits

- Keep repository artifacts in English.
- Follow commit message rules in [COMMIT_GUIDELINES.md](COMMIT_GUIDELINES.md).
- Copilot behavior and language policy are defined in [../.github/copilot-instructions.md](../.github/copilot-instructions.md).

## LSP flow (high level)

1. Client starts the language server.
2. Client tracks active SQL editor and active ms-mssql connection.
3. Client sends connection updates to server (`sqlPrompt/updateConnection`).
4. Server refreshes schema when needed.
5. On completion requests, server resolves cursor context and returns completion items.
