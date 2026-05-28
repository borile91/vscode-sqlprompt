# SQL Formatter — Feature Implementation Guide

Each section documents one configurable behaviour: the JSON key path, accepted values, a description of the transformation, and one or more **input → expected output** test pairs.

**Active style profile used as primary target:** [`DefaultFormattingStyle.jsonc`](DefaultFormattingStyle.jsonc)  
**Full options reference:** [`Defaults.json`](Defaults.json)

---

## Table of Contents

1. [Casing](#1-casing)
2. [Whitespace](#2-whitespace)
3. [Lists](#3-lists)
4. [Parentheses](#4-parentheses)
5. [DML](#5-dml)
6. [DDL](#6-ddl)
7. [Control Flow](#7-control-flow)
8. [Join Statements](#8-join-statements)
9. [Operators](#9-operators)
10. [Case Expressions](#10-case-expressions)
11. [CTE](#11-cte)
12. [Variables](#12-variables)
13. [Function Calls](#13-function-calls)
14. [Insert Statements](#14-insert-statements)

---

## 1. Casing

### 1.1 `casing.reservedKeywords`

Values: `"uppercase"` | `"lowercase"` | `"preserve"`  
Active: `"uppercase"`

Transforms SQL reserved keywords (SELECT, FROM, WHERE, JOIN, ON, AS, AND, OR, GROUP BY, ORDER BY, …).

**Input:**
```sql
select a, b from t where x = 1 and y > 2
```

**→ `"uppercase"` (active):**
```sql
SELECT a, b FROM t WHERE x = 1 AND y > 2
```

**→ `"lowercase"`:**
```sql
select a, b from t where x = 1 and y > 2
```

---

### 1.2 `casing.builtInFunctions`

Values: `"uppercase"` | `"lowercase"` | `"preserve"`  
Active: `"uppercase"`

Transforms built-in function names (ISNULL, GETDATE, COALESCE, SUM, COUNT, LEFT, …).

**Input:**
```sql
select isnull(a, 0), getdate(), count(*)
from   t
```

**→ `"uppercase"` (active):**
```sql
SELECT ISNULL(a, 0), GETDATE(), COUNT(*)
FROM   t
```

---

### 1.3 `casing.builtInDataTypes`

Values: `"uppercase"` | `"lowercase"` | `"preserve"`  
Active: `"uppercase"`

Transforms built-in data type names (INT, VARCHAR, NVARCHAR, DATETIME, BIT, NUMERIC, …).

**Input:**
```sql
declare @x int = 1
declare @s varchar(50) = 'hello'
```

**→ `"uppercase"` (active):**
```sql
DECLARE @x INT = 1
DECLARE @s VARCHAR(50) = 'hello'
```

---

### 1.4 `casing.globalVariables`

Values: `"uppercase"` | `"lowercase"` | `"preserve"`  
Active: `"preserve"`

Transforms system global variables (@@ROWCOUNT, @@TRANCOUNT, @@ERROR, @@IDENTITY, …).

With `"preserve"` the case of the variable is left exactly as written in the source.

---

### 1.5 `casing.useObjectDefinitionCase`

Values: `true` | `false`  
Active: `true`

When `true`, user object names (tables, columns, procedures, schemas) are cased to match their definition in the connected database schema. Requires schema introspection at format time. This is not a pure text transform.

---

## 2. Whitespace

### 2.1 `whitespace.numberOfSpacesInTabs`

Values: `number`  
Active: `4`

Number of spaces per indentation level.

---

### 2.2 `whitespace.spacesOrTabs`

Values: `"onlySpaces"` | `"onlyTabs"` | `"spacesAndTabs"`  
Active: `"onlySpaces"`

Whether to indent with spaces, tabs, or a combination.

---

### 2.3 `whitespace.wrapLinesLongerThan` / `wrapLongLines`

`wrapLinesLongerThan`: `number` (active: `200`)  
`wrapLongLines`: `boolean` (active: `true`)

When `wrapLongLines` is `false`, no automatic line-wrapping is applied regardless of line length. When `true`, lines that exceed `wrapLinesLongerThan` characters are broken according to the rules of the surrounding context (lists, parentheses, operators, …).

---

### 2.4 `whitespace.whiteSpaceBeforeSemiColon`

Values: `"none"` | `"spaceBefore"` | `"newLineBefore"`  
Active: `"none"`

Controls whitespace between the last token of a statement and its `;`.

**Input:**
```sql
SELECT 1
PRINT 'done'
```

**→ `"none"` (active):**
```sql
SELECT 1;
PRINT 'done';
```

**→ `"spaceBefore"`:**
```sql
SELECT 1 ;
PRINT 'done' ;
```

**→ `"newLineBefore"`:**
```sql
SELECT 1
;
PRINT 'done'
;
```

---

### 2.5 `whitespace.newLines.emptyLinesBetweenStatements`

Values: `number`  
Active: `1`

Number of blank lines to insert between SQL statements (i.e. 1 = one empty line = two `\n` characters).

**Input:**
```sql
SELECT 1
SELECT 2
SELECT 3
```

**→ `1` (active):**
```sql
SELECT 1

SELECT 2

SELECT 3
```

---

### 2.6 `whitespace.newLines.emptyLinesAfterBatchSeparator`

Values: `number`  
Active: `1`

Number of blank lines after a `GO` batch separator.

**Input:**
```sql
USE AdventureWorks
GO
SELECT 1
```

**→ `1` (active):**
```sql
USE AdventureWorks
GO

SELECT 1
```

---

### 2.7 `whitespace.newLines.preserveExistingEmptyLinesBetweenStatements`

Values: `true` | `false`  
Active: `false`

When `false`, blank lines between statements are normalised to exactly `emptyLinesBetweenStatements` lines. When `true`, existing extra blank lines are preserved (only the minimum is enforced).

---

### 2.8 `whitespace.newLines.preserveExistingEmptyLinesWithinStatements`

Values: `true` | `false`  
Active: `false`

When `false`, blank lines inside a single statement are removed.

---

## 3. Lists

> Applies to column lists in SELECT, ORDER BY, GROUP BY, and other comma-separated item lists.

### 3.1 `lists.placeCommasBeforeItems`

Values: `true` | `false`  
Active: `true`

When `true`, each subsequent list item is preceded by a comma at the start of its line rather than having a comma appended to the previous line.

**Input:**
```sql
SELECT TerritoryID, Name, SalesYTD FROM Sales.SalesTerritory
```

**→ `true` (active) — combined with `placeSubsequentItemsOnNewLines: "always"`:**
```sql
SELECT TerritoryID
     , Name
     , SalesYTD
FROM   Sales.SalesTerritory
```

**→ `false`:**
```sql
SELECT TerritoryID,
       Name,
       SalesYTD
FROM   Sales.SalesTerritory
```

---

### 3.2 `lists.addSpaceBeforeComma`

Values: `true` | `false`  
Active: `true`

Relevant only when `placeCommasBeforeItems: true`. Adds a trailing space on each line before the next line's leading comma — this ensures the comma column is visually separated from the previous item's content.

**→ `true` (active):**
```sql
SELECT TerritoryID -- nvarchar
     , Name        -- nvarchar
```

**→ `false`:**
```sql
SELECT TerritoryID -- nvarchar
      ,Name        -- nvarchar
```

---

### 3.3 `lists.addSpaceAfterComma`

Values: `true` | `false`  
Active: `true`

Adds a space after each comma in inline (non-broken) lists.

**→ `true` (active):** `IN (1, 2, 3)`  
**→ `false`:** `IN (1,2,3)`

---

### 3.4 `lists.commaAlignment`

Values: `"toStatement"` | `"beforeItem"` | `"toList"`  
Active: `"toList"`

Controls the horizontal column of the leading comma when `placeCommasBeforeItems: true`.

**Input:**
```sql
SELECT TerritoryID, Name, SalesYTD FROM Sales.SalesTerritory
```

**→ `"toStatement"`:** comma is at column 0 (same as the statement keyword):
```sql
SELECT TerritoryID, Name
,      SalesYTD
FROM   Sales.SalesTerritory
```

**→ `"beforeItem"`:** comma is directly before the item (indented to item position):
```sql
SELECT TerritoryID, Name
     , SalesYTD
FROM   Sales.SalesTerritory
```

**→ `"toList"` (active):** comma is at the list column (aligned to the first item, with a leading space):
```sql
SELECT TerritoryID, Name
       , SalesYTD
FROM   Sales.SalesTerritory
```

See [configurations/lists.md](configurations/lists.md) for visual examples.

---

### 3.5 `lists.placeFirstItemOnNewLines`

Values: `"never"` | `"always"` | `"wrap"` | `"whenLong"`  
Active: `"never"`

Controls whether the **first** item in a list is placed on a new line after the clause keyword.

- `"never"` — first item stays on the same line as SELECT/FROM/WHERE/…
- `"always"` — first item always starts on a new line
- `"wrap"` — breaks when the resulting line would exceed `wrapLinesLongerThan`
- `"whenLong"` — breaks only if the entire list is longer than `wrapLinesLongerThan`

---

### 3.6 `lists.placeSubsequentItemsOnNewLines`

Values: `"never"` | `"always"` | `"wrap"` | `"whenLong"`  
Active: `"always"`

Controls whether items after the first are placed on new lines.

**→ `"always"` (active) — with `placeFirstItemOnNewLines: "never"`:**
```sql
SELECT TerritoryID
     , Name
     , SalesYTD
FROM   Sales.SalesTerritory
```

**→ `"never"`:**
```sql
SELECT TerritoryID, Name, SalesYTD
FROM   Sales.SalesTerritory
```

---

### 3.7 `lists.alignSubsequentItemsWithFirstItem`

Values: `true` | `false`  
Active: `true`

When `true`, items after the first are vertically aligned to the column of the first item (i.e. the column after the clause keyword + spaces).

---

### 3.8 `lists.alignAliases`

Values: `true` | `false`  
Active: `false`

When `true`, `AS alias` parts of list items are vertically aligned.

**→ `true`:**
```sql
SELECT TerritoryID AS ID
     , Name        AS TerritoryName
     , SalesYTD    AS YTD
FROM   Sales.SalesTerritory
```

**→ `false` (active):**
```sql
SELECT TerritoryID AS ID
     , Name AS TerritoryName
     , SalesYTD AS YTD
FROM   Sales.SalesTerritory
```

---

### 3.9 `lists.alignClauseItems`

Values: `true` | `false`  
Active: `true`

When `true`, list items across different clauses (SELECT columns, ORDER BY columns, …) are padded so they start in the same column. This is what produces the characteristic right-padded clause keywords (`SELECT`, `FROM  `, `WHERE `).

---

### 3.10 `lists.alignComments`

Values: `true` | `false`  
Active: `true`

When `true`, trailing `-- comments` on list items are aligned to the same column.

**→ `true` (active):**
```sql
SELECT TerritoryID -- int
     , Name        -- nvarchar(50)
     , SalesYTD    -- money
FROM   Sales.SalesTerritory
```

**→ `false`:**
```sql
SELECT TerritoryID -- int
     , Name -- nvarchar(50)
     , SalesYTD -- money
FROM   Sales.SalesTerritory
```

---

### 3.11 `lists.alignItemsAcrossClauses`

Values: `true` | `false`  
Active: `true`

When `true`, items from different clauses are aligned to a common column even when the clause keywords have different lengths (e.g. `SELECT` vs `FROM`).

---

### 3.12 `lists.alignItemsToTabStops`

Values: `true` | `false`  
Active: `false`

When `true`, items are snapped to the nearest tab stop rather than aligned to the exact first-item column.

---

## 4. Parentheses

### 4.1 `parentheses.addSpacesInsideParentheses`

Values: `true` | `false`  
Active: `true`

Adds a space after `(` and before `)` for inline expressions.

**→ `true` (active):** `COUNT( * )`, `IN ( 1, 2, 3 )`  
**→ `false`:** `COUNT(*)`, `IN (1, 2, 3)`

---

### 4.2 `parentheses.addSpacesAroundParentheses`

Values: `true` | `false`  
Active: `true`

Adds a space before `(` and after `)` in expressions.

**→ `true` (active):** `ISNULL ( x, 0 )`  
**→ `false`:** `ISNULL(x, 0)`

---

### 4.3 `parentheses.spaceInsideEmptyParentheses`

Values: `true` | `false`  
Active: `false`

Controls whether a space is added inside `()`.

**→ `false` (active):** `GETDATE()`  
**→ `true`:** `GETDATE( )`

---

### 4.4 `parentheses.collapseParenthesesShorterThan` / `collapseShortParentheses`

`collapseParenthesesShorterThan`: `number` (active: `78`)  
`collapseShortParentheses`: `boolean` (active: `false` — feature **disabled**)

When `collapseShortParentheses: true`, a parenthesised expression that fits within N characters is collapsed to a single line regardless of other layout rules.

---

### 4.5 `parentheses.layout`

Values: `"compactSimple"` | `"expandedIndented"`  
Active: `"compactSimple"`

General parenthesis layout for expressions (overridden by `ddl.parenthesisStyle` for DDL).

- `"compactSimple"` — parenthesised content stays inline or on adjacent lines without extra indentation
- `"expandedIndented"` — opening `(` on its own line, contents indented, closing `)` on its own line

---

### 4.6 `parentheses.openingAlignment` / `openingBreakType`

`openingAlignment`: `"toStatement"` | `"toOpeningBracket"` | `"tabbed"` (active: `"toStatement"`)  
`openingBreakType`: `"never"` | `"always"` | `"whenLong"` (active: `"never"`)

When the opening `(` moves to a new line, `openingAlignment` controls its horizontal position. `openingBreakType` controls when it moves.

With `"never"`, the `(` stays on the same line as the preceding token.

---

### 4.7 `parentheses.contentsAlignment` / `contentsBreakType`

`contentsAlignment`: `"tabbedFromOpeningBracket"` | `"toStatement"` | `"toOpeningBracket"` (active: `"tabbedFromOpeningBracket"`)  
`contentsBreakType`: `"never"` | `"always"` | `"whenLong"` (active: `"never"`)

Alignment and line-break policy for the content inside parentheses.

---

### 4.8 `parentheses.closingAlignment`

Values: `"toOpeningBracket"` | `"toStatement"` | `"tabbed"`  
Active: `"toOpeningBracket"`

When `)` moves to its own line, this controls its horizontal position.

---

### 4.9 `parentheses.indentContents`

Values: `true` | `false`  
Active: `false`

When `true`, the content of a multi-line parenthesised expression is indented relative to the opening `(`.

---

### 4.10 `parentheses.placeClosingOnNewLine`

Values: `true` | `false`  
Active: `false`

When `true`, the closing `)` is always placed on a new line.

---

## 5. DML

> Applies to SELECT, INSERT, UPDATE, DELETE statements.

### 5.1 `dml.collapseStatementsShorterThan` / `collapseShortStatements`

`collapseStatementsShorterThan`: `number` (active: `75`)  
`collapseShortStatements`: `boolean` (active: `false` — feature **disabled**)

When `collapseShortStatements: true`, a DML statement whose formatted single-line length is less than N characters is collapsed to one line.

**→ `collapseShortStatements: true`, `collapseStatementsShorterThan: 75`:**
```sql
DELETE FROM temp.jobDurations WHERE fullFileName = 'test';
```

---

### 5.2 `dml.collapseSubqueriesShorterThan` / `collapseShortSubqueries`

`collapseSubqueriesShorterThan`: `number` (active: `15`)  
`collapseShortSubqueries`: `boolean` (active: `false` — feature **disabled**)

Same as above but applies to inline subqueries.

---

### 5.3 `dml.placeDistinctAndTopClausesOnNewLine`

Values: `true` | `false`  
Active: `false`

When `true`, `TOP (n)` and `DISTINCT` are placed on a new line after SELECT.

**→ `true`:**
```sql
SELECT
       TOP ( 5 )
       Name
FROM   Sales.SalesTerritory
```

**→ `false` (active):** `TOP` stays on the SELECT line.

---

### 5.4 `dml.addNewLineAfterDistinctAndTopClauses`

Values: `true` | `false`  
Active: `false`

When `true`, a blank line is inserted after the `TOP`/`DISTINCT` clause before the column list.

---

### 5.5 `dml.clauses.clauseAlignment`

Values: `"toFirstListItem"` | `"toStatement"`  
Active: `"toStatement"`

Controls the horizontal position of clause keywords (SELECT, FROM, WHERE, ORDER BY, GROUP BY, HAVING) relative to the statement.

**→ `"toStatement"` (active):** clauses are left-aligned to the statement start, padded to a uniform width:
```sql
SELECT Name
     , SalesYTD
FROM   Sales.SalesTerritory
WHERE  SalesYTD > 0
```

**→ `"toFirstListItem"`:** clauses align to the column of the first list item:
```sql
SELECT Name
     , SalesYTD
FROM   Sales.SalesTerritory
WHERE  SalesYTD > 0
```

---

### 5.6 `dml.clauses.clauseIndentation`

Values: `number`  
Active: `0`

Extra spaces to add before each clause keyword (can shift all clauses right).

---

### 5.7 `dml.listItems.placeFromTableOnNewLine`

Values: `"never"` | `"always"` | `"ifMultiple"`  
Active: `"never"`

Controls whether the primary FROM table starts on a new line after `FROM`.

**→ `"never"` (active):**
```sql
FROM   Sales.SalesTerritory
```

**→ `"always"`:**
```sql
FROM
       Sales.SalesTerritory
```

**→ `"ifMultiple"`:** breaks only when there are multiple table sources (JOINs present).

---

### 5.8 `dml.listItems.placeWhereConditionOnNewLine`

Values: `"never"` | `"always"` | `"ifMultiple"`  
Active: `"never"`

Controls whether the first WHERE condition is placed on a new line after `WHERE`.

**→ `"never"` (active):**
```sql
WHERE  SalesYTD > 0
```

**→ `"always"`:**
```sql
WHERE
       SalesYTD > 0
```

---

### 5.9 `dml.listItems.placeGroupByAndOrderByOnNewLine`

Values: `"never"` | `"always"` | `"ifMultiple"`  
Active: `"never"`

Same behaviour as `placeWhereConditionOnNewLine` but for GROUP BY and ORDER BY.

---

## 6. DDL

> Applies to CREATE, ALTER, DROP statements.

### 6.1 `ddl.parenthesisStyle`

Values: `"expandedIndented"` | `"compactSimple"`  
Active: `"expandedIndented"`

Layout of the parentheses containing column/parameter definitions.

**→ `"expandedIndented"` (active):**
```sql
CREATE TABLE dbo.Orders
      (
      OrderID   INT           NOT NULL
    , OrderDate DATETIME      NOT NULL
    , Total     NUMERIC(12,2) NOT NULL
      )
```

See [configurations/ddl.md](configurations/ddl.md) for full examples.

---

### 6.2 `ddl.overrideParenthesesForCreateAlter`

Values: `true` | `false`  
Active: `true`

When `true`, `ddl.parenthesisStyle` overrides the general `parentheses` settings for CREATE/ALTER statements.

---

### 6.3 `ddl.indentClauses`

Values: `true` | `false`  
Active: `true`

When `true`, sub-clauses in DDL statements (ON, TO, FOR, …) are indented.

**→ `true` (active):**
```sql
GRANT EXECUTE
      ON  LogEvent
      TO  ts_webapplication;
```

**→ `false`:**
```sql
GRANT EXECUTE
ON LogEvent
TO ts_webapplication;
```

---

### 6.4 `ddl.indentContents`

Values: `true` | `false`  
Active: `false`

When `true`, the content inside CREATE/ALTER parentheses is indented relative to the opening `(`.

---

### 6.5 `ddl.placeClosingParenthesisOnNewLine`

Values: `true` | `false`  
Active: `true`

When `true`, the closing `)` of a CREATE/ALTER definition is on its own line.

---

### 6.6 `ddl.openingParenthesisAlignment` / `openingParenthesisBreakType`

`openingParenthesisAlignment`: `"tabbed"` | `"toStatement"` | `"toOpeningBracket"` (active: `"tabbed"`)  
`openingParenthesisBreakType`: `"always"` | `"never"` | `"whenLong"` (active: `"always"`)

Controls where the opening `(` is placed in CREATE/ALTER.

With `"tabbed"` + `"always"`, the `(` is on a new line indented one tab from the statement:
```sql
CREATE TABLE dbo.T
      (
      …
      )
```

---

### 6.7 `ddl.closingParenthesisAlignment`

Values: `"toOpeningBracket"` | `"toStatement"` | `"tabbed"`  
Active: `"toOpeningBracket"`

Horizontal position of the closing `)`.

---

### 6.8 `ddl.contentsBreakType`

Values: `"never"` | `"always"` | `"whenLong"`  
Active: `"never"`

Line-break policy for the content inside DDL parentheses (each definition on its own line when `"always"`).

---

### 6.9 `ddl.placeFirstProcedureParameterOnNewLine`

Values: `"always"` | `"never"` | `"whenLong"`  
Active: `"always"`

Controls whether the first parameter of a stored procedure/function definition starts on a new line.

---

### 6.10 `ddl.firstDefinitionBreakType`

Values: `"always"` | `"never"` | `"whenLong"`  
Active: `"always"`

Controls whether the first column/parameter definition (inside CREATE TABLE / ALTER …) starts on a new line.

---

### 6.11 `ddl.placeFirstDefinitionOnNewLine`

Values: `true` | `false`  
Active: `true`

Shorthand flag — when `true`, equivalent to `firstDefinitionBreakType: "always"`.

---

### 6.12 `ddl.collapseStatementsShorterThan` / `collapseShortStatements`

`collapseStatementsShorterThan`: `number` (active: `75`)  
`collapseShortStatements`: `boolean` (active: `false` — feature **disabled**)

Short DDL statements are collapsed to one line when enabled.

---

### 6.13 `ddl.verticallyAlignDataTypes`

Values: `true` | `false`  
Active: `true`

Aligns data types in column definition lists to the same column.

**→ `true` (active):**
```sql
CREATE TABLE dbo.T
      (
      OrderID   INT           NOT NULL
    , OrderDate DATETIME      NOT NULL
    , Note      VARCHAR(100)  NULL
      )
```

**→ `false`:**
```sql
CREATE TABLE dbo.T
      (
      OrderID INT NOT NULL
    , OrderDate DATETIME NOT NULL
    , Note VARCHAR(100) NULL
      )
```

---

### 6.14 `ddl.verticallyAlignColumnDefinitions`

Values: `true` | `false`  
Active: `false`

When `true`, additional definition parts (NOT NULL, DEFAULT, CONSTRAINT, …) are aligned to the same column across all rows.

---

### 6.15 `ddl.breakOnConstraints`

Values: `true` | `false`  
Active: `false`

When `true`, constraint definitions (PRIMARY KEY, FOREIGN KEY, CHECK, …) are placed on their own lines.

---

### 6.16 `ddl.constraintColumnsBreakType`

Values: `"never"` | `"always"` | `"whenLong"`  
Active: `"whenLong"`

Controls when the column list inside a constraint definition is expanded across multiple lines.

---

## 7. Control Flow

> Applies to IF, WHILE, BEGIN/END, BREAK, CONTINUE, RETURN.

### 7.1 `controlFlow.indentBeginAndEndKeywords`

Values: `true` | `false`  
Active: `true`

When `true`, BEGIN and END are indented relative to the enclosing control statement.

**→ `true` (active):**
```sql
WHILE @@ROWCOUNT > 0
      BEGIN
      DELETE TOP (1000) FROM dbo.Log;
      END;
```

**→ `false`:**
```sql
WHILE @@ROWCOUNT > 0
BEGIN
DELETE TOP (1000) FROM dbo.Log;
END;
```

---

### 7.2 `controlFlow.indentContentsOfStatements`

Values: `true` | `false`  
Active: `true`

When `true`, the body of a control-flow block is indented relative to BEGIN/END.

**→ `true` (active):**
```sql
WHILE @@ROWCOUNT > 0
      BEGIN
            DELETE TOP (1000)
            FROM   dbo.Log;
      END;
```

**→ `false`:**
```sql
WHILE @@ROWCOUNT > 0
      BEGIN
      DELETE TOP (1000)
      FROM   dbo.Log;
      END;
```

---

### 7.3 `controlFlow.placeBeginOnNewLine`

Values: `true` | `false`  
Active: `true`

When `true`, BEGIN is placed on a new line after the control statement header.

**→ `true` (active):**
```sql
IF @x > 0
      BEGIN
      PRINT 'positive';
      END;
```

**→ `false`:**
```sql
IF @x > 0 BEGIN
      PRINT 'positive';
      END;
```

---

### 7.4 `controlFlow.collapseStatementsShorterThan` / `collapseShortStatements`

`collapseStatementsShorterThan`: `number` (active: `78`)  
`collapseShortStatements`: `boolean` (active: `false` — feature **disabled**)

Short control-flow blocks collapsed to one line when enabled.

---

## 8. Join Statements

### 8.1 `joinStatements.join.keywordAlignment`

Values: `"toFrom"` | `"toTable"`  
Active: `"toFrom"`

Controls where JOIN keywords are placed relative to FROM.

**→ `"toFrom"` (active):** JOIN aligns with FROM (both at statement column):
```sql
SELECT *
FROM       Person.Address
INNER JOIN Person.StateProvince
      ON   StateProvince.StateProvinceID = Address.StateProvinceID
INNER JOIN Sales.SalesTerritory
      ON   SalesTerritory.TerritoryID = StateProvince.TerritoryID
```

**→ `"toTable"`:** JOIN is indented under the FROM table:
```sql
SELECT *
FROM   Person.Address
       INNER JOIN Person.StateProvince
             ON StateProvince.StateProvinceID = Address.StateProvinceID
       INNER JOIN Sales.SalesTerritory
             ON SalesTerritory.TerritoryID = StateProvince.TerritoryID
```

See [configurations/joinStatements.md](configurations/joinStatements.md) for full examples.

---

### 8.2 `joinStatements.join.indentJoinTable`

Values: `true` | `false`  
Active: `false`

When `true`, the joined table name is indented relative to the JOIN keyword.

---

### 8.3 `joinStatements.join.placeTableOnNewLine`

Values: `true` | `false`  
Active: `false`

When `true`, the joined table name is placed on a new line after the JOIN keyword.

---

### 8.4 `joinStatements.join.breakType`

Values: `"always"` | `"never"` | `"whenLong"`  
Active: `"always"`

Controls when each JOIN clause starts on a new line.

---

### 8.5 `joinStatements.on.placeOnNewLine`

Values: `true` | `false`  
Active: `true`

When `true`, the ON keyword is placed on a new line below the joined table name.

---

### 8.6 `joinStatements.on.keywordAlignment`

Values: `"indented"` | `"toJoin"` | `"toTable"`  
Active: `"indented"`

Horizontal position of the ON keyword.

**→ `"indented"` (active):** ON is indented relative to JOIN.  
**→ `"toJoin"`:** ON aligns with JOIN.  
**→ `"toTable"`:** ON aligns with the joined table name.

---

### 8.7 `joinStatements.on.conditionAlignment`

Values: `"toInner"` | `"toJoin"` | `"toStatement"`  
Active: `"toInner"`

Horizontal position of the join condition columns after ON.

---

### 8.8 `joinStatements.on.conditionBreakType`

Values: `"never"` | `"always"` | `"whenLong"`  
Active: `"never"`

When `"always"`, each join condition (separated by AND) is placed on a new line.

---

### 8.9 `joinStatements.on.verticallyAlignWithJoinTable`

Values: `true` | `false`  
Active: `false`

When `true`, the ON condition aligns vertically with the joined table name.

---

### 8.10 `joinStatements.insertEmptyLineBetweenJoins`

Values: `true` | `false`  
Active: `false`

When `true`, a blank line is inserted between consecutive JOIN blocks for readability.

---

## 9. Operators

### 9.1 `operators.andOr.alignment`

Values: `"toFirstItem"` | `"rightAligned"`  
Active: `"toFirstItem"`

Horizontal alignment of AND/OR keywords in multi-condition WHERE/HAVING clauses.

**→ `"toFirstItem"` (active):** AND/OR aligns to the first condition column:
```sql
WHERE  ModifiedDate > '2020-01-01'
       AND City = 'Bothell'
       OR  PostalCode = 'CB1'
```

**→ `"rightAligned"`:** AND/OR are right-aligned so their last characters align:
```sql
WHERE  ModifiedDate > '2020-01-01'
  AND  City = 'Bothell'
   OR  PostalCode = 'CB1'
```

See [configurations/operators.md](configurations/operators.md) for full examples.

---

### 9.2 `operators.andOr.breakType`

Values: `"always"` | `"never"` | `"wrap"`  
Active: `"always"`

When `"always"`, each AND/OR starts on a new line. When `"never"`, they stay inline.

**→ `"never"`:**
```sql
WHERE  ModifiedDate > '2020-01-01' AND City = 'Bothell' OR PostalCode = 'CB1'
```

---

### 9.3 `operators.between.placeOnNewLine`

Values: `true` | `false`  
Active: `false`

When `true`, BETWEEN is placed on a new line relative to its left operand.

---

### 9.4 `operators.between.placeAndOnNewLine`

Values: `true` | `false`  
Active: `false`

When `true`, the AND inside a BETWEEN expression is placed on a new line.

---

### 9.5 `operators.between.andAlignment`

Values: `"toBetween"` | `"toCondition"`  
Active: `"toBetween"`

Horizontal position of the AND keyword inside a BETWEEN expression when on a new line.

**→ `"toBetween"` (active):**
```sql
WHERE d BETWEEN '2020-01-01'
        AND     '2020-12-31'
```

---

### 9.6 `operators.in.placeFirstValueOnNewLine` / `placeSubsequentValuesOnNewLines`

Both values: `"never"` | `"always"` | `"wrap"` | `"whenLong"`  
Active: both `"wrap"`

Controls how values inside an `IN (...)` predicate are broken across lines.

**→ `"wrap"` (active):** breaks when the IN list would exceed `wrapLinesLongerThan`.  
**→ `"always"`:**
```sql
WHERE CountryCode IN (
       'US'
     , 'GB'
     , 'DE'
     )
```

---

### 9.7 `operators.in.openingParenthesisAlignment` / `openingParenthesisBreakType`

`openingParenthesisAlignment`: `"toStatement"` | `"tabbed"` (active: `"toStatement"`)  
`openingParenthesisBreakType`: `"never"` | `"always"` | `"whenLong"` (active: `"never"`)

Position of the `(` in an IN predicate when it moves to a new line.

---

### 9.8 `operators.in.addSpaceAroundInContents`

Values: `true` | `false`  
Active: `true`

Adds spaces inside the IN parentheses: `IN ( 1, 2 )` vs `IN (1, 2)`.

---

### 9.9 `operators.comparisonOperators.spaceBefore` / `spaceAfter`

Values: `true` | `false`  
Active: both `true`

Adds spaces around `=`, `<>`, `>`, `<`, `>=`, `<=`.

**→ `true` (active):** `x = 1`, `a <> b`  
**→ `false`:** `x=1`, `a<>b`

---

### 9.10 `operators.comparisonOperators.verticallyAlign`

Values: `true` | `false`  
Active: `false`

When `true`, comparison operators in a condition list are vertically aligned.

**→ `true`:**
```sql
WHERE  City          = 'Bothell'
   AND PostalCode     = 'CB1'
   AND TerritoryID   >= 1
```

---

### 9.11 `operators.arithmeticOperators.spaceBefore` / `spaceAfter`

Values: `true` | `false`  
Active: both `true`

Adds spaces around `+`, `-`, `*`, `/`, `%`.

**→ `true` (active):** `a + b`, `x * 2`  
**→ `false`:** `a+b`, `x*2`

---

## 10. Case Expressions

**Reference input for all 10.x tests:**
```sql
SELECT CASE Status WHEN 1 THEN 'Active' WHEN 2 THEN 'Inactive' ELSE 'Unknown' END AS StatusLabel
FROM   dbo.Orders
```

### 10.1 `caseExpressions.placeExpressionOnNewLine`

Values: `true` | `false`  
Active: `false`

When `true`, the input expression in `CASE <expr> WHEN …` is placed on a new line after CASE.

---

### 10.2 `caseExpressions.placeFirstWhenOnNewLine`

Values: `"always"` | `"never"` | `"ifInputExpression"`  
Active: `"ifInputExpression"`

Controls whether the first WHEN starts on a new line.

- `"ifInputExpression"` — new line when there is a CASE input expression (`CASE x WHEN …`) but not for searched CASE (`CASE WHEN …`)

---

### 10.3 `caseExpressions.whenAlignment`

Values: `"toFirstItem"` | `"toCase"` | `"indented"`  
Active: `"toFirstItem"`

Horizontal position of WHEN/ELSE relative to CASE.

**→ `"toFirstItem"` (active) with `placeFirstWhenOnNewLine: "ifInputExpression"`:**
```sql
SELECT CASE Status
            WHEN 1 THEN 'Active'
            WHEN 2 THEN 'Inactive'
            ELSE        'Unknown'
       END AS StatusLabel
FROM   dbo.Orders
```

---

### 10.4 `caseExpressions.alignElseToWhen`

Values: `true` | `false`  
Active: `true`

When `true`, ELSE aligns with the WHEN keywords.

---

### 10.5 `caseExpressions.placeElseOnNewLine`

Values: `true` | `false`  
Active: `true`

When `true`, ELSE starts on a new line.

---

### 10.6 `caseExpressions.placeEndOnNewLine`

Values: `true` | `false`  
Active: `true`

When `true`, END starts on a new line.

---

### 10.7 `caseExpressions.endAlignment`

Values: `"toCase"` | `"toFirstItem"` | `"indented"`  
Active: `"toCase"`

Horizontal position of END.

---

### 10.8 `caseExpressions.expressionAlignment`

Values: `"tabbed"` | `"toFirstItem"` | `"toCase"`  
Active: `"tabbed"`

Horizontal position of the CASE input expression.

---

### 10.9 `caseExpressions.placeThenOnNewLine`

Values: `true` | `false`  
Active: `false`

When `true`, THEN is placed on a new line after the WHEN condition.

---

### 10.10 `caseExpressions.collapseCaseExpressionsShorterThan` / `collapseShortCaseExpressions`

`collapseCaseExpressionsShorterThan`: `number` (active: `75`)  
`collapseShortCaseExpressions`: `boolean` (active: `false` — feature **disabled**)

Short CASE expressions are collapsed to one line when enabled.

---

## 11. CTE

**Reference input for all 11.x tests:**
```sql
WITH OrderCTE AS (SELECT OrderID, Total FROM dbo.Orders WHERE Total > 0)
SELECT * FROM OrderCTE
```

### 11.1 `cte.asAlignment`

Values: `"tabbed"` | `"indented"` | `"toStatement"`  
Active: `"tabbed"`

Position of the AS keyword in a CTE definition.

**→ `"tabbed"` (active):**
```sql
WITH OrderCTE
     AS (
     SELECT OrderID, Total
     FROM   dbo.Orders
     WHERE  Total > 0
     )
SELECT *
FROM   OrderCTE
```

---

### 11.2 `cte.indentContents`

Values: `true` | `false`  
Active: `false`

When `true`, the SELECT inside the CTE parentheses is indented.

---

### 11.3 `cte.indentName`

Values: `true` | `false`  
Active: `false`

When `true`, the CTE name is indented relative to WITH.

---

### 11.4 `cte.preferBreakBeforeName`

Values: `true` | `false`  
Active: `false`

When `true`, the CTE name is placed on a new line after WITH.

---

### 11.5 `cte.contentsParenthesisLayout`

Values: `"compactSimple"` | `"expandedIndented"`  
Active: `"compactSimple"`

Layout of the parentheses containing the CTE body.

---

### 11.6 `cte.columnsOpeningParenthesisAlignment` / `columnsOpeningParenthesisBreakType`

`columnsOpeningParenthesisAlignment`: `"toStatement"` | `"tabbed"` | `"toOpeningBracket"` (active: `"toStatement"`)  
`columnsOpeningParenthesisBreakType`: `"never"` | `"always"` | `"whenLong"` (active: `"never"`)

Position and break policy for the `(` of the optional CTE column list.

---

### 11.7 `cte.contentsOpeningParenthesisAlignment` / `contentsOpeningParenthesisBreakType`

`contentsOpeningParenthesisAlignment`: `"toStatement"` | `"tabbed"` | `"toOpeningBracket"` (active: `"toStatement"`)  
`contentsOpeningParenthesisBreakType`: `"never"` | `"always"` | `"whenLong"` (active: `"never"`)

Position and break policy for the `(` that wraps the CTE body.

---

### 11.8 `cte.contentsExpressionAlignment` / `contentsExpressionBreakType`

`contentsExpressionAlignment`: `"toStartOfOpeningBracket"` | `"toStatement"` | `"tabbed"` (active: `"toStartOfOpeningBracket"`)  
`contentsExpressionBreakType`: `"never"` | `"always"` | `"whenLong"` (active: `"never"`)

Alignment and break policy for the body expression inside the CTE parentheses.

---

## 12. Variables

### 12.1 `variables.placeAssignedValueOnNewLineIfLongerThanMaxLineLength`

Values: `true` | `false`  
Active: `false`

When `true`, the value in a `SET @var = <expr>` is moved to a new line if the total line length exceeds `wrapLinesLongerThan`.

**→ `true` (long expression):**
```sql
SET @message =
      'This is a very long string value that would push the line over the wrap column limit';
```

**→ `false` (active):** the value stays on the same line as SET regardless.

---

## 13. Function Calls

### 13.1 `functionCalls.placeArgumentsOnNewLines`

Values: `"never"` | `"always"` | `"wrap"` | `"whenLong"`  
Active: `"wrap"`

Controls when function arguments are broken across lines.

**→ `"wrap"` (active):** breaks only when the call would exceed `wrapLinesLongerThan`.  
**→ `"never"`:** all arguments always on one line.  
**→ `"always"`:**
```sql
CONVERT(
       VARCHAR(10),
       DATEADD(DAY, -1, GETDATE()),
       120
       )
```

---

### 13.2 `functionCalls.addSpacesAroundArguments`

Values: `true` | `false`  
Active: `false`

Adds spaces inside the function argument parentheses.

**→ `false` (active):** `ISNULL(x, 0)`  
**→ `true`:** `ISNULL( x, 0 )`

---

### 13.3 `functionCalls.addSpacesAroundCall`

Values: `true` | `false`  
Active: `false`

Adds a space between the function name and its `(`.

**→ `false` (active):** `GETDATE()`  
**→ `true`:** `GETDATE ()`

---

## 14. Insert Statements

**Reference input for all 14.x tests:**
```sql
INSERT INTO dbo.Orders (OrderID, OrderDate, Total) VALUES (1, GETDATE(), 100.00)
```

### 14.1 `insertStatements.columns.parenthesisStyle`

Values: `"compactSimple"` | `"expandedIndented"`  
Active: `"compactSimple"`

Layout of the column list parentheses.

---

### 14.2 `insertStatements.columns.indentContents`

Values: `true` | `false`  
Active: `false`

When `true`, the column list is indented inside the parentheses.

---

### 14.3 `insertStatements.columns.subsequentItemsBreakType`

Values: `"always"` | `"never"` | `"wrap"` | `"whenLong"`  
Active: `"always"`

Controls whether each subsequent column in the INSERT list starts on a new line.

**→ `"always"` (active):**
```sql
INSERT INTO dbo.Orders
            (
            OrderID
          , OrderDate
          , Total
            )
VALUES      ( 1, GETDATE(), 100.00 )
```

---

### 14.4 `insertStatements.values.parenthesisStyle`

Values: `"compactSimple"` | `"expandedIndented"`  
Active: `"compactSimple"`

Layout of the VALUES parentheses.

---

### 14.5 `insertStatements.values.subsequentItemsBreakType`

Values: `"always"` | `"never"` | `"wrap"` | `"whenLong"`  
Active: `"wrap"`

Controls whether each subsequent value in the VALUES list starts on a new line.

---

### 14.6 `insertStatements.preferBreakBeforeTable`

Values: `true` | `false`  
Active: `false`

When `true`, the target table name is placed on a new line after INSERT INTO.

**→ `true`:**
```sql
INSERT INTO
            dbo.Orders
            ( OrderID, OrderDate, Total )
VALUES      ( 1, GETDATE(), 100.00 )
```
