# Mapping Doubts — 1-MadLab-Vertical.xmlpromptstylev2 → JSON

I marked ambiguous mappings with `(?)` in the JSONC file.
For each item below, tell me the correct JSON key name and/or the correct enum values so I can finalize the file.

---

## 1. `operators.andOr.alignment` — possible value collision

| XML property | XML value | JSON key used | Value assigned |
|---|---|---|---|
| `BooleanOperatorAlignment` | `AsPartOfList` | `operators.andOr.alignment` | `"asPartOfList"` |

**Problem:** `AllOptions.json` already uses `"toFirstListItem"` for this key.  
Are `AsPartOfList` and `ToFirstListItem` two distinct modes, or synonyms?  
What are all valid enum values for `operators.andOr.alignment`?

---

## 2. `joinStatements.join.keywordAlignment` — value not in AllOptions.json

| XML property | XML value | JSON key used | Value assigned |
|---|---|---|---|
| `JoinClauseAlignment` | `AsPartOfList` | `joinStatements.join.keywordAlignment` | `"asPartOfList"` |

**Problem:** `AllOptions.json` uses `"toTable"` for this key.  
Is `"asPartOfList"` a valid value, or should it map to something else?

---

## 3. `joinStatements.on.keywordAlignment` — value not in AllOptions.json

| XML property | XML value | JSON key used | Value assigned |
|---|---|---|---|
| `JoinOnAlignment` | `TabbedFromJoin` | `joinStatements.on.keywordAlignment` | `"tabbedFromJoin"` |

**Problem:** `AllOptions.json` uses `"indented"` for this key.  
Is `"tabbedFromJoin"` a valid enum value, or does it map differently?

---

## 4. New categories with no AllOptions.json counterpart

The following XML properties have no obvious home in the existing JSON schema.
I placed them in new top-level categories (`clauses`, `select`, `misc`).
Please confirm whether these categories and key names are correct, or redirect them.

### `clauses` (new)
| XML property | XML value | JSON key | Note |
|---|---|---|---|
| `ClauseAlignment` | `ToStatement` | `clauses.clauseAlignment` | Valid values? |
| `ClauseIndentation` | `0` | `clauses.clauseIndentation` | int — OK? |
| `FromClauseFirstItemBreakType` | `Never` | `clauses.fromFirstItemBreakType` | `"never"` |
| `WhereClauseFirstItemBreakType` | `Never` | `clauses.whereFirstItemBreakType` | `"never"` |
| `GroupByOrderByFirstItemBreakType` | `Never` | `clauses.groupByOrderByFirstItemBreakType` | `"never"` |

### `select` (new)
| XML property | XML value | JSON key | Note |
|---|---|---|---|
| `NewLineBeforeTopRowFilter` | `false` | `select.newLineBeforeTopRowFilter` | — |
| `NewLineAfterTopRowFilter` | `false` | `select.newLineAfterTopRowFilter` | — |
| `NewLineForCorrelatedTableSource` | `false` | `select.newLineForCorrelatedTableSource` | — |

### `misc` (new)
| XML property | XML value | JSON key | Note |
|---|---|---|---|
| `SemicolonWhitespace` | `None` | `misc.semicolonWhitespace` | Possible values: `"none"`, `"beforeSemicolon"`, `"afterSemicolon"`, `"newLine"` — correct? |
| `SpaceBeforeUnits` | `false` | `misc.spaceBeforeUnits` | — |
| `SpaceBetweenDataTypeAndParameters` | `false` | `misc.spaceBetweenDataTypeAndParameters` | — |
| `UseGlobalListOptionsForDmlStatements` | `false` | `misc.useGlobalListOptionsForDml` | Does this belong somewhere else? |
| `PreferBreakBeforeAsKeyword` | `true` | `misc.preferBreakBeforeAsKeyword` | alias `AS`? Belongs in `lists`? |
| `PreferBreakBeforeConditionOperator` | `true` | `misc.preferBreakBeforeConditionOperator` | `operators`? |
| `PreferBreakBeforeEquals` | `false` | `misc.preferBreakBeforeEquals` | `variables` or `operators`? |

---

## 5. `controlFlow.indentBlockContents` — unclear scope

| XML property | XML value | JSON key | Note |
|---|---|---|---|
| `IndentBlockContents` | `true` | `controlFlow.indentBlockContents` | Refers to BEGIN/END block body? Correct category? |

---

## 6. `lists.indentItems` and `lists.commaAlignment`

| XML property | XML value | JSON key | Note |
|---|---|---|---|
| `IndentListItems` | `true` | `lists.indentItems` | Correct key name? |
| `CommaAlignment` | `ToList` | `lists.commaAlignment` | Valid values? Relationship with `placeCommasBeforeItems`? |

---

## 7. XML properties not mapped (marked `IsMigratedStyle`)

| XML property | XML value | Decision needed |
|---|---|---|
| `IsMigratedStyle` | `false` | Metadata only — skip or include? |
| `OptionsVersion` | `12` | Already put in `metadata.version` |
