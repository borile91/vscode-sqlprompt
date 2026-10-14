/**
 * Funzioni di sistema T-SQL (MIN, MAX, ISNULL, DATEADD…): catalogo per il
 * completamento e per il signature help.
 *
 * Tutto puro (nessuna dipendenza da LSP), per poterlo testare da solo.
 */

export type BuiltinCategory =
  | 'aggregate'
  | 'window'
  | 'string'
  | 'date'
  | 'conversion'
  | 'logical'
  | 'math'
  | 'system';

export interface BuiltinParameter {
  name: string;
  optional?: boolean;
}

export interface BuiltinFunction {
  name: string;
  category: BuiltinCategory;
  params: BuiltinParameter[];
  description: string;
  /** Testo inserito in formato snippet, se diverso da `NOME(${1:p1}, …)`. */
  snippet?: string;
  /** Firma mostrata, se diversa da `NOME(p1, p2)` (es. `CAST(expression AS data_type)`). */
  signature?: string;
  /** Il primo argomento è una datepart (`year`, `month`…). */
  datepartFirst?: boolean;
}

const p = (name: string, optional = false): BuiltinParameter => ({ name, optional });

export const BUILTIN_FUNCTIONS: readonly BuiltinFunction[] = [
  // ── Aggregate ──────────────────────────────────────────────────────────────
  { name: 'COUNT', category: 'aggregate', params: [p('expression')], description: 'Number of rows, or of non-NULL values of the expression.', snippet: 'COUNT(${1:*})' },
  { name: 'COUNT_BIG', category: 'aggregate', params: [p('expression')], description: 'Like COUNT, returning bigint.', snippet: 'COUNT_BIG(${1:*})' },
  { name: 'SUM', category: 'aggregate', params: [p('expression')], description: 'Sum of the non-NULL values.' },
  { name: 'AVG', category: 'aggregate', params: [p('expression')], description: 'Average of the non-NULL values.' },
  { name: 'MIN', category: 'aggregate', params: [p('expression')], description: 'Smallest value.' },
  { name: 'MAX', category: 'aggregate', params: [p('expression')], description: 'Largest value.' },
  { name: 'STRING_AGG', category: 'aggregate', params: [p('expression'), p('separator')], description: "Concatenates the values with a separator (add WITHIN GROUP (ORDER BY …) to sort them).", snippet: "STRING_AGG(${1:expression}, ${2:', '})" },
  { name: 'STDEV', category: 'aggregate', params: [p('expression')], description: 'Statistical standard deviation.' },
  { name: 'VAR', category: 'aggregate', params: [p('expression')], description: 'Statistical variance.' },

  // ── Window / ranking ───────────────────────────────────────────────────────
  { name: 'ROW_NUMBER', category: 'window', params: [], signature: 'ROW_NUMBER() OVER ([PARTITION BY …] ORDER BY …)', description: 'Sequential number of the row within its partition.', snippet: 'ROW_NUMBER() OVER (ORDER BY ${1:column})' },
  { name: 'RANK', category: 'window', params: [], signature: 'RANK() OVER ([PARTITION BY …] ORDER BY …)', description: 'Rank of the row, with gaps after ties.', snippet: 'RANK() OVER (ORDER BY ${1:column})' },
  { name: 'DENSE_RANK', category: 'window', params: [], signature: 'DENSE_RANK() OVER ([PARTITION BY …] ORDER BY …)', description: 'Rank of the row, without gaps after ties.', snippet: 'DENSE_RANK() OVER (ORDER BY ${1:column})' },
  { name: 'NTILE', category: 'window', params: [p('groups')], signature: 'NTILE(groups) OVER ([PARTITION BY …] ORDER BY …)', description: 'Distributes the rows into the given number of groups.', snippet: 'NTILE(${1:4}) OVER (ORDER BY ${2:column})' },
  { name: 'LAG', category: 'window', params: [p('expression'), p('offset', true), p('default', true)], description: 'Value from a previous row of the partition (add OVER (ORDER BY …)).', snippet: 'LAG(${1:expression}) OVER (ORDER BY ${2:column})' },
  { name: 'LEAD', category: 'window', params: [p('expression'), p('offset', true), p('default', true)], description: 'Value from a following row of the partition (add OVER (ORDER BY …)).', snippet: 'LEAD(${1:expression}) OVER (ORDER BY ${2:column})' },
  { name: 'FIRST_VALUE', category: 'window', params: [p('expression')], description: 'First value of the ordered window.', snippet: 'FIRST_VALUE(${1:expression}) OVER (ORDER BY ${2:column})' },
  { name: 'LAST_VALUE', category: 'window', params: [p('expression')], description: 'Last value of the ordered window.', snippet: 'LAST_VALUE(${1:expression}) OVER (ORDER BY ${2:column})' },

  // ── NULL handling and logical ──────────────────────────────────────────────
  { name: 'ISNULL', category: 'logical', params: [p('check_expression'), p('replacement_value')], description: 'Replaces NULL with the given value (type of the first argument).' },
  { name: 'COALESCE', category: 'logical', params: [p('expression1'), p('expression2'), p('…', true)], description: 'First non-NULL argument.', snippet: 'COALESCE(${1:expression1}, ${2:expression2})' },
  { name: 'NULLIF', category: 'logical', params: [p('expression1'), p('expression2')], description: 'NULL when the two arguments are equal, otherwise the first.' },
  { name: 'IIF', category: 'logical', params: [p('condition'), p('true_value'), p('false_value')], description: 'One of two values, depending on the condition.' },
  { name: 'CHOOSE', category: 'logical', params: [p('index'), p('value1'), p('value2'), p('…', true)], description: 'The value at the given 1-based index.', snippet: 'CHOOSE(${1:index}, ${2:value1}, ${3:value2})' },

  // ── Conversion ─────────────────────────────────────────────────────────────
  { name: 'CAST', category: 'conversion', params: [p('expression'), p('data_type')], signature: 'CAST(expression AS data_type)', description: 'Converts the expression to the data type.', snippet: 'CAST(${1:expression} AS ${2:varchar(50)})' },
  { name: 'TRY_CAST', category: 'conversion', params: [p('expression'), p('data_type')], signature: 'TRY_CAST(expression AS data_type)', description: 'Like CAST, NULL when the conversion fails.', snippet: 'TRY_CAST(${1:expression} AS ${2:int})' },
  { name: 'CONVERT', category: 'conversion', params: [p('data_type'), p('expression'), p('style', true)], description: 'Converts the expression to the data type, with an optional style (e.g. 103 = dd/mm/yyyy).', snippet: 'CONVERT(${1:varchar(10)}, ${2:expression}, ${3:103})' },
  { name: 'TRY_CONVERT', category: 'conversion', params: [p('data_type'), p('expression'), p('style', true)], description: 'Like CONVERT, NULL when the conversion fails.', snippet: 'TRY_CONVERT(${1:int}, ${2:expression})' },
  { name: 'FORMAT', category: 'conversion', params: [p('value'), p('format'), p('culture', true)], description: ".NET format string, e.g. FORMAT(date, 'dd/MM/yyyy').", snippet: "FORMAT(${1:value}, ${2:'dd/MM/yyyy'})" },

  // ── String ─────────────────────────────────────────────────────────────────
  { name: 'LEN', category: 'string', params: [p('string')], description: 'Number of characters, trailing spaces excluded.' },
  { name: 'DATALENGTH', category: 'string', params: [p('expression')], description: 'Number of bytes.' },
  { name: 'LEFT', category: 'string', params: [p('string'), p('length')], description: 'The first characters of the string.' },
  { name: 'RIGHT', category: 'string', params: [p('string'), p('length')], description: 'The last characters of the string.' },
  { name: 'SUBSTRING', category: 'string', params: [p('string'), p('start'), p('length')], description: 'Part of the string, from a 1-based start position.' },
  { name: 'CHARINDEX', category: 'string', params: [p('search'), p('string'), p('start', true)], description: '1-based position of the search string, 0 when not found.' },
  { name: 'PATINDEX', category: 'string', params: [p('pattern'), p('string')], description: "1-based position of a LIKE pattern, e.g. '%[0-9]%'." },
  { name: 'REPLACE', category: 'string', params: [p('string'), p('search'), p('replacement')], description: 'Replaces every occurrence of the search string.' },
  { name: 'STUFF', category: 'string', params: [p('string'), p('start'), p('length'), p('replacement')], description: 'Deletes length characters from start and inserts the replacement.' },
  { name: 'TRIM', category: 'string', params: [p('string')], description: 'Removes leading and trailing spaces.' },
  { name: 'LTRIM', category: 'string', params: [p('string')], description: 'Removes leading spaces.' },
  { name: 'RTRIM', category: 'string', params: [p('string')], description: 'Removes trailing spaces.' },
  { name: 'UPPER', category: 'string', params: [p('string')], description: 'Upper case.' },
  { name: 'LOWER', category: 'string', params: [p('string')], description: 'Lower case.' },
  { name: 'CONCAT', category: 'string', params: [p('value1'), p('value2'), p('…', true)], description: 'Concatenates the values, treating NULL as an empty string.', snippet: 'CONCAT(${1:value1}, ${2:value2})' },
  { name: 'CONCAT_WS', category: 'string', params: [p('separator'), p('value1'), p('value2'), p('…', true)], description: 'Concatenates the non-NULL values with a separator.', snippet: "CONCAT_WS(${1:' '}, ${2:value1}, ${3:value2})" },
  { name: 'REPLICATE', category: 'string', params: [p('string'), p('count')], description: 'Repeats the string.' },
  { name: 'REVERSE', category: 'string', params: [p('string')], description: 'The string backwards.' },
  { name: 'SPACE', category: 'string', params: [p('count')], description: 'A string of spaces.' },
  { name: 'QUOTENAME', category: 'string', params: [p('name'), p('quote_char', true)], description: 'Delimits a name with [] (or the given character).' },

  // ── Date and time ──────────────────────────────────────────────────────────
  { name: 'GETDATE', category: 'date', params: [], description: 'Current date and time (datetime).' },
  { name: 'GETUTCDATE', category: 'date', params: [], description: 'Current UTC date and time (datetime).' },
  { name: 'SYSDATETIME', category: 'date', params: [], description: 'Current date and time (datetime2, higher precision).' },
  { name: 'SYSUTCDATETIME', category: 'date', params: [], description: 'Current UTC date and time (datetime2).' },
  { name: 'DATEADD', category: 'date', params: [p('datepart'), p('number'), p('date')], description: 'Adds a number of dateparts to a date.', datepartFirst: true, snippet: 'DATEADD(${1:day}, ${2:1}, ${3:date})' },
  { name: 'DATEDIFF', category: 'date', params: [p('datepart'), p('startdate'), p('enddate')], description: 'Number of datepart boundaries between two dates.', datepartFirst: true, snippet: 'DATEDIFF(${1:day}, ${2:startdate}, ${3:enddate})' },
  { name: 'DATEDIFF_BIG', category: 'date', params: [p('datepart'), p('startdate'), p('enddate')], description: 'Like DATEDIFF, returning bigint.', datepartFirst: true, snippet: 'DATEDIFF_BIG(${1:second}, ${2:startdate}, ${3:enddate})' },
  { name: 'DATEPART', category: 'date', params: [p('datepart'), p('date')], description: 'A datepart of the date, as an integer.', datepartFirst: true, snippet: 'DATEPART(${1:year}, ${2:date})' },
  { name: 'DATENAME', category: 'date', params: [p('datepart'), p('date')], description: 'A datepart of the date, as text.', datepartFirst: true, snippet: 'DATENAME(${1:month}, ${2:date})' },
  { name: 'YEAR', category: 'date', params: [p('date')], description: 'Year of the date.' },
  { name: 'MONTH', category: 'date', params: [p('date')], description: 'Month of the date.' },
  { name: 'DAY', category: 'date', params: [p('date')], description: 'Day of the month.' },
  { name: 'EOMONTH', category: 'date', params: [p('date'), p('months_to_add', true)], description: 'Last day of the month.' },
  { name: 'DATEFROMPARTS', category: 'date', params: [p('year'), p('month'), p('day')], description: 'A date from its parts.' },
  { name: 'ISDATE', category: 'date', params: [p('expression')], description: '1 when the expression is a valid date.' },

  // ── Math ───────────────────────────────────────────────────────────────────
  { name: 'ABS', category: 'math', params: [p('number')], description: 'Absolute value.' },
  { name: 'ROUND', category: 'math', params: [p('number'), p('length'), p('function', true)], description: 'Rounds to the given number of decimals.', snippet: 'ROUND(${1:number}, ${2:2})' },
  { name: 'CEILING', category: 'math', params: [p('number')], description: 'Smallest integer greater than or equal to the number.' },
  { name: 'FLOOR', category: 'math', params: [p('number')], description: 'Largest integer less than or equal to the number.' },
  { name: 'POWER', category: 'math', params: [p('number'), p('exponent')], description: 'Number raised to the exponent.' },
  { name: 'SQRT', category: 'math', params: [p('number')], description: 'Square root.' },
  { name: 'SIGN', category: 'math', params: [p('number')], description: '-1, 0 or 1.' },

  // ── System ─────────────────────────────────────────────────────────────────
  { name: 'NEWID', category: 'system', params: [], description: 'A new uniqueidentifier.' },
  { name: 'SCOPE_IDENTITY', category: 'system', params: [], description: 'Last identity value inserted in the current scope.' },
  { name: 'ISNUMERIC', category: 'system', params: [p('expression')], description: '1 when the expression is a valid number.' },
  { name: 'OBJECT_ID', category: 'system', params: [p('object_name'), p('object_type', true)], description: "Object id, e.g. OBJECT_ID('dbo.Orders', 'U').", snippet: "OBJECT_ID(${1:'dbo.Table'})" },
  { name: 'DB_NAME', category: 'system', params: [p('database_id', true)], description: 'Name of the current (or given) database.', snippet: 'DB_NAME()' },
  { name: 'SUSER_SNAME', category: 'system', params: [], description: 'Login name of the current user.' },
];

/** Tipi di dato proposti in `CAST(x AS `, `CONVERT(`, `TRY_CAST`, `TRY_CONVERT`. */
export const DATA_TYPES = [
  'int', 'bigint', 'smallint', 'tinyint', 'bit', 'decimal(18, 2)', 'numeric(18, 2)', 'money',
  'float', 'real', 'date', 'datetime', 'datetime2', 'time', 'char(10)', 'varchar(50)',
  'varchar(max)', 'nchar(10)', 'nvarchar(50)', 'nvarchar(max)', 'uniqueidentifier',
  'varbinary(max)', 'xml',
];

/** Dateparts accettate da DATEADD, DATEDIFF, DATEPART, DATENAME. */
export const DATEPARTS = [
  'year', 'quarter', 'month', 'dayofyear', 'day', 'week', 'weekday',
  'hour', 'minute', 'second', 'millisecond', 'microsecond', 'nanosecond',
];

const BY_NAME = new Map(BUILTIN_FUNCTIONS.map((fn) => [fn.name, fn]));

/** Funzione di sistema per nome, senza distinzione di maiuscole. */
export function findBuiltin(name: string | undefined): BuiltinFunction | undefined {
  return name ? BY_NAME.get(name.toUpperCase()) : undefined;
}

/** Testo inserito: lo snippet dedicato, oppure `NOME(${1:p1}, …)` senza i parametri facoltativi. */
export function builtinSnippet(fn: BuiltinFunction): string {
  if (fn.snippet) return fn.snippet;
  const required = fn.params.filter((param) => !param.optional);
  const args = required.map((param, i) => `\${${i + 1}:${param.name}}`).join(', ');
  return `${fn.name}(${args})`;
}

/** Firma leggibile: `DATEADD(datepart, number, date)`, con i facoltativi tra []. */
export function builtinSignature(fn: BuiltinFunction): string {
  if (fn.signature) return fn.signature;
  return `${fn.name}(${fn.params.map((param) => (param.optional ? `[${param.name}]` : param.name)).join(', ')})`;
}

/**
 * Funzioni sensate nella clausola: le aggregate non valgono in WHERE/ON/SET/
 * VALUES/GROUP BY, quelle di finestra solo in SELECT e ORDER BY.
 * `functionArgs` sono gli argomenti di un'altra funzione (`ISNULL(MAX(x), 0)`).
 */
export function builtinsForClause(clause: string): BuiltinFunction[] {
  // `functionArgs`: argomenti di una funzione, la clausola esterna non è nota.
  const aggregatesAllowed = ['select', 'having', 'orderBy', 'functionArgs'].includes(clause);
  const windowAllowed = clause === 'select' || clause === 'orderBy';
  return BUILTIN_FUNCTIONS.filter(
    (fn) =>
      (fn.category !== 'aggregate' || aggregatesAllowed) &&
      (fn.category !== 'window' || windowAllowed),
  );
}
