/**
 * Schema delle opzioni di uno stile di formattazione SQL Prompt (formato JSON "portable"):
 * sezioni, etichette, valori ammessi e default. I default sono quelli di SQL Prompt:
 * un file di stile contiene solo le chiavi diverse dal default.
 *
 * Modulo puro (nessuna dipendenza da vscode): usato dall'editor degli stili e dai test.
 */

export type OptionValue = boolean | number | string;

export interface EnumChoice {
    value: string;
    label: string;
}

interface OptionBase {
    /** Percorso nel JSON, es. "lists.placeCommasBeforeItems". */
    key: string;
    label: string;
    /** Opzione attiva solo se un'altra opzione booleana è vera. */
    enabledWhen?: string;
}

export interface BoolOption extends OptionBase { type: 'bool'; default: boolean }
export interface IntOption extends OptionBase { type: 'int'; default: number; min: number; max: number }
export interface EnumOption extends OptionBase { type: 'enum'; default: string; choices: EnumChoice[] }
export type StyleOption = BoolOption | IntOption | EnumOption;

export interface StyleGroup {
    title: string;
    options: StyleOption[];
}

export interface StyleSection {
    id: string;
    title: string;
    groups: StyleGroup[];
    /** SQL di esempio per l'anteprima della sezione (nomi inventati). */
    preview: string;
}

const bool = (key: string, label: string, def: boolean, enabledWhen?: string): BoolOption =>
    ({ type: 'bool', key, label, default: def, enabledWhen });
const int = (key: string, label: string, def: number, enabledWhen?: string, min = 0, max = 1000): IntOption =>
    ({ type: 'int', key, label, default: def, min, max, enabledWhen });
const choice = (key: string, label: string, def: string, choices: [string, string][], enabledWhen?: string): EnumOption =>
    ({ type: 'enum', key, label, default: def, choices: choices.map(([value, l]) => ({ value, label: l })), enabledWhen });

const PARENTHESIS_STYLES: [string, string][] = [
    ['compactSimple', 'Compact (simple)'],
    ['compactToStatement', 'Compact, aligned to statement'],
    ['compactIndented', 'Compact, indented'],
    ['compactRightAligned', 'Compact, right aligned'],
    ['expandedSimple', 'Expanded (simple)'],
    ['expandedToStatement', 'Expanded, aligned to statement'],
    ['expandedIndented', 'Expanded, indented'],
    ['expandedRightAligned', 'Expanded, right aligned'],
    ['expandedSplit', 'Expanded, split'],
];
const CASING: [string, string][] = [
    ['leaveAsIs', 'Leave as is'],
    ['uppercase', 'UPPERCASE'],
    ['lowercase', 'lowercase'],
    ['upperCamelCase', 'UpperCamelCase'],
    ['lowerCamelCase', 'lowerCamelCase'],
];
const ALWAYS_NEVER_LONG: [string, string][] = [
    ['always', 'Always'],
    ['never', 'Never'],
    ['ifLongerThanMaxLineLength', 'If longer than the maximum line length'],
];
const ALIGN_LEFT_INDENT_RIGHT: [string, string][] = [
    ['leftAligned', 'Left aligned'],
    ['indented', 'Indented'],
    ['rightAligned', 'Right aligned'],
];

const SAMPLE_QUERY = `select l.ID_LIBRO, l.TITOLO as Titolo, a.NOME as Autore, count(p.ID_PRESTITO) as Prestiti, max(p.DATA_PRESTITO) as Ultimo
from bib.LIBRI as l inner join bib.AUTORI as a on a.ID_AUTORE = l.ID_AUTORE and a.ATTIVO = 1
left join bib.PRESTITI as p on p.ID_LIBRO = l.ID_LIBRO
where l.ATTIVO = 1 and (l.ANNO > 2000 or l.COLLANA = 'Classici') and l.ID_SEDE in (select s.ID_SEDE from bib.SEDI as s where s.APERTA = 1)
group by l.ID_LIBRO, l.TITOLO, a.NOME
order by Prestiti desc;`;

export const STYLE_SECTIONS: StyleSection[] = [
    {
        id: 'whitespace',
        title: 'Whitespace',
        groups: [
            {
                title: 'Indentation',
                options: [
                    choice('whitespace.spacesOrTabs', 'Indent with', 'spaces', [
                        ['spaces', 'Spaces only'], ['tabs', 'Tabs only'], ['tabsIfPossible', 'Tabs where possible'],
                    ]),
                    int('whitespace.numberOfSpacesInTabs', 'Spaces per tab', 4, undefined, 1, 16),
                ],
            },
            {
                title: 'Line length',
                options: [
                    bool('whitespace.wrapLongLines', 'Wrap long lines', true),
                    int('whitespace.wrapLinesLongerThan', 'Wrap lines longer than', 120, 'whitespace.wrapLongLines', 40, 1000),
                ],
            },
            {
                title: 'Empty lines',
                options: [
                    bool('whitespace.newLines.preserveExistingEmptyLinesBetweenStatements', 'Preserve existing empty lines between statements', true),
                    int('whitespace.newLines.emptyLinesBetweenStatements', 'Empty lines between statements', 1, undefined, 0, 10),
                    bool('whitespace.newLines.preserveExistingEmptyLinesAfterBatchSeparator', 'Preserve existing empty lines after GO', true),
                    int('whitespace.newLines.emptyLinesAfterBatchSeparator', 'Empty lines after GO', 1, undefined, 0, 10),
                ],
            },
            {
                title: 'Other',
                options: [
                    choice('whitespace.whiteSpaceBeforeSemiColon', 'Before semicolons', 'none', [
                        ['none', 'Nothing'], ['spaceBefore', 'A space'], ['newLineBefore', 'A new line'],
                    ]),
                    bool('whitespace.newLines.alignGroupOfSingleLineComments', 'Align groups of single-line comments', true),
                    bool('whitespace.newLines.alignMultilineCommentsMatchingPatterns', 'Align multi-line comments matching patterns', true),
                ],
            },
        ],
        preview: `declare @sede varchar(3) = 'MI1'; declare @anno int = 2024;
select l.TITOLO from bib.LIBRI as l where l.ANNO = @anno;
go
update bib.LIBRI set ATTIVO = 0 where ANNO < 1950;`,
    },
    {
        id: 'lists',
        title: 'Lists',
        groups: [
            {
                title: 'Placement',
                options: [
                    choice('lists.placeFirstItemOnNewLine', 'Place first item on a new line', 'never', [
                        ['always', 'Always'], ['never', 'Never'], ['ifSubsequentItems', 'If there are subsequent items'],
                    ]),
                    choice('lists.placeSubsequentItemsOnNewLines', 'Place subsequent items on new lines', 'always', ALWAYS_NEVER_LONG),
                    bool('lists.indentListItems', 'Indent list items', true),
                ],
            },
            {
                title: 'Alignment',
                options: [
                    bool('lists.alignSubsequentItemsWithFirstItem', 'Align subsequent items with the first item', true),
                    bool('lists.alignItemsAcrossClauses', 'Align items across clauses', true),
                    bool('lists.alignItemsToTabStops', 'Align items to tab stops', false),
                    bool('lists.alignAliases', 'Align aliases', false),
                    bool('lists.alignComments', 'Align end-of-line comments', false),
                ],
            },
            {
                title: 'Commas',
                options: [
                    bool('lists.placeCommasBeforeItems', 'Place commas before items', false),
                    choice('lists.commaAlignment', 'Comma alignment', 'beforeItem', [
                        ['beforeItem', 'Before the item'], ['toList', 'To the list'], ['toStatement', 'To the statement'],
                    ], 'lists.placeCommasBeforeItems'),
                    bool('lists.addSpaceBeforeComma', 'Add a space before commas', false),
                    bool('lists.addSpaceAfterComma', 'Add a space after commas', true),
                ],
            },
        ],
        preview: SAMPLE_QUERY,
    },
    {
        id: 'parentheses',
        title: 'Parentheses',
        groups: [
            {
                title: 'Layout',
                options: [
                    choice('parentheses.parenthesisStyle', 'Parenthesis style', 'compactSimple', PARENTHESIS_STYLES),
                    bool('parentheses.indentParenthesesContents', 'Indent contents', false),
                    bool('parentheses.collapseShortParenthesisContents', 'Collapse short contents', false),
                    int('parentheses.collapseParenthesesShorterThan', 'Collapse if shorter than', 80, 'parentheses.collapseShortParenthesisContents'),
                ],
            },
            {
                title: 'Spaces',
                options: [
                    bool('parentheses.addSpacesAroundParentheses', 'Add spaces around parentheses', true),
                    bool('parentheses.addSpacesInsideParentheses', 'Add spaces inside parentheses', false),
                ],
            },
        ],
        preview: `select l.TITOLO from bib.LIBRI as l
where (l.ANNO > 2000 and (l.COLLANA = 'Classici' or l.COLLANA is null))
and exists (select 1 from bib.PRESTITI as p where p.ID_LIBRO = l.ID_LIBRO and p.STATO is null);`,
    },
    {
        id: 'casing',
        title: 'Casing',
        groups: [
            {
                title: 'Case',
                options: [
                    choice('casing.reservedKeywords', 'Reserved keywords', 'leaveAsIs', CASING),
                    choice('casing.builtInFunctions', 'Built-in functions', 'leaveAsIs', CASING),
                    choice('casing.builtInDataTypes', 'Built-in data types', 'leaveAsIs', CASING),
                    choice('casing.globalVariables', 'Global variables', 'leaveAsIs', CASING),
                    bool('casing.useObjectDefinitionCase', 'Use the case of the object definition', false),
                ],
            },
        ],
        preview: `declare @Totale int = 0;
Select @totale = Count(*) From bib.LIBRI As L Where L.ATTIVO = 1 And Getdate() > L.DATA_ARRIVO;
print @@rowcount;`,
    },
    {
        id: 'dml',
        title: 'Data (DML)',
        groups: [
            {
                title: 'Clauses',
                options: [
                    choice('dml.clauses.clauseAlignment', 'Clause alignment', 'leftAligned', [
                        ['leftAligned', 'Left aligned'], ['rightAligned', 'Right aligned'], ['toFirstListItem', 'To the first list item'],
                    ]),
                    int('dml.clauses.clauseIndentation', 'Clause indentation', 0, undefined, 0, 40),
                    bool('dml.placeDistinctAndTopClausesOnNewLine', 'Place DISTINCT and TOP on a new line', false),
                    bool('dml.addNewLineAfterDistinctAndTopClauses', 'New line after DISTINCT and TOP', false),
                    bool('dml.placeInsertTableOnNewLine', 'Place the INSERT table on a new line', false),
                ],
            },
            {
                title: 'Clause items',
                options: [
                    choice('dml.listItems.placeFromTableOnNewLine', 'FROM table on a new line', 'never', [
                        ['always', 'Always'], ['never', 'Never'], ['ifMultiple', 'If there are several'],
                    ]),
                    choice('dml.listItems.placeWhereConditionOnNewLine', 'WHERE condition on a new line', 'never', [
                        ['always', 'Always'], ['never', 'Never'], ['ifMultiple', 'If there are several'],
                    ]),
                    choice('dml.listItems.placeGroupByAndOrderByOnNewLine', 'GROUP BY / ORDER BY items on a new line', 'never', [
                        ['always', 'Always'], ['never', 'Never'], ['ifMultiple', 'If there are several'],
                    ]),
                ],
            },
            {
                title: 'Collapsing',
                options: [
                    bool('dml.collapseShortStatements', 'Collapse short statements', false),
                    int('dml.collapseStatementsShorterThan', 'Collapse statements shorter than', 80, 'dml.collapseShortStatements'),
                    bool('dml.collapseShortSubqueries', 'Collapse short subqueries', false),
                    int('dml.collapseSubqueriesShorterThan', 'Collapse subqueries shorter than', 80, 'dml.collapseShortSubqueries'),
                ],
            },
        ],
        preview: `select top (10) l.TITOLO, l.ANNO from bib.LIBRI as l where l.ATTIVO = 1 order by l.ANNO desc;
select distinct a.NOME from bib.AUTORI as a;
update p set p.STATO = 'C' from bib.PRESTITI as p where p.DATA_RESTITUZIONE is not null;
delete from bib.PRENOTAZIONI where SCADENZA < getdate();`,
    },
    {
        id: 'ddl',
        title: 'Definitions (DDL)',
        groups: [
            {
                title: 'Parentheses',
                options: [
                    choice('ddl.parenthesisStyle', 'Parenthesis style', 'compactSimple', PARENTHESIS_STYLES),
                    bool('ddl.indentParenthesesContents', 'Indent contents', false),
                ],
            },
            {
                title: 'Columns and constraints',
                options: [
                    bool('ddl.alignDataTypesAndConstraints', 'Align data types and constraints', false),
                    bool('ddl.placeConstraintsOnNewLines', 'Place constraints on new lines', false),
                    choice('ddl.placeConstraintColumnsOnNewLines', 'Constraint columns on new lines', 'ifLongerThanMaxLineLength', [
                        ['always', 'Always'], ['ifLongerThanMaxLineLength', 'If longer than the maximum line length'],
                        ['ifLongerOrMultipleColumns', 'If longer or several columns'],
                    ]),
                ],
            },
            {
                title: 'Procedures and functions',
                options: [
                    bool('ddl.indentClauses', 'Indent the body', false),
                    choice('ddl.placeFirstProcedureParameterOnNewLine', 'First parameter on a new line', 'ifMultipleItems', [
                        ['always', 'Always'], ['never', 'Never'], ['ifMultipleItems', 'If there are several'],
                    ]),
                    bool('ddl.collapseShortStatements', 'Collapse short statements', false),
                    int('ddl.collapseStatementsShorterThan', 'Collapse statements shorter than', 80, 'ddl.collapseShortStatements'),
                ],
            },
        ],
        preview: `create table bib.PRESTITI (ID_PRESTITO int identity(1, 1) not null, ID_LIBRO int not null, DATA_PRESTITO datetime constraint DF_PRESTITI_DATA default (getdate()) not null,
constraint PK_PRESTITI primary key clustered (ID_PRESTITO asc), constraint FK_PRESTITI_LIBRI foreign key (ID_LIBRO) references bib.LIBRI (ID_LIBRO));
go
create procedure bib.spPrestitiSocio @idSocio int, @soloAperti bit = 1 as
begin
select p.ID_PRESTITO from bib.PRESTITI as p where p.ID_SOCIO = @idSocio;
end;`,
    },
    {
        id: 'controlFlow',
        title: 'Control flow',
        groups: [
            {
                title: 'BEGIN … END',
                options: [
                    bool('controlFlow.placeBeginAndEndOnNewLine', 'Place BEGIN and END on new lines', true),
                    bool('controlFlow.indentBeginAndEndKeywords', 'Indent BEGIN and END', false),
                    bool('controlFlow.indentContentsOfStatements', 'Indent the contents of IF and WHILE', true),
                ],
            },
            {
                title: 'Collapsing',
                options: [
                    bool('controlFlow.collapseShortStatements', 'Collapse short statements', false),
                    int('controlFlow.collapseStatementsShorterThan', 'Collapse statements shorter than', 80, 'controlFlow.collapseShortStatements'),
                ],
            },
        ],
        preview: `if @conta > 0 begin set @messaggio = 'presenti'; print @messaggio; end else set @messaggio = 'nessuno';
while @i < 10 begin set @i = @i + 1; end;
begin try exec bib.spPulizia; end try begin catch print error_message(); end catch;`,
    },
    {
        id: 'cte',
        title: 'CTE',
        groups: [
            {
                title: 'Common table expressions',
                options: [
                    choice('cte.parenthesisStyle', 'Parenthesis style', 'compactSimple', PARENTHESIS_STYLES),
                    bool('cte.indentContents', 'Indent contents', false),
                    bool('cte.placeNameOnNewLine', 'Place the name on a new line', false),
                    bool('cte.indentName', 'Indent the name', false),
                    bool('cte.placeColumnsOnNewLine', 'Place columns on a new line', false),
                    choice('cte.columnAlignment', 'Column alignment', 'leftAligned', ALIGN_LEFT_INDENT_RIGHT),
                    bool('cte.placeAsOnNewLine', 'Place AS on a new line', true),
                    choice('cte.asAlignment', 'AS alignment', 'leftAligned', ALIGN_LEFT_INDENT_RIGHT),
                ],
            },
        ],
        preview: `with prestitiRecenti (ID_LIBRO, CONTA) as (select p.ID_LIBRO, count(*) from bib.PRESTITI as p where p.DATA_PRESTITO > '20240101' group by p.ID_LIBRO)
select l.TITOLO, pr.CONTA from bib.LIBRI as l inner join prestitiRecenti as pr on pr.ID_LIBRO = l.ID_LIBRO;`,
    },
    {
        id: 'variables',
        title: 'Variables',
        groups: [
            {
                title: 'DECLARE and SET',
                options: [
                    bool('variables.alignDataTypesAndValues', 'Align data types and values', true),
                    bool('variables.addSpaceBetweenDataTypeAndPrecision', 'Space between data type and precision', false),
                    bool('variables.placeAssignedValueOnNewLineIfLongerThanMaxLineLength', 'Assigned value on a new line if too long', true),
                    bool('variables.placeEqualsSignOnNewLine', 'Place the equals sign on a new line', false),
                ],
            },
        ],
        preview: `declare @sede varchar(3) = 'MI1', @dataRif datetime, @soglia numeric(12, 3) = 10.5, @attivo bit = 1;
set @dataRif = isnull(@dataRif, getdate());`,
    },
    {
        id: 'joins',
        title: 'Joins',
        groups: [
            {
                title: 'JOIN',
                options: [
                    bool('joinStatements.join.placeOnNewLine', 'Place JOIN on a new line', true),
                    choice('joinStatements.join.keywordAlignment', 'JOIN alignment', 'toFrom', [
                        ['toFrom', 'To FROM'], ['rightAlignedToFrom', 'Right aligned to FROM'], ['toTable', 'To the table'], ['indented', 'Indented'],
                    ]),
                    bool('joinStatements.join.insertEmptyLineBetweenJoinClauses', 'Empty line between JOIN clauses', false),
                    bool('joinStatements.join.placeJoinTableOnNewLine', 'Place the joined table on a new line', false),
                    bool('joinStatements.join.indentJoinTable', 'Indent the joined table', true),
                ],
            },
            {
                title: 'ON',
                options: [
                    bool('joinStatements.on.placeOnNewLine', 'Place ON on a new line', true),
                    choice('joinStatements.on.keywordAlignment', 'ON alignment', 'toJoin', [
                        ['toJoin', 'To JOIN'], ['rightAlignedToJoin', 'Right aligned to JOIN'], ['rightAlignedToInner', 'Right aligned to INNER'],
                        ['toTable', 'To the table'], ['indented', 'Indented'],
                    ]),
                    bool('joinStatements.on.placeConditionOnNewLine', 'Place the condition on a new line', false),
                    choice('joinStatements.on.conditionAlignment', 'Condition alignment', 'toOnKeyword', [
                        ['toOnKeyword', 'To ON'], ['toInner', 'To INNER'], ['toTable', 'To the table'], ['indented', 'Indented'],
                    ]),
                ],
            },
        ],
        preview: SAMPLE_QUERY,
    },
    {
        id: 'insert',
        title: 'INSERT',
        groups: [
            {
                title: 'Columns',
                options: [
                    choice('insertStatements.columns.parenthesisStyle', 'Parenthesis style', 'expandedToStatement', PARENTHESIS_STYLES),
                    bool('insertStatements.columns.indentContents', 'Indent contents', true),
                    choice('insertStatements.columns.placeSubsequentColumnsOnNewLines', 'Subsequent columns on new lines', 'always', ALWAYS_NEVER_LONG),
                ],
            },
            {
                title: 'Values',
                options: [
                    choice('insertStatements.values.parenthesisStyle', 'Parenthesis style', 'compactToStatement', PARENTHESIS_STYLES),
                    bool('insertStatements.values.indentContents', 'Indent contents', false),
                    choice('insertStatements.values.placeSubsequentValuesOnNewLines', 'Subsequent values on new lines', 'never', ALWAYS_NEVER_LONG),
                ],
            },
        ],
        preview: `insert into bib.LIBRI (TITOLO, ANNO, ID_AUTORE, ATTIVO) values ('Il nome della rosa', 1980, 12, 1), ('Il pendolo di Foucault', 1988, 12, 1);
insert into bib.STORICO (ID_LIBRO, DATA) select l.ID_LIBRO, getdate() from bib.LIBRI as l where l.ATTIVO = 0;`,
    },
    {
        id: 'functions',
        title: 'Function calls',
        groups: [
            {
                title: 'Arguments',
                options: [
                    choice('functionCalls.placeArgumentsOnNewLines', 'Place arguments on new lines', 'ifLongerThanMaxLineLength', ALWAYS_NEVER_LONG),
                    bool('functionCalls.addSpacesAroundParentheses', 'Spaces around parentheses', false),
                    bool('functionCalls.addSpacesAroundArgumentList', 'Spaces around the argument list', false),
                    bool('functionCalls.addSpaceBetweenEmptyParentheses', 'Space between empty parentheses', false),
                    bool('functionCalls.addSpaceAfterFunctionCalls', 'Space after function calls', false),
                ],
            },
        ],
        preview: `select isnull(l.COLLANA, 'nessuna') as Collana, convert(varchar(10), l.DATA_ARRIVO, 103) as Arrivo, getdate() as Oggi,
dateadd(day, -30, getdate()) as Soglia, stuff((select ',' + g.NOME from bib.GENERI as g where g.ID_LIBRO = l.ID_LIBRO for xml path('')), 1, 1, '') as Generi
from bib.LIBRI as l;`,
    },
    {
        id: 'case',
        title: 'CASE',
        groups: [
            {
                title: 'WHEN and THEN',
                options: [
                    choice('caseExpressions.placeFirstWhenOnNewLine', 'First WHEN on a new line', 'always', [
                        ['always', 'Always'], ['ifInputExpression', 'If there is an input expression'], ['never', 'Never'],
                    ]),
                    choice('caseExpressions.whenAlignment', 'WHEN alignment', 'indentedFromCase', [
                        ['indentedFromCase', 'Indented from CASE'], ['toCase', 'To CASE'], ['toFirstItem', 'To the first item'],
                    ]),
                    bool('caseExpressions.placeThenOnNewLine', 'Place THEN on a new line', false),
                    choice('caseExpressions.thenAlignment', 'THEN alignment', 'indentedFromWhen', [
                        ['indentedFromWhen', 'Indented from WHEN'], ['toWhen', 'To WHEN'], ['toWhenExpression', 'To the WHEN expression'],
                    ], 'caseExpressions.placeThenOnNewLine'),
                    bool('caseExpressions.placeExpressionOnNewLine', 'Place result expressions on new lines', true),
                ],
            },
            {
                title: 'ELSE and END',
                options: [
                    bool('caseExpressions.placeElseOnNewLine', 'Place ELSE on a new line', true),
                    bool('caseExpressions.alignElseToWhen', 'Align ELSE to WHEN', true),
                    bool('caseExpressions.placeEndOnNewLine', 'Place END on a new line', true),
                    choice('caseExpressions.endAlignment', 'END alignment', 'toCase', [
                        ['toCase', 'To CASE'], ['toWhen', 'To WHEN'], ['rightAlignedToWhen', 'Right aligned to WHEN'],
                    ]),
                ],
            },
            {
                title: 'Collapsing',
                options: [
                    bool('caseExpressions.collapseShortCaseExpressions', 'Collapse short CASE expressions', false),
                    int('caseExpressions.collapseCaseExpressionsShorterThan', 'Collapse if shorter than', 80, 'caseExpressions.collapseShortCaseExpressions'),
                ],
            },
        ],
        preview: `select l.TITOLO, case when l.DISPONIBILE = 1 and l.DANNEGGIATO = 0 then 'disponibile' when l.DISPONIBILE = 0 then 'in prestito' else null end as Stato,
case l.FORMATO when 'C' then 'cartaceo' when 'E' then 'ebook' end as Formato from bib.LIBRI as l;`,
    },
    {
        id: 'operators',
        title: 'Operators',
        groups: [
            {
                title: 'AND / OR',
                options: [
                    choice('operators.andOr.placeOnNewLine', 'Place AND/OR on new lines', 'always', ALWAYS_NEVER_LONG),
                    choice('operators.andOr.alignment', 'AND/OR alignment', 'leftAligned', [
                        ['leftAligned', 'Left aligned'], ['rightAligned', 'Right aligned'], ['beforeFirstListItem', 'Before the first item'],
                        ['toFirstListItem', 'To the first item'], ['indented', 'Indented'],
                    ]),
                    bool('operators.andOr.placeKeywordBeforeCondition', 'Place AND/OR before the condition', true),
                ],
            },
            {
                title: 'IN',
                options: [
                    bool('operators.in.placeOpeningParenthesisOnNewLine', 'Opening parenthesis on a new line', false),
                    choice('operators.in.alignment', 'IN list alignment', 'leftAligned', ALIGN_LEFT_INDENT_RIGHT),
                    choice('operators.in.placeFirstValueOnNewLine', 'First value on a new line', 'ifSubsequentValues', [
                        ['always', 'Always'], ['never', 'Never'], ['ifLongerThanMaxLineLength', 'If longer than the maximum line length'],
                        ['ifSubsequentValues', 'If there are subsequent values'],
                    ]),
                    choice('operators.in.placeSubsequentValuesOnNewLines', 'Subsequent values on new lines', 'ifLongerThanMaxLineLength', ALWAYS_NEVER_LONG),
                    bool('operators.in.addSpaceAroundInContents', 'Spaces inside the IN parentheses', false),
                ],
            },
            {
                title: 'BETWEEN and comparisons',
                options: [
                    bool('operators.between.placeOnNewLine', 'Place BETWEEN on a new line', true),
                    bool('operators.between.placeAndKeywordOnNewLine', 'Place AND of BETWEEN on a new line', false),
                    choice('operators.between.andAlignment', 'BETWEEN … AND alignment', 'toBetween', [
                        ['toBetween', 'To BETWEEN'], ['rightAlignedToBetween', 'Right aligned to BETWEEN'], ['toBeginningOfExpression', 'To the start of the expression'],
                    ]),
                    bool('operators.comparison.align', 'Align comparison operators', false),
                    bool('operators.comparison.addSpacesAround', 'Spaces around comparison operators', true),
                    bool('operators.arithmetic.addSpacesAround', 'Spaces around arithmetic operators', true),
                ],
            },
        ],
        preview: `select l.TITOLO from bib.LIBRI as l
where l.ATTIVO=1 and l.ANNO between 1990 and 2010 and (l.COLLANA='Classici' or l.COLLANA is null) and l.ID_SEDE in (1, 2, 3, 4)
and l.PREZZO*1.22>20;`,
    },
    {
        id: 'restore',
        title: 'RESTORE',
        groups: [
            {
                title: 'MOVE … TO',
                options: [
                    bool('restoreStatements.moveTo.placeOnNewLine', 'Place MOVE on a new line', true),
                    bool('restoreStatements.moveTo.placeToOnNewLine', 'Place TO on a new line', true),
                    choice('restoreStatements.moveTo.toKeywordAlignment', 'TO alignment', 'none', [
                        ['none', 'None'], ['toMove', 'To MOVE'], ['rightAlignedToMove', 'Right aligned to MOVE'],
                    ]),
                ],
            },
        ],
        preview: `restore database Biblioteca from disk = 'C:\\backup\\biblioteca.bak' with move 'Biblioteca' to 'D:\\dati\\biblioteca.mdf', move 'Biblioteca_log' to 'D:\\dati\\biblioteca.ldf', replace;`,
    },
];

export const ALL_OPTIONS: StyleOption[] = STYLE_SECTIONS.flatMap(s => s.groups.flatMap(g => g.options));

export function findOption(key: string): StyleOption | undefined {
    return ALL_OPTIONS.find(o => o.key === key);
}

/** Valore nel JSON al percorso indicato, o undefined. */
export function getPath(obj: any, key: string): unknown {
    let cur = obj;
    for (const part of key.split('.')) {
        if (cur === null || typeof cur !== 'object' || !(part in cur)) return undefined;
        cur = cur[part];
    }
    return cur;
}

function setPath(obj: any, key: string, value: unknown): void {
    const parts = key.split('.');
    let cur = obj;
    for (const part of parts.slice(0, -1)) {
        if (cur[part] === null || typeof cur[part] !== 'object') cur[part] = {};
        cur = cur[part];
    }
    cur[parts[parts.length - 1]] = value;
}

function deletePath(obj: any, key: string): void {
    const parts = key.split('.');
    const chain: any[] = [obj];
    for (const part of parts.slice(0, -1)) {
        const next = chain[chain.length - 1]?.[part];
        if (next === null || typeof next !== 'object') return;
        chain.push(next);
    }
    delete chain[chain.length - 1][parts[parts.length - 1]];
    // rimuove le sezioni rimaste vuote, dalla più interna
    for (let i = chain.length - 1; i > 0; i--) {
        if (Object.keys(chain[i]).length > 0) break;
        delete chain[i - 1][parts[i - 1]];
    }
}

/**
 * Valore effettivo di un'opzione: quello del file se valido, altrimenti il default.
 * I valori enum si confrontano senza distinzione di maiuscole (come SQL Prompt).
 */
export function effectiveValue(style: unknown, option: StyleOption): OptionValue {
    const raw = getPath(style, option.key);
    switch (option.type) {
        case 'bool':
            return typeof raw === 'boolean' ? raw : option.default;
        case 'int':
            return typeof raw === 'number' && Number.isFinite(raw) ? raw : option.default;
        case 'enum': {
            if (typeof raw !== 'string') return option.default;
            const match = option.choices.find(c => c.value.toLowerCase() === raw.toLowerCase());
            return match ? match.value : option.default;
        }
    }
}

/** Tutti i valori effettivi dello stile, per chiave. */
export function effectiveValues(style: unknown): Record<string, OptionValue> {
    const result: Record<string, OptionValue> = {};
    for (const o of ALL_OPTIONS) result[o.key] = effectiveValue(style, o);
    return result;
}

/** Normalizza un valore arrivato dall'interfaccia; undefined se non valido. */
export function coerceValue(option: StyleOption, value: unknown): OptionValue | undefined {
    switch (option.type) {
        case 'bool':
            return typeof value === 'boolean' ? value : undefined;
        case 'int': {
            const n = typeof value === 'number' ? value : Number(value);
            if (!Number.isInteger(n)) return undefined;
            return Math.min(option.max, Math.max(option.min, n));
        }
        case 'enum':
            return option.choices.some(c => c.value === value) ? (value as string) : undefined;
    }
}

/**
 * Applica i valori modificati allo stile, come fa SQL Prompt in esportazione: le opzioni
 * uguali al default vengono tolte, le chiavi sconosciute (versioni future) restano.
 * Restituisce un nuovo oggetto, l'originale non viene toccato.
 */
export function applyValues(style: unknown, values: Record<string, unknown>): Record<string, unknown> {
    const result = JSON.parse(JSON.stringify(style ?? {}));
    for (const [key, value] of Object.entries(values)) {
        const option = findOption(key);
        if (!option) continue;
        const v = coerceValue(option, value);
        if (v === undefined) continue;
        if (v === option.default) deletePath(result, key);
        else setPath(result, key, v);
    }
    return result;
}

/** Nome di file sicuro per uno stile (senza caratteri non validi su Windows e macOS). */
export function styleFileName(name: string): string {
    const safe = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'Style';
    return `${safe}.json`;
}
