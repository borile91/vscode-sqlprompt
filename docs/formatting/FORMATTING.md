# SQL Formatting

## Quick Navigation

| Document | Description |
|---|---|
| [IMPLEMENTATION.md](IMPLEMENTATION.md) | Feature-by-feature implementation guide with test cases |
| [configurations/](configurations/) | Per-category option docs with examples |
| [AllOptions.json](AllOptions.json) | Reference profile listing every supported option |

---

## VS Code Integration

VS Code's extension API allows a single `DocumentFormattingEditProvider` per extension to participate in **Format Document** (`⇧⌥F`) and **Format Document With…**. Because all providers from the same extension share the same display name in the formatter picker, named per-style entries cannot be surfaced through that UI mechanism.

The implementation therefore exposes style selection through two complementary channels:

| Channel | How |
|---|---|
| **Status bar item** | Shows the active style name; click to open the style picker |
| **Command: Select Formatting Style** | `SQL Prompt: Select Formatting Style` in the Command Palette |
| **Per-style commands** | `SQL Prompt: Format with <Style Name>` — one per loaded file; bindable to keyboard shortcuts |
| **Format Document (⇧⌥F)** | Uses the currently active style (set via the picker) |

Setting `"[sql]": { "editor.defaultFormatter": "borile91.vscode-sqlprompt" }` makes our provider the default formatter for all SQL files.

---

## Extension Settings

| Setting | Type | Description |
|---|---|---|
| `sqlPrompt.formatting.stylesFolder` | `string` | Absolute path to the folder containing `.json` style files. Changes take effect immediately without reloading the extension. |
| `sqlPrompt.formatting.activeStyle` | `string` | Name of the currently active style (filename without `.json`, or `metadata.name` from the file). Persisted at workspace or user scope. |

---

## Style File Format

Style files are JSON exports from Redgate SQL Prompt (portable `.json` format, not `.sqlpromptstylev2` XML).

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

See [AllOptions.json](AllOptions.json) for the full set of supported keys.

---

## Configuration Categories

| Category | Config doc | Covers |
|---|---|---|
| `whitespace` | [configurations/whitespace.md](configurations/whitespace.md) | Tabs, line wrapping, semicolons, blank lines |
| `lists` | [configurations/lists.md](configurations/lists.md) | Comma placement and column list alignment |
| `parentheses` | — | Spacing, layout, collapse thresholds |
| `casing` | — | Keywords, functions, data types |
| `dml` | [configurations/dml.md](configurations/dml.md) | SELECT / INSERT / UPDATE / DELETE |
| `ddl` | [configurations/ddl.md](configurations/ddl.md) | CREATE / ALTER / DROP |
| `controlFlow` | [configurations/controlFlow.md](configurations/controlFlow.md) | IF / WHILE / BEGIN-END |
| `cte` | [configurations/cte.md](configurations/cte.md) | WITH clause |
| `variables` | [configurations/variables.md](configurations/variables.md) | DECLARE / SET |
| `joinStatements` | [configurations/joinStatements.md](configurations/joinStatements.md) | JOIN keyword and ON clause alignment |
| `insertStatements` | — | INSERT column and values lists |
| `functionCalls` | [configurations/functionCall.md](configurations/functionCall.md) | Function argument formatting |
| `caseExpressions` | — | CASE / WHEN / THEN / END |
| `operators` | [configurations/operators.md](configurations/operators.md) | AND/OR, BETWEEN, IN |

---

## Architecture

```
client/src/formatter/
├── styleLoader.ts            Reads .json files from the configured folder
├── formatOptionsMapper.ts    Maps SqlPromptStyleJson → formatter engine options
└── sqlFormattingProvider.ts  DocumentFormattingEditProvider implementation
```

The formatter lives entirely in the extension client; the language server is not involved.

## Future Work

- Support file-watcher on `stylesFolder` for live-reload when new style files are added
- Map additional SQL Prompt options: `indentStyle`, CTE alignment, DDL parenthesis layout
- Support `.sqlpromptstylev2` XML format (legacy Redgate export)
