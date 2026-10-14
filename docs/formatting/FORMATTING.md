# SQL Formatting

The extension formats T-SQL documents with **style profiles exported from Redgate SQL Prompt** (portable `.json` format). A folder of style files is configured once; each file becomes a selectable style, and **Format Document** applies the active one.

This page describes what the formatter **actually does today**. The documents below describe the target behaviour, which is wider than what is implemented.

| Document | Description |
|---|---|
| [IMPLEMENTATION.md](IMPLEMENTATION.md) | Target behaviour, option by option, with input → expected output pairs |
| [configurations/](configurations/) | Per-category option examples |
| [Defaults.json](Defaults.json) | Reference profile listing every SQL Prompt option (implemented or not) |
| [example-not-passing/](example-not-passing/) | Fixtures that do not format correctly yet, with the analysis of each problem |

---

## Using the formatter in VS Code

### Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `sqlPrompt.formatting.stylesFolder` | `string` | `""` | Absolute path to the folder containing the `.json` style files. Changing it reloads the styles immediately, no window reload needed. |
| `sqlPrompt.formatting.activeStyle` | `string` | `""` | Name of the active style (`metadata.name`, or the file name without `.json`). Written by the style picker at **workspace** scope; can also be set by hand. |

Both settings have `resource` scope, so they can differ per workspace folder.

### Selecting a style

| Entry point | Behaviour |
|---|---|
| **Status bar item** | Shows the active style name (or `No SQL style`); click it to open the style picker |
| **`SQL Prompt: Select Formatting Style`** | Command Palette entry; rescans `stylesFolder`, then opens the picker |
| **Format Document** (`⇧⌥F`) | Formats the whole document with the active style |

There is **one formatting provider** and **no per-style command**: VS Code shows a single entry per extension in the **Format Document With…** picker, so the style is chosen through the picker above, not through the formatter picker.

To make the extension the default formatter for SQL files:

```json
{
  "[sql]": {
    "editor.defaultFormatter": "borile91.vscode-sqlprompt"
  }
}
```

The provider is registered for `sql` documents with the `file` and `untitled` schemes. **Format Selection** is not supported.

### What happens when formatting cannot run

| Situation | Result |
|---|---|
| No active style (empty setting, or a name not found in the folder) | An information message asks to run `SQL Prompt: Select Formatting Style`; the document is not changed |
| The formatting engine throws (e.g. a syntax it cannot parse) | The document is not changed |
| The result would alter the query (see [Safety guard](#safety-guard)) | A warning names what would have changed; the document is not changed |

---

## Style files

The extension reads the **JSON export** produced by Redgate SQL Prompt, not the legacy `.sqlpromptstylev2` XML format.

Loading rules (`styleLoader.ts`):

- every `*.json` file **directly** inside `stylesFolder` is loaded; subfolders are ignored;
- the style name is `metadata.name`, or the file name without `.json` when the name is missing;
- files that cannot be read or parsed are **skipped silently**;
- styles are sorted by name; if two files share a name, the first one in that order wins;
- the folder is rescanned when `stylesFolder` changes and every time the picker is opened. Files added later are not picked up until then (there is no file watcher).

Minimal example:

```json
{
  "metadata": { "name": "My Style" },
  "casing": {
    "reservedKeywords": "uppercase",
    "builtInFunctions": "uppercase",
    "builtInDataTypes": "uppercase"
  },
  "lists": {
    "placeCommasBeforeItems": true,
    "placeSubsequentItemsOnNewLines": "always"
  },
  "whitespace": {
    "numberOfSpacesInTabs": 4,
    "wrapLinesLongerThan": 120
  }
}
```

Unknown keys are ignored, so a complete SQL Prompt export can be used as is.

---

## How a document is formatted

Formatting runs entirely in the extension client (`client/src/formatter/`); the language server is not involved. It has three stages.

### 1. Base formatting with `sql-formatter`

The document is first formatted by [`sql-formatter`](https://github.com/sql-formatter-org/sql-formatter) 15.x with the `tsql` dialect. `formatOptionsMapper.ts` maps the style to its options:

| Style key | `sql-formatter` option | Mapping |
|---|---|---|
| — | `language` | Always `tsql` |
| `whitespace.numberOfSpacesInTabs` | `tabWidth` | Default `4` |
| `whitespace.spacesOrTabs` | `useTabs` | `true` only for `onlyTabs` |
| `whitespace.newLines.emptyLinesBetweenStatements` | `linesBetweenQueries` | Default `1` |
| `casing.reservedKeywords` | `keywordCase` | `uppercase` → `upper`, `lowercase` → `lower`, anything else → `preserve` |
| `casing.builtInFunctions` | `functionCase` | Same mapping |
| `casing.builtInDataTypes` | `dataTypeCase` | Same mapping |
| `whitespace.wrapLongLines` / `wrapLinesLongerThan` | `expressionWidth` | `wrapLongLines: false` → `9999` (no wrapping); otherwise `wrapLinesLongerThan` when set |
| `joinStatements.join.keywordAlignment` + `lists.placeCommasBeforeItems` | `indentStyle` | `tabularLeft` when `keywordAlignment` is `toTable` **and** commas are placed before items |
| `operators.andOr.alignment` | `logicalOperatorNewline` | `afterOperator` → `after`, anything else → `before` |

The casing options are only set when the style has a `casing` section; otherwise `sql-formatter` keeps its defaults.

### 2. SQL Prompt post-processing

`sql-formatter` does not know most SQL Prompt options, so `formatSqlText` in `formatPipeline.ts` runs a sequence of post-processing passes on its output. It is the only implementation of the pipeline and has no `vscode` dependency: `sqlFormattingProvider.ts` and the fixture suite both call it, so the tests exercise exactly what ships. The order matters: several passes rely on the layout produced by the previous ones. In order:

| Pass | Module | What it does |
|---|---|---|
| SET line joining | `keywordPaddingFormatter.ts` | Rejoins `SET <option>` / `SET @var = …` that `sql-formatter` splits on two lines |
| Keyword re-padding | `keywordPaddingFormatter.ts` | Replaces the fixed keyword column of `tabularLeft` with the minimum width needed by each query block |
| Spaces inside parentheses | `formatPipeline.ts` | `IN`, `TOP`, `EXISTS`, `ANY`, `ALL`, `SOME`, `IF`/`WHILE` conditions (single-line groups only) |
| Single-statement `IF` / `WHILE` | `formatPipeline.ts` | Puts a one-statement body on its own line (skipped with `controlFlow.collapseShortStatements`) |
| `DECLARE` | `declareFormatter.ts` | Variable lists, data type and value alignment |
| Procedures and functions | `ddlFormatter.ts` | Parameter list layout, `AS` placement, parameterless procedures |
| Views and tables | `ddlFormatter.ts` | `CREATE VIEW … AS` layout; `CREATE TABLE` column and constraint layout |
| `STUFF(… FOR XML PATH …)` | `stuffFormatter.ts` | Layout of the string-aggregation idiom |
| Comma lists | `listFormatter.ts` | Leading or trailing commas, item breaking, alias and comment alignment, `INSERT` column lists |
| `CASE` | `caseFormatter.ts` | Collapses `CASE … END` before the list pass, then re-expands it with `WHEN` / `ELSE` / `END` placement |
| Compact clauses | `scriptingFormatter.ts` | With `lists.placeSubsequentItemsOnNewLines: never`: `SELECT` / `FROM` / `WHERE` / `ORDER BY` items on the keyword line, `GROUP BY` / `HAVING` items packed; commas only between list items |
| `JOIN … ON` | `joinFormatter.ts` | `JOIN` indentation, `ON` placement and condition alignment, inline `OUTER APPLY` |
| DDL data types | `ddlFormatter.ts` | Vertical alignment of column data types |
| Control flow | `controlFlowFormatter.ts` | `BEGIN` / `END` indentation and content indentation of `IF`, `WHILE`, `ELSE` |
| Semicolons | `semicolonFormatter.ts` | Space or line break before `;` |
| Procedure body | `ddlFormatter.ts` | Indents the body of procedures and functions |
| Short control flow | `scriptingFormatter.ts` | With `controlFlow.collapseShortStatements`: `IF` / `WHILE` and a one-statement body on one line when shorter than `controlFlow.collapseStatementsShorterThan` |
| `OUTER APPLY` | `joinFormatter.ts` | Inline `OUTER` / `CROSS APPLY` subqueries |
| Compact statements | `scriptingFormatter.ts` | With `lists.placeSubsequentItemsOnNewLines: never`: `EXEC` and `DECLARE` packing, short `INSERT` / `VALUES` / `UPDATE` and `IF [NOT] EXISTS` on one line (thresholds from `dml` and `controlFlow`) |
| `EXEC` | `execFormatter.ts` | Parameter list layout of `EXEC` calls |
| Clean-up | `formatPipeline.ts` | `GO` separators and blank lines (`emptyLinesAfterBatchSeparator: 0`), `ALTER TABLE … ADD CONSTRAINT`, `FOREIGN KEY` expansion and wrapping, short `EXISTS` subqueries, spacing around `(` |

The passes that join lines never append code after a `--` comment: when a line to join ends with a comment, the lines are left as they are.

If `formatSqlText` throws, the provider logs the error to the console, shows it to the user and leaves the document unchanged.

### 3. Safety guard

Formatting is cosmetic, so it must never change what the query does. `formatGuard.ts` compares the significant characters of the original and of the result, **ignoring whitespace, letter case and `;`**. If any other character was added or removed (in practice, almost always a comma), the edit is discarded and a warning names the difference, for example `removed 1 ","`.

The same count is repeated on the code alone, with comments stripped, so a pass that moves code into or out of a `--` comment is rejected too. Other characters that only **move** (for example a parenthesis moved to the wrong place) are not detected.

---

## Supported options

The tables list the style keys the formatter reads today. **Any other key is accepted and ignored**, including keys that `styleLoader.ts` already declares in its type: declaring a key is not the same as implementing it.

### Casing and whitespace

| Key | Values | Effect |
|---|---|---|
| `casing.reservedKeywords` | `uppercase`, `lowercase`, `preserveCase` | Keyword case (engine, plus `BEGIN` / `END` / `ELSE` in the control flow pass) |
| `casing.builtInFunctions` | same | Built-in function case |
| `casing.builtInDataTypes` | same | Data type case |
| `whitespace.numberOfSpacesInTabs` | number (default `4`) | Indent width, used by every pass |
| `whitespace.spacesOrTabs` | `onlySpaces`, `onlyTabs`, `spacesAndTabs` | Tabs only with `onlyTabs` |
| `whitespace.wrapLongLines` | boolean | `false` disables wrapping |
| `whitespace.wrapLinesLongerThan` | number | Maximum line length for the engine and for the list, `DECLARE`, `EXEC`, `SET` and `FOREIGN KEY` wrapping |
| `whitespace.whiteSpaceBeforeSemiColon` | `none`, `spaceBefore`, `newLineBefore` | Placement of `;` |
| `whitespace.newLines.emptyLinesBetweenStatements` | number (default `1`) | Blank lines between statements |
| `whitespace.newLines.emptyLinesAfterBatchSeparator` | `0` or other | `0` removes the blank line after `GO` |

### Lists, parentheses and `INSERT`

The comma-list, `DECLARE` and `EXEC` passes only run when `lists.placeCommasBeforeItems` is `true`: with trailing commas, `alignAliases`, `alignComments` and the `INSERT` column options have no effect and the lists stay as `sql-formatter` produces them, except for the compact layout (`placeSubsequentItemsOnNewLines: never`), which packs clause items, `DECLARE` and `EXEC` parameters within `wrapLinesLongerThan`.

| Key | Values | Effect |
|---|---|---|
| `lists.placeCommasBeforeItems` | boolean | Leading commas (`SELECT`, `GROUP BY`, `ORDER BY`, `DECLARE`, `EXEC`, procedure parameters, `STUFF`) |
| `lists.placeSubsequentItemsOnNewLines` | `never`, `always`, `ifLongerThanMaxLineLength`, … | One item per line, or packed items; `never` enables the compact passes of `scriptingFormatter.ts` |
| `lists.alignAliases` | boolean | Aligns `AS alias` in `SELECT` lists |
| `lists.alignComments` | boolean | Aligns trailing `--` comments in lists |
| `parentheses.addSpacesInsideParentheses` | boolean | `( a, b )` instead of `(a, b)` in the supported constructs |
| `insertStatements.columns.parenthesisStyle` | any value | When set, enables the `INSERT` column-list layout |
| `insertStatements.columns.placeSubsequentColumnsOnNewLines` | `never`, `always`, `whenLong`, `ifLongerThanMaxLineLength` | Breaking of `INSERT` column lists |

### DDL, control flow and variables

| Key | Values | Effect |
|---|---|---|
| `ddl.parenthesisStyle` | any value | When absent and `ddl.collapseShortStatements` is `true`, `CREATE TABLE` uses the compact scripting layout |
| `ddl.collapseShortStatements` | boolean | See above; also puts a short `ALTER TABLE … ADD CONSTRAINT` on one line (fixed threshold: under 97 characters) |
| `ddl.indentClauses` | boolean | Indents the `AS` of views and the body of procedures and functions |
| `ddl.indentParenthesesContents` | boolean | Extra indent for procedure parameters and table definitions |
| `ddl.placeFirstProcedureParameterOnNewLine` | `always`, `never`, `ifMultiple` | First procedure parameter on its own line |
| `ddl.placeConstraintColumnsOnNewLines` | `ifLongerOrMultipleColumns` | Expands multi-column `FOREIGN KEY` constraints vertically |
| `ddl.verticallyAlignDataTypes` | boolean | Aligns column data types in `CREATE` / `ALTER TABLE` |
| `controlFlow.indentBeginAndEndKeywords` | boolean | Indents `BEGIN` / `END` one level under `IF`, `WHILE`, `ELSE`; also enables view and procedure body indentation |
| `controlFlow.indentContentsOfStatements` | boolean (default `true`) | Indents the content of `BEGIN … END` |
| `controlFlow.collapseShortStatements` / `collapseStatementsShorterThan` | boolean / number | `IF` / `WHILE` with a one-statement body on one line; in the compact layout also a two-line `IF … AND/OR` condition |
| `dml.collapseShortStatements` / `collapseStatementsShorterThan` | boolean / number | Compact layout only: short `INSERT … VALUES` and `UPDATE … SET … WHERE` on one line |
| `dml.collapseShortSubqueries` / `collapseSubqueriesShorterThan` | boolean / number | Compact layout only: short `IF [NOT] EXISTS (…)` on one line |
| `variables.alignDataTypesAndValues` | boolean (default `true`) | Aligns data types and values in `DECLARE` lists |

### Joins, operators and `CASE`

| Key | Values | Effect |
|---|---|---|
| `joinStatements.join.keywordAlignment` | `toTable`, … (default `toFrom`) | `toTable` enables the tabular layout (see the engine mapping) and `JOIN` re-indentation |
| `joinStatements.on.placeOnNewLine` | boolean | `ON` on its own line; implied when `on.keywordAlignment` is set |
| `joinStatements.on.keywordAlignment` | `indented`, `toJoin`, `toTable` | Column of the `ON` keyword |
| `joinStatements.on.conditionAlignment` | `toInner`, … | `toInner` aligns `AND` / `OR` conditions of the `ON` clause |
| `operators.andOr.alignment` | `toFirstListItem`, `beforeOperator`, `afterOperator` | Line break before or after `AND` / `OR` (engine only) |
| `caseExpressions` | section present | Enables the `CASE` pass; without the section `CASE` is left as the engine formats it |
| `caseExpressions.placeFirstWhenOnNewLine` | `always`, `never`, `ifInputExpression` (default `always`) | First `WHEN` on a new line |
| `caseExpressions.whenAlignment` | `toCase`, `indented`, `toFirstItem` (default `toCase`) | Column of `WHEN` |
| `caseExpressions.alignElseToWhen` | boolean (default `true`) | `ELSE` aligned with `WHEN` |
| `caseExpressions.placeElseOnNewLine` | boolean (default `true`) | `ELSE` on its own line |
| `caseExpressions.placeEndOnNewLine` | boolean (default `true`) | `END` on its own line |
| `caseExpressions.endAlignment` | `toCase`, `indented`, `toFirstItem` (default `toCase`) | Column of `END` |

### Accepted but not applied yet

These keys are declared in `SqlPromptStyleJson` but no pass reads them. Setting them has no effect:

- `casing.useObjectDefinitionCase`
- `lists.addSpaceBeforeComma`, `addSpaceAfterComma`, `placeFirstItemOnNewLines`, `alignSubsequentItemsWithFirstItem`, `alignClauseItems`, `alignItemsAcrossClauses`, `alignItemsToTabStops`, `commaAlignment`
- `parentheses.collapseParenthesesShorterThan`
- `whitespace.newLines.preserveExistingEmptyLinesBetweenStatements`, `preserveExistingEmptyLinesAfterBatchSeparator`
- `operators.between.*`, `operators.in.*`
- the `dml` section except the collapse options above, the whole `cte` and `functionCalls` sections
- `ddl.overrideParenthesesForCreateAlter`, `indentContents`, `placeClosingParenthesisOnNewLine`, `firstDefinitionBreakType`, `placeFirstDefinitionOnNewLine`, `collapseStatementsShorterThan`, `breakOnConstraints`, `constraintColumnsBreakType`, `verticallyAlignColumnDefinitions`, `openingParenthesisAlignment`, `openingParenthesisBreakType`, `closingParenthesisAlignment`, `contentsBreakType`
- `joinStatements.join.indentJoinTable`
- `insertStatements.columns.indentContents`, `insertStatements.values.*`
- `caseExpressions.placeExpressionOnNewLine`, `expressionAlignment`, `placeThenOnNewLine`, `collapseCaseExpressionsShorterThan`, `collapseShortCaseExpressions`

---

## Tests

```bash
cd client && npm test
```

- Unit tests for each pass are in `client/src/formatter/__tests__/`.
- `examples.test.ts` runs `formatSqlText`, the shipped pipeline, on every fixture in `client/src/formatter/__tests__/examples/<profile>/`. Each profile folder holds one `config.json` (the style) and the `.sql` fixtures. Three checks per fixture:
  - **fixed point**: formatting the expected output returns it unchanged;
  - **round trip**: formatting the fixture with every statement joined on one line rebuilds the fixture;
  - **convergence**: a second pass on that result changes nothing.
- Fixtures that do not pass yet are kept in [example-not-passing/](example-not-passing/), with their analysis.

---

## Known limitations

- **Text-level passes.** The post-processing passes are regular expressions on the formatted text. They do not distinguish code from string literals and comments, so a keyword inside a string or a comment can be reformatted, and list passes can misplace items next to a `--` comment.
- **`STUFF()`, nested parentheses and nested `AND` / `OR`** are not formatted correctly in every profile; see [example-not-passing/example7-formatting-issues.md](example-not-passing/example7-formatting-issues.md).
- **Whole document only**: there is no range formatting and no format-on-type.

---

## Architecture

```text
client/src/formatter/
├── styleLoader.ts               Reads the style files; declares SqlPromptStyleJson
├── formatOptionsMapper.ts       Maps a style to sql-formatter options
├── formatPipeline.ts            formatSqlText: the pipeline, no vscode dependency
├── sqlFormattingProvider.ts     DocumentFormattingEditProvider: calls formatSqlText, guard
├── formatGuard.ts               Rejects results that alter the query
├── keywordPaddingFormatter.ts   SET joining, keyword column width
├── listFormatter.ts             Comma lists, INSERT column lists
├── declareFormatter.ts          DECLARE lists
├── ddlFormatter.ts              Procedures, functions, views, tables
├── stuffFormatter.ts            STUFF(… FOR XML PATH …)
├── caseFormatter.ts             CASE expressions
├── joinFormatter.ts             JOIN / ON / APPLY
├── controlFlowFormatter.ts      BEGIN / END, IF / WHILE / ELSE
├── semicolonFormatter.ts        Semicolon placement
├── execFormatter.ts             EXEC parameter lists
└── scriptingFormatter.ts        Compact layout, collapse of short statements
```

The status bar item, the style picker and the configuration listeners are in `client/src/extension.ts`.

## Future work

- Split the clean-up regexes of `formatPipeline.ts` into named, tested passes and make their order explicit (issue #16).
- Derive the fixed thresholds (for example the 97 characters of `ALTER TABLE … ADD CONSTRAINT`) from the style options.
- Protect string literals and comments from the text-level passes.
- Implement the options listed under [Accepted but not applied yet](#accepted-but-not-applied-yet).
- Watch `stylesFolder` so that new style files appear without reopening the picker.
- Support the legacy `.sqlpromptstylev2` XML format.
