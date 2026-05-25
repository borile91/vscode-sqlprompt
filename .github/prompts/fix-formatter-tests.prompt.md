---
description: "Fix the SQL formatter so that all client tests pass. Use when: formatter tests are failing, examples.test.ts mismatches, formatter output does not match expected SQL examples."
agent: agent
tools: [read_file, grep_search, file_search, list_dir, replace_string_in_file, multi_replace_string_in_file, run_in_terminal, get_errors, get_terminal_output]
argument-hint: Which test suite or example folder is failing? (leave blank to fix all)
---

# Fix SQL Formatter Tests

## Ground rules (NEVER violate)

1. **Do NOT modify any file under `client/src/formatter/__tests__/examples/`** — the `.sql` files and `config.json` files are the canonical source of truth. They define the expected output. The formatter must conform to them, not the other way around.
2. Do NOT modify `examples.test.ts` unless a bug in the test harness itself is confirmed. Focus on formatter modules.
3. Treat each example folder as an independent contract: the formatter, given the folder's `config.json`, must reproduce every `.sql` file exactly (byte-for-byte after normalising `\r\n` → `\n` and trimming a final newline).

## Understand the pipeline

Read [examples.test.ts](../../client/src/formatter/__tests__/examples.test.ts) to understand the exact formatting pipeline (`formatSql`). The pipeline order is:

1. `sql-formatter` core (`format`)
2. `applySetLineJoining`, `applyKeywordRePadding`
3. Spaces-inside-parens patches
4. IF/WHILE expansion
5. `applyDeclareFormatting`
6. `applyDdlProcFormatting`, `applyDdlParameterlessProcAsFormatting`, `applyDdlViewFormatting`, `applyDdlTableFormatting`
7. `applyLeadingCommaFormat`
8. `collapseCaseToSingleLine`
9. Inline-clause packing (when `placeSubsequentItemsOnNewLines === 'never'`)
10. `applyJoinOnFormatting`, `applyCaseFormatting`
11. `applyDdlFormatting`
12. `applyControlFlowIndentation`, `applySemicolonFormatting`, `applyProcBodyIndentation`
13. `collapseShortStatements` patch
14. `applyOuterApplyInlineFormat`
15. EXEC-param greedy packing
16. Scripting post-processing

## Workflow

### 1. Run tests and collect failures

```bash
cd client && npm test 2>&1 | head -200
```

Identify which example folders and which `.sql` files are failing.

### 2. For each failing example

1. Read `examples/N_FolderName/config.json` to know the active options.
2. Read the expected `.sql` file.
3. Run a minimal reproduction to see what the formatter **actually** produces vs what is **expected**:
   ```bash
   cd client && node --test out/formatter/__tests__/examples.test.js 2>&1 | grep -A 30 "AssertionError"
   ```
4. Identify which pipeline step introduces the divergence (diff the actual vs expected line by line).
5. Fix the responsible formatter module in `client/src/formatter/`.

### 3. Build and re-test

After each fix:
```bash
cd client && npm run compile && npm test 2>&1 | grep -E "pass|fail|AssertionError" | head -40
```

Iterate until `npm test` exits 0.

### 4. Validate no regressions

```bash
cd client && npm test 2>&1 | tail -20
```

All tests (not just examples) must pass.

## Key formatter files

| Module | Path |
|--------|------|
| Format options mapper | [formatOptionsMapper.ts](../../client/src/formatter/formatOptionsMapper.ts) |
| Keyword padding | [keywordPaddingFormatter.ts](../../client/src/formatter/keywordPaddingFormatter.ts) |
| Declare formatter | [declareFormatter.ts](../../client/src/formatter/declareFormatter.ts) |
| DDL formatter | [ddlFormatter.ts](../../client/src/formatter/ddlFormatter.ts) |
| Case formatter | [caseFormatter.ts](../../client/src/formatter/caseFormatter.ts) |
| List formatter | [listFormatter.ts](../../client/src/formatter/listFormatter.ts) |
| Join formatter | [joinFormatter.ts](../../client/src/formatter/joinFormatter.ts) |
| Control flow formatter | [controlFlowFormatter.ts](../../client/src/formatter/controlFlowFormatter.ts) |
| Semicolon formatter | [semicolonFormatter.ts](../../client/src/formatter/semicolonFormatter.ts) |
| Exec formatter | [execFormatter.ts](../../client/src/formatter/execFormatter.ts) |
| Style loader | [styleLoader.ts](../../client/src/formatter/styleLoader.ts) |

## Debugging tips

- Use `node --test --test-name-pattern "1_Vertical"` to run a single example suite.
- Print actual vs expected with `assert.strictEqual(actual, expected)` output — node:assert shows a diff.
- When a regex in a formatter does not match as expected, test it in isolation with a small Node snippet.
- Check `config.json` carefully: a config option that is `undefined` vs `false` may change behaviour.
- After editing TypeScript source, always recompile (`npm run compile`) before re-running tests.
