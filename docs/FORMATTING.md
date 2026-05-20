# SQL Formatting

## Overview

The extension can format SQL documents using style profiles exported from Redgate SQL Prompt (`.json` format). A folder containing one or more style files is configured once; the extension loads each file and makes the style selectable.

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

## Configuration

| Setting | Type | Description |
|---|---|---|
| `sqlPrompt.formatting.stylesFolder` | `string` | Absolute path to the folder containing `.json` style files. Changes take effect immediately without reloading the extension. |
| `sqlPrompt.formatting.activeStyle` | `string` | Name of the currently active style (filename without `.json`, or `metadata.name` from the file). Persisted at workspace or user scope. |

## Style File Format

The extension reads the **JSON export** format produced by Redgate SQL Prompt (the new portable format, not `.sqlpromptstylev2` XML).

Example file structure:

```json
{
  "metadata": { "name": "My Style" },
  "casing": {
    "reservedKeywords": "uppercase",
    "builtInFunctions": "uppercase",
    "builtInDataTypes": "uppercase"
  },
  "lists": {
    "placeCommasBeforeItems": true
  },
  "whitespace": {
    "wrapLinesLongerThan": 120
  },
  "operators": {
    "andOr": { "alignment": "toFirstListItem" }
  }
}
```

## Formatting Engine

Formatting is performed by [`sql-formatter`](https://github.com/sql-formatter-org/sql-formatter) (T-SQL dialect). The style JSON is mapped to its options as follows:

| Style JSON field | sql-formatter option | Notes |
|---|---|---|
| `casing.reservedKeywords` | `keywordCase` | `"uppercase"` → `"upper"`, `"lowercase"` → `"lower"`, else `"preserve"` |
| `casing.builtInFunctions` | `functionCase` | Same mapping |
| `casing.builtInDataTypes` | `dataTypeCase` | Same mapping |
| `lists.placeCommasBeforeItems` | `commaPosition` | `true` → `"before"`, `false` → `"after"` |
| `whitespace.wrapLinesLongerThan` | `expressionWidth` | Defaults to `80` if not set |
| `operators.andOr.alignment` | `logicalOperatorNewline` | `"afterOperator"` → `"after"`, all others → `"before"` |

Options not covered by `sql-formatter` (detailed JOIN alignment, DDL parenthesis style, CASE indentation, etc.) are silently ignored. The covered subset produces correct keyword casing, comma placement, and line-wrap behaviour.

## Architecture

```
client/src/formatter/
├── styleLoader.ts          Reads .json files from the configured folder
├── formatOptionsMapper.ts  Maps SqlPromptStyleJson → sql-formatter FormatOptionsWithLanguage
└── sqlFormattingProvider.ts  DocumentFormattingEditProvider implementation
```

The formatter lives entirely in the extension client; the language server is not involved.

## Future Work

- Support file-watcher on `stylesFolder` for live-reload when new style files are added
- Map additional SQL Prompt options: `indentStyle`, CTE alignment, DDL parenthesis layout
- Support `.sqlpromptstylev2` XML format (legacy Redgate export)
