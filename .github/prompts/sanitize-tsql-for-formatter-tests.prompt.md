---
description: "Sanitize and minimize a T-SQL script for public formatter tests while preserving SQL validity"
name: "Sanitize T-SQL For Formatter Tests"
argument-hint: "Paste a T-SQL script or describe the SQL file to sanitize"
agent: "agent"
---
Sanitize the provided T-SQL so it is safe for a public repository and still valid for formatter tests.

Input assumptions:
- The user provides T-SQL directly in chat or through selected editor content.
- The goal is not business correctness; the goal is formatter coverage with valid SQL syntax.

Rules:
1. Remove sensitive details:
- Remove or rewrite comments containing internal references.
- Replace company names, customer names, server names, schema specifics, and business identifiers with neutral placeholders.
- Replace table and view names with generic names when they reveal domain-specific information.

2. Generic naming:
- Keep one identity-like primary key when present (for example: `id`).
- Rename other columns to generic names such as `COL1`, `col2`, `Col3`, `COL_UMN4`.
- Ensure references stay consistent across SELECT, JOIN, INSERT, UPDATE, WHERE, ORDER BY, function calls, and procedure bodies.

3. Minimize while preserving type variety:
- Reduce columns so only one representative column per useful data-type pattern remains.
- Keep only enough columns to preserve meaningful formatting cases and SQL validity.
- Always preserve diverse examples when present (for example different statement families, datatype patterns, and identifier casing styles).
- Example intent: if multiple similar VARCHAR columns exist, keep one representative unless more are required for syntax validity.

4. Remove repetitive near-duplicates:
- Remove or collapse repeated SQL blocks that differ only by table names or trivial aliases.
- Keep a single representative pattern for each formatting construct.

5. Minimize procedure/function invocations:
- When procedure or function calls have many parameters, keep only the minimum subset needed to remain syntactically valid and representative.
- If named parameters are used, keep the style consistent after reduction.

6. Preserve formatter-test usefulness:
- Keep the script syntactically valid T-SQL.
- Preserve a representative and diverse set of constructs (DDL, DML, control-flow, function/procedure-call style) when present.
- Do not introduce placeholders that break parsing.

Output format:
1. Return only the sanitized T-SQL in a single SQL code block.
2. Do not add explanations, notes, or any text outside the SQL code block.
