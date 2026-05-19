/**
 * CompletionEngine
 *
 * Builds VS Code LSP `CompletionItem[]` from a resolved `QueryContext` and the
 * schema snapshot.  All completion builders that previously lived in server.ts
 * have been consolidated here.
 *
 * Entry point: `buildCompletions(context, tables, document, position, statementRange)`
 *
 * Routing:
 *   isAfterDot          → dot-qualified completions (columns or table names)
 *   clause === 'select' → column projections, star expansion
 *   clause === 'from'|'join'  → table / schema completions
 *   clause === 'on'     → FK predicate suggestions
 *   clause === 'where'  → FK predicate + column completions
 *   fallback            → SQL keywords (when in a recognisable SQL context)
 */

import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
  TextEdit,
  Range,
  Position,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { QueryContext, VisibleSource } from './types';
import { TableInfo } from './schemaLoader';
import { StatementRange } from './documentTextService';
import { generateAlias, stripIdentifierDelimiters } from './utils';

// ── Snippet completions ───────────────────────────────────────────────────────

function buildSnippetCompletions(clause: string, position: Position): CompletionItem[] {
  const items: CompletionItem[] = [];

  if (clause === 'join') {
    // OUTER APPLY snippet
    items.push({
      label: 'OUTER',
      kind: CompletionItemKind.Snippet,
      insertText: 'OUTER APPLY ',
      insertTextFormat: InsertTextFormat.PlainText,
      detail: 'OUTER APPLY',
      sortText: '70_outer',
      textEdit: TextEdit.replace(
        Range.create(position.line, position.character, position.line, position.character),
        'OUTER APPLY ',
      ),
    });
    // CROSS APPLY snippet
    items.push({
      label: 'CROSS',
      kind: CompletionItemKind.Snippet,
      insertText: 'CROSS APPLY ',
      insertTextFormat: InsertTextFormat.PlainText,
      detail: 'CROSS APPLY',
      sortText: '70_cross',
      textEdit: TextEdit.replace(
        Range.create(position.line, position.character, position.line, position.character),
        'CROSS APPLY ',
      ),
    });
  }

  return items;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function buildCompletions(
  context: QueryContext,
  tables: TableInfo[],
  document: TextDocument,
  position: Position,
  statementRange: StatementRange,
): CompletionItem[] {
  // ── 1. Dot-qualified completions ─────────────────────────────────────────
  if (context.isAfterDot && context.qualifierChain?.length) {
    return buildDotCompletions(context, tables, position);
  }

  const items: CompletionItem[] = [];
  const refs = resolveRefs(context.visibleSources, tables);
  const lineText = document.getText({
    start: { line: position.line, character: 0 },
    end: position,
  });

  // ── 2. Star expansion (highest priority in SELECT) ───────────────────────
  if (context.clause === 'select' && (refs.length || context.visibleSources.length)) {
    const starItems = buildStarExpansionCompletions(
      context,
      refs,
      document,
      statementRange,
    );
    if (starItems.length) return starItems;
  }

  // ── 3. Clause-specific completions ──────────────────────────────────────
  switch (context.clause) {
    case 'select':
      items.push(...buildSnippetCompletions('select', position));
      items.push(...buildColumnCompletionsForRefs(refs, true, false));
      items.push(...buildColumnCompletionsForSources(context.visibleSources));
      // Always offer an "expand all columns" item when there are visible sources
      items.push(...buildExpandAllColumnsItem(context, refs, document, statementRange, position));
      break;

    case 'from':
    case 'join': {
      // Build the set of aliases already committed in the current query so that
      // new suggestions get a deduplicated alias (e.g. o2 when o is taken).
      const usedAliases = new Set(
        context.visibleSources
          .map((s) => s.alias)
          .filter((a): a is string => a !== undefined),
      );

      items.push(...buildSnippetCompletions(context.clause, position));
      const schemaMatch = SCHEMA_DOT_PATTERN.exec(lineText);
      if (schemaMatch) {
        const schemaName = schemaMatch[1];
        const replaceRange = replaceRangeWordOnly(lineText, position);
        tables
          .filter((t) => t.schema.toLowerCase() === schemaName.toLowerCase())
          .forEach((table) => {
            // Pass a copy so that sibling items don't affect each other.
            const alias = generateAlias(table.name, new Set(usedAliases));
            items.push({
              label: table.name,
              kind: CompletionItemKind.Class,
              detail: `Table — alias: ${alias}`,
              filterText: table.name,
              textEdit: TextEdit.replace(replaceRange, `${table.name} AS ${alias}`),
              insertTextFormat: InsertTextFormat.PlainText,
              sortText: `0${table.name}`,
              data: { type: 'table', index: tables.indexOf(table) },
            });
          });
      } else {
        const replaceRange = replaceRangeWordOnly(lineText, position);
        tables.forEach((table, idx) => {
          const alias = generateAlias(table.name, new Set(usedAliases));
          const fullName = `${table.schema}.${table.name}`;
          items.push({
            label: fullName,
            kind: CompletionItemKind.Class,
            detail: `Table (${table.schema}) — alias: ${alias}`,
            filterText: fullName,
            textEdit: TextEdit.replace(replaceRange, `${fullName} AS ${alias}`),
            insertTextFormat: InsertTextFormat.PlainText,
            sortText: `0${table.name}`,
            data: { type: 'table', index: idx },
          });
        });

        // Add all defined CTEs to FROM/JOIN suggestions
        context.visibleCtes.forEach((cteName, cteIdx) => {
          const alias = generateAlias(cteName, new Set(usedAliases));
          items.push({
            label: cteName,
            kind: CompletionItemKind.Variable,
            detail: `CTE — alias: ${alias}`,
            filterText: cteName,
            textEdit: TextEdit.replace(replaceRange, `${cteName} AS ${alias}`),
            insertTextFormat: InsertTextFormat.PlainText,
            sortText: `1_cte_${cteIdx}`,
          });
        });
      }

      // After a JOIN + table ref, suggest "ON fk.predicate"
      if (context.clause === 'join' && refs.length >= 2) {
        items.push(...buildJoinOnClauseCompletions(refs, position, new Set()));
      }
      break;
    }

    case 'on': {
      const usedPredicates = extractUsedOnPredicates(
        statementRange.text,
        context.cursorOffset - statementRange.start,
      );
      items.push(...buildOnPredicateCompletions(refs, position, usedPredicates));
      items.push(...buildColumnCompletionsForRefs(refs, true, false));
      items.push(...buildColumnCompletionsForSources(context.visibleSources));
      break;
    }

    case 'where': {
      items.push(...buildWherePredicateCompletions(refs, position));
      items.push(...buildColumnCompletionsForRefs(refs, true, false));
      items.push(...buildColumnCompletionsForSources(context.visibleSources));
      break;
    }

    case 'groupBy':
    case 'having':
    case 'orderBy':
      items.push(...buildColumnCompletionsForRefs(refs, true, false));
      items.push(...buildColumnCompletionsForSources(context.visibleSources));
      break;

    case 'updateSet':
      items.push(...buildColumnCompletionsForRefs(refs, true, false));
      items.push(...buildColumnCompletionsForSources(context.visibleSources));
      break;

    default:
      // Always offer the SSF snippet at statement-level context.
      items.push({
        label: 'ssf',
        kind: CompletionItemKind.Snippet,
        insertText: 'SELECT * FROM ',
        insertTextFormat: InsertTextFormat.PlainText,
        detail: 'SELECT * FROM',
        sortText: '70_ssf',
        textEdit: TextEdit.replace(
          Range.create(position.line, position.character, position.line, position.character),
          'SELECT * FROM ',
        ),
      });
      // General SQL context: keywords + tables when in a recognisable DML statement.
      if (context.statementKind !== 'unknown') {
        items.push(...buildSqlKeywordCompletions(position));
        if (tables.length > 0) {
          tables.forEach((table, idx) => {
            const fullName = `${table.schema}.${table.name}`;
            items.push({
              label: fullName,
              kind: CompletionItemKind.Class,
              detail: `Table (${table.columns.length} columns)`,
              filterText: fullName,
              insertText: fullName,
              insertTextFormat: InsertTextFormat.PlainText,
              sortText: `9${table.name}`,
              data: { type: 'table', index: idx },
            });
          });
        }
      }
      break;
  }

  return items;
}

/**
 * Resolves the completion detail for a table item (used in onCompletionResolve).
 */
export function resolveTableCompletionItem(item: CompletionItem, tables: TableInfo[]): CompletionItem {
  if (item.data?.type === 'table') {
    const table = tables[item.data.index];
    if (table) {
      item.documentation = {
        kind: 'markdown',
        value:
          `**${table.schema}.${table.name}**\n\nColumns:\n` +
          table.columns
            .map((c) => `- \`${c.name}\` (${c.dataType}${c.isNullable ? ', nullable' : ''})`)
            .join('\n'),
      };
    }
  }
  return item;
}

// ── Dot completions ───────────────────────────────────────────────────────────

function buildDotCompletions(
  context: QueryContext,
  tables: TableInfo[],
  position: Position,
): CompletionItem[] {
  const chain = context.qualifierChain!;
  const qualifier = chain[chain.length - 1]; // last part before the dot
  const replaceRange = Range.create(position, position);

  // Is it a visible alias?
  const matchingSource = context.visibleSources.find(
    (s) => s.alias?.toLowerCase() === qualifier.toLowerCase(),
  );
  if (matchingSource?.columns?.length) {
    const items: CompletionItem[] = matchingSource.columns.map((col) => ({
      label: col,
      kind: CompletionItemKind.Field,
      detail: `${matchingSource.schema ? `${matchingSource.schema}.` : ""}${matchingSource.objectName}`,
      insertText: col,
      insertTextFormat: InsertTextFormat.PlainText,
      textEdit: TextEdit.replace(replaceRange, col),
      sortText: `10_${qualifier}_${col}`,
    }));

    // Also offer "Expand alias.*" when there are many columns.
    // The replace range must cover the already-typed "qualifier." prefix.
    if (matchingSource.columns.length >= 3) {
      const expansion = matchingSource.columns
        .map((c) => normalizeColumnName(c))
        .filter((name): name is string => Boolean(name))
        .map((name) => `${qualifier}.${name}`)
        .join(", ");
      if (expansion) {
        const qualDotStart = {
          line: position.line,
          character: Math.max(0, position.character - qualifier.length - 1),
        };
        items.push({
          label: `★ Expand ${qualifier}.*`,
          kind: CompletionItemKind.Snippet,
          detail: `Expands all ${matchingSource.columns.length} column(s)`,
          insertText: expansion,
          insertTextFormat: InsertTextFormat.PlainText,
          textEdit: TextEdit.replace(Range.create(qualDotStart, position), expansion),
          sortText: `09_expand_${qualifier}`,
        });
      }
    }

    return items;
  }

  // Is it a visible CTE (referenced by its CTE name, not alias)?
  if (context.visibleCtes.some((c) => c.toLowerCase() === qualifier.toLowerCase())) {
    const src = context.visibleSources.find(
      (s) => s.objectName.toLowerCase() === qualifier.toLowerCase(),
    );
    if (src?.columns?.length) {
      return src.columns.map((col) => ({
        label: col,
        kind: CompletionItemKind.Field,
        detail: `CTE: ${src.objectName}`,
        insertText: col,
        insertTextFormat: InsertTextFormat.PlainText,
        textEdit: TextEdit.replace(replaceRange, col),
        sortText: `10_${qualifier}_${col}`,
      }));
    }
    return [];
  }

  // Is it a schema name?
  const schemaLower = qualifier.toLowerCase();
  const schemaMatches = tables.filter((t) => t.schema.toLowerCase() === schemaLower);
  if (schemaMatches.length) {
    const usedAliases = new Set(
      context.visibleSources
        .map((s) => s.alias)
        .filter((a): a is string => a !== undefined),
    );
    return schemaMatches.map((table) => {
      const alias = generateAlias(table.name, new Set(usedAliases));
      return {
        label: table.name,
        kind: CompletionItemKind.Class,
        detail: `Table (${table.schema}) — alias: ${alias}`,
        filterText: table.name,
        textEdit: TextEdit.replace(replaceRange, `${table.name} AS ${alias}`),
        insertTextFormat: InsertTextFormat.PlainText,
        sortText: `0${table.name}`,
        data: { type: 'table', index: tables.indexOf(table) },
      };
    });
  }

  // Is it a table name? → offer columns
  const tableMatch = tables.find((t) => t.name.toLowerCase() === qualifier.toLowerCase());
  if (tableMatch) {
    return tableMatch.columns.map((col) => ({
      label: col.name,
      kind: CompletionItemKind.Field,
      detail: `${tableMatch.schema}.${tableMatch.name}`,
      insertText: col.name,
      insertTextFormat: InsertTextFormat.PlainText,
      textEdit: TextEdit.replace(replaceRange, col.name),
      sortText: `10_${col.name}`,
    }));
  }

  return [];
}

// ── Star expansion ────────────────────────────────────────────────────────────

/**
 * Expands `*` or `alias.*` into the explicit column list.
 * Returns an empty array when the star pattern is not detected.
 */
function buildStarExpansionCompletions(
  context: QueryContext,
  refs: ResolvedRef[],
  document: TextDocument,
  statementRange: StatementRange,
): CompletionItem[] {
  const statementText = statementRange.text;
  const cursorRelative = context.cursorOffset - statementRange.start;

  // Look at text before cursor within the statement, stripping trailing spaces.
  const beforeCursor = statementText.slice(0, cursorRelative);
  const beforeTrimmed = beforeCursor.replace(/\s+$/, '');

  // Support completion while typing after '*' as well, e.g. "*A" or "ot.*AB"
  const aliasStarMatch = /(\w+)\s*\.\s*\*\w*$/.exec(beforeTrimmed);
  const plainStarMatch = !aliasStarMatch ? /\*\w*$/.exec(beforeTrimmed) : null;

  if (!aliasStarMatch && !plainStarMatch) return [];

  const trailingSpaces = beforeCursor.length - beforeTrimmed.length;
  const absoluteEnd = statementRange.start + cursorRelative - trailingSpaces;
  let absoluteStart = absoluteEnd - 1; // default: just the *
  let replacement = '';

  if (aliasStarMatch) {
    const alias = aliasStarMatch[1];
    absoluteStart = absoluteEnd - aliasStarMatch[0].length;

    const ref = refs.find((r) => r.alias.toLowerCase() === alias.toLowerCase());
    if (ref) {
      replacement = ref.table.columns
        .map((c) => normalizeColumnName((c as any)?.name ?? c))
        .filter((name): name is string => Boolean(name))
        .map((name) => `${ref.alias}.${name}`)
        .join(', ');
    } else {
      // Fall back to CTE / unresolved visible sources
      const src = context.visibleSources.find(
        (s) => s.alias?.toLowerCase() === alias.toLowerCase(),
      );
      if (src?.columns?.length) {
        replacement = src.columns
          .map((c) => normalizeColumnName(c))
          .filter((name): name is string => Boolean(name))
          .map((name) => `${alias}.${name}`)
          .join(', ');
      } else {
        return [];
      }
    }
  } else {
    // Combine resolved table refs and CTE/unresolved sources
    const refCols = refs.flatMap((ref) =>
      ref.table.columns
        .map((c) => normalizeColumnName((c as any)?.name ?? c))
        .filter((name): name is string => Boolean(name))
        .map((name) => `${ref.alias}.${name}`),
    );
    const cteCols = context.visibleSources
      .filter((s) => !s.schema && s.columns?.length)
      .flatMap((s) =>
        (s.columns ?? [])
          .map((c) => normalizeColumnName(c))
          .filter((name): name is string => Boolean(name))
          .map((name) => `${s.alias ?? s.objectName}.${name}`),
      );
    replacement = [...refCols, ...cteCols].join(', ');
  }

  if (!replacement) return [];

  const startPos = document.positionAt(absoluteStart);
  const endPos = document.positionAt(absoluteEnd);

  return [
    {
      label: 'Expand wildcard to columns',
      kind: CompletionItemKind.Snippet,
      detail: 'Expand * using tables in current query',
      documentation: { kind: 'markdown', value: `Inserts: \`${replacement}\`` },
      preselect: true,
      textEdit: TextEdit.replace(
        Range.create(startPos.line, startPos.character, endPos.line, endPos.character),
        replacement,
      ),
      insertTextFormat: InsertTextFormat.PlainText,
      sortText: '00_expand_star',
    },
  ];
}

// ── Expand all columns (explicit item, always available in SELECT) ─────────

/**
 * Provides a single completion item that, when accepted, inserts ALL columns
 * from all visible sources (tables + CTEs). Available in SELECT regardless
 * of whether `*` has been typed.
 */
function buildExpandAllColumnsItem(
  context: QueryContext,
  refs: ResolvedRef[],
  document: TextDocument,
  statementRange: StatementRange,
  position: Position,
): CompletionItem[] {
  const refCols = refs.flatMap((ref) =>
    ref.table.columns
      .map((c) => normalizeColumnName((c as any)?.name ?? c))
      .filter((name): name is string => Boolean(name))
      .map((name) => `${ref.alias}.${name}`),
  );
  const cteCols = context.visibleSources
    .filter((s) => !s.schema && s.columns?.length)
    .flatMap((s) =>
      (s.columns ?? [])
        .map((c) => normalizeColumnName(c))
        .filter((name): name is string => Boolean(name))
        .map((name) => `${s.alias ?? s.objectName}.${name}`),
    );

  const allCols = [...refCols, ...cteCols];
  if (allCols.length === 0) return [];

  const replacement = allCols.join(', ');
  const replaceRange = Range.create(position, position);

  return [{
    label: '★ Expand all columns',
    kind: CompletionItemKind.Snippet,
    detail: `Inserts ${allCols.length} column(s) from all visible tables`,
    documentation: { kind: 'markdown', value: `\`\`\`sql\n${replacement}\n\`\`\`` },
    textEdit: TextEdit.replace(replaceRange, replacement),
    insertTextFormat: InsertTextFormat.PlainText,
    filterText: 'expand columns all star',
    sortText: '00_expand_all',
  }];
}

// ── Column completions ────────────────────────────────────────────────────────

function buildColumnCompletionsForRefs(
  refs: ResolvedRef[],
  includeAlias: boolean,
  aliasAlreadyTyped: boolean,
): CompletionItem[] {
  return refs.flatMap((ref) =>
    ref.table.columns.flatMap((column) => {
      const colName = normalizeColumnName((column as any)?.name ?? column);
      if (!colName) return [];

      // Use table name instead of alias if the alias was auto-generated
      const qualifier = ref.isAutoAlias ? ref.table.name : ref.alias;
      const insertValue = includeAlias ? `${qualifier}.${colName}` : colName;
      const label = aliasAlreadyTyped ? colName : `${qualifier}.${colName}`;

      return [{
        label,
        kind: CompletionItemKind.Field,
        detail: `${ref.table.schema}.${ref.table.name}`,
        documentation: { kind: 'markdown', value: `Inserts: \`${insertValue}\`` },
        insertText: insertValue,
        insertTextFormat: InsertTextFormat.PlainText,
        sortText: `10_${qualifier}_${colName}`,
      }];
    }),
  );
}

// ── CTE / unresolved-source column completions ────────────────────────────────

/**
 * Builds column completions for VisibleSources that have no backing schema
 * (CTEs, derived-table aliases) but whose columns were extracted from the
 * CTE body.  These complement the schema-resolved `buildColumnCompletionsForRefs`.
 */
function buildColumnCompletionsForSources(sources: VisibleSource[]): CompletionItem[] {
  return sources
    .filter((s) => !s.schema && s.columns?.length)
    .flatMap((s) =>
      (s.columns ?? []).flatMap((col) => {
        const colName = normalizeColumnName(col);
        if (!colName) return [];

        const alias = s.alias ?? s.objectName;
        const insertValue = `${alias}.${colName}`;
        return [{
          label: insertValue,
          kind: CompletionItemKind.Field,
          detail: `CTE: ${s.objectName}`,
          documentation: { kind: 'markdown', value: `Inserts: \`${insertValue}\`` },
          insertText: insertValue,
          insertTextFormat: InsertTextFormat.PlainText,
          sortText: `10_${alias}_${colName}`,
        }];
      }),
    );
}

function normalizeColumnName(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  if (!raw || typeof raw !== 'object') return undefined;

  const obj = raw as Record<string, unknown>;
  const candidate = obj.name ?? obj.column_name ?? obj.displayValue ?? obj.value;
  if (typeof candidate === 'string') return candidate;
  if (typeof candidate === 'number' || typeof candidate === 'boolean') return String(candidate);
  return undefined;
}

// ── FK predicate completions ──────────────────────────────────────────────────

type PredicateSuggestion = {
  label: string;
  insertText: string;
  preview: string;
  detail: string;
  sortKey: string;
};

function buildFkPredicateSuggestions(
  refs: ResolvedRef[],
  options?: { includeCombined?: boolean; excludePredicates?: Set<string> },
): PredicateSuggestion[] {
  if (refs.length < 2) return [];

  const includeCombined = options?.includeCombined ?? true;
  const excludePredicates = options?.excludePredicates ?? new Set<string>();
  const joinRef = refs[refs.length - 1];
  const previousRefs = refs.slice(0, -1);
  const suggestions: PredicateSuggestion[] = [];
  const seen = new Set<string>();

  function addSuggestions(
    fromRef: ResolvedRef,
    toRef: ResolvedRef,
    fkMappings: Array<{ column: string; referencedColumn: string }>,
    fkName: string,
  ) {
    const singles = fkMappings.map(
      (m) => `${fromRef.alias}.${m.column} = ${toRef.alias}.${m.referencedColumn}`,
    );
    const previews = fkMappings.map(
      (m) => `${fromRef.alias}.${m.column} → ${toRef.alias}.${m.referencedColumn}`,
    );
    const combined = singles.join(' AND ');
    const combinedPreview = previews.join(' AND ');
    const normalised = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();

    if (includeCombined && !seen.has(combined) && !excludePredicates.has(normalised(combined))) {
      seen.add(combined);
      suggestions.push({
        label: `${fromRef.alias} → ${toRef.alias} (ALL)`,
        insertText: combined,
        preview: combinedPreview,
        detail: `FK ${fkName}`,
        sortKey: `00_${fromRef.alias}_${toRef.alias}`,
      });
    }

    for (let i = 0; i < singles.length; i++) {
      const norm = normalised(singles[i]);
      if (seen.has(singles[i]) || excludePredicates.has(norm)) continue;
      seen.add(singles[i]);
      suggestions.push({
        label: previews[i],
        insertText: singles[i],
        preview: previews[i],
        detail: `FK ${fkName}`,
        sortKey: `01_${fromRef.alias}_${toRef.alias}`,
      });
    }
  }

  for (const prevRef of previousRefs) {
    // FK from joinRef → prevRef
    for (const fk of joinRef.table.foreignKeys ?? []) {
      if (
        fk.referencedSchema.toLowerCase() === prevRef.table.schema.toLowerCase() &&
        fk.referencedTable.toLowerCase() === prevRef.table.name.toLowerCase() &&
        fk.mappings.length
      ) {
        addSuggestions(joinRef, prevRef, fk.mappings, fk.name);
      }
    }
    // FK from prevRef → joinRef
    for (const fk of prevRef.table.foreignKeys ?? []) {
      if (
        fk.referencedSchema.toLowerCase() === joinRef.table.schema.toLowerCase() &&
        fk.referencedTable.toLowerCase() === joinRef.table.name.toLowerCase() &&
        fk.mappings.length
      ) {
        addSuggestions(prevRef, joinRef, fk.mappings, fk.name);
      }
    }
  }

  return suggestions;
}

function buildJoinOnClauseCompletions(
  refs: ResolvedRef[],
  position: Position,
  excludePredicates: Set<string>,
): CompletionItem[] {
  return buildFkPredicateSuggestions(refs, {
    includeCombined: true,
    excludePredicates,
  }).map((s) => {
    const insertValue = `ON ${s.insertText} `;
    return {
      label: `ON ${s.label}`,
      kind: CompletionItemKind.Keyword,
      detail: s.preview,
      documentation: { kind: 'markdown', value: `Inserts: \`${insertValue.trim()}\`` },
      textEdit: TextEdit.replace(
        Range.create(position.line, position.character, position.line, position.character),
        insertValue,
      ),
      sortText: s.sortKey,
    };
  });
}

function buildOnPredicateCompletions(
  refs: ResolvedRef[],
  position: Position,
  excludePredicates: Set<string>,
): CompletionItem[] {
  return buildFkPredicateSuggestions(refs, {
    includeCombined: false,
    excludePredicates,
  }).map((s) => ({
    label: s.insertText,
    kind: CompletionItemKind.Operator,
    detail: s.preview,
    documentation: { kind: 'markdown', value: `Inserts: \`${s.insertText}\`` },
    textEdit: TextEdit.replace(
      Range.create(position.line, position.character, position.line, position.character),
      `${s.insertText} `,
    ),
    sortText: s.sortKey,
  }));
}

function buildWherePredicateCompletions(refs: ResolvedRef[], position: Position): CompletionItem[] {
  return buildFkPredicateSuggestions(refs, { includeCombined: true }).map((s) => ({
    label: s.insertText,
    kind: CompletionItemKind.Operator,
    detail: `WHERE: ${s.preview}`,
    documentation: { kind: 'markdown', value: `Inserts: \`${s.insertText}\`` },
    textEdit: TextEdit.replace(
      Range.create(position.line, position.character, position.line, position.character),
      `${s.insertText} `,
    ),
    sortText: `05_${s.sortKey}`,
  }));
}

// ── Keyword completions ───────────────────────────────────────────────────────

const SQL_KEYWORDS_LIST = [
  'SELECT', 'FROM', 'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN',
  'FULL JOIN', 'CROSS JOIN', 'CROSS APPLY', 'OUTER APPLY',
  'ON', 'WHERE', 'AND', 'OR', 'EXISTS',
  'GROUP BY', 'ORDER BY', 'HAVING', 'UNION', 'UNION ALL',
  'INSERT INTO', 'UPDATE', 'SET', 'DELETE FROM',
];

function buildSqlKeywordCompletions(position: Position): CompletionItem[] {
  return SQL_KEYWORDS_LIST.map((kw, idx) => ({
    label: kw,
    kind: CompletionItemKind.Keyword,
    insertText: `${kw} `,
    insertTextFormat: InsertTextFormat.PlainText,
    textEdit: TextEdit.replace(
      Range.create(position.line, position.character, position.line, position.character),
      `${kw} `,
    ),
    sortText: `80_${idx.toString().padStart(2, '0')}`,
  }));
}

// ── Helper: resolve VisibleSource[] → ResolvedRef[] ──────────────────────────

/**
 * Maps visible sources back to their full `TableInfo` (needed for FK logic).
 * Sources without a schema (CTEs, unresolved subqueries) are skipped.
 */
type ResolvedRef = { table: TableInfo; alias: string; isAutoAlias: boolean };

function resolveRefs(sources: VisibleSource[], tables: TableInfo[]): ResolvedRef[] {
  const result: ResolvedRef[] = [];
  for (const s of sources) {
    if (!s.schema) continue; // CTE or unresolved
    const table = tables.find(
      (t) =>
        t.name.toLowerCase() === s.objectName.toLowerCase() &&
        t.schema.toLowerCase() === s.schema!.toLowerCase(),
    );
    if (table) {
      result.push({
        table,
        alias: s.alias ?? generateAlias(table.name),
        isAutoAlias: !(s.explicitAlias ?? false),
      });
    }
  }
  return result;
}

// ── Helper: extract already-used ON predicates ────────────────────────────────

/**
 * Collects the predicates already written in the ON clause so they can be
 * excluded from the suggestions (avoids duplicates).
 */
function extractUsedOnPredicates(statementText: string, cursorOffset: number): Set<string> {
  const beforeCursor = statementText.slice(0, cursorOffset);
  const lower = beforeCursor.toLowerCase();

  // Find the last ON keyword before cursor at approx top level
  let lastOnPos = -1;
  let pos = 0;
  while (pos < lower.length) {
    const idx = lower.indexOf('\bon\b'.replace(/\\b/g, ''), pos);
    // Simpler: just find ' on ' occurrences
    const m = /\bon\b/g;
    m.lastIndex = pos;
    const match = m.exec(lower);
    if (!match) break;
    lastOnPos = match.index;
    pos = match.index + 2;
  }

  if (lastOnPos === -1) return new Set();

  const onTail = beforeCursor.slice(lastOnPos + 2);
  const stopMatch = /\b(where|group\s+by|order\s+by|having|union)\b/i.exec(onTail);
  const predicateText = stopMatch ? onTail.slice(0, stopMatch.index) : onTail;

  const chunks = predicateText
    .split(/\bAND\b|\bOR\b/gi)
    .map((x) => x.trim().replace(/\s+/g, ' ').toLowerCase())
    .filter(Boolean);

  return new Set(chunks);
}

// ── Helpers: replace range computation ───────────────────────────────────────

/**
 * Computes the Range to replace when a table/column completion is accepted.
 * Goes backwards over word characters (\w) from the cursor.
 */
function replaceRangeWordOnly(lineText: string, position: Position): Range {
  const end = position.character;
  let start = end;
  while (start > 0 && /\w/.test(lineText[start - 1])) start--;
  return Range.create(position.line, start, position.line, end);
}

/** Regex: `FROM schema.` or `JOIN schema.` — schema-qualified table context. */
const SCHEMA_DOT_PATTERN =
  /\b(?:FROM|JOIN|INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|CROSS\s+JOIN|LEFT\s+OUTER\s+JOIN|RIGHT\s+OUTER\s+JOIN|FULL\s+JOIN|FULL\s+OUTER\s+JOIN|APPLY|OUTER\s+APPLY|CROSS\s+APPLY)\s+(\w+)\.\s*\w*$/i;
