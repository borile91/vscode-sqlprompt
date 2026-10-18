namespace SqlFormatter.Engine.Style;

// Modello dello stile nel formato JSON "portable" di SQL Prompt.
// Le chiavi assenti dal file prendono i default qui sotto (gli stessi di SQL Prompt):
// uno stile esportato contiene solo le chiavi diverse dal default.
// I nomi dei valori enum coincidono con le stringhe JSON (confronto senza maiuscole).

public sealed class FormattingStyle
{
    public MetadataOptions Metadata { get; set; } = new();
    public WhitespaceOptions Whitespace { get; set; } = new();
    public ListOptions Lists { get; set; } = new();
    public ParenthesesOptions Parentheses { get; set; } = new();
    public CasingOptions Casing { get; set; } = new();
    public DmlOptions Dml { get; set; } = new();
    public DdlOptions Ddl { get; set; } = new();
    public ControlFlowOptions ControlFlow { get; set; } = new();
    public CteOptions Cte { get; set; } = new();
    public VariableOptions Variables { get; set; } = new();
    public JoinStatementOptions JoinStatements { get; set; } = new();
    public InsertStatementOptions InsertStatements { get; set; } = new();
    public RestoreStatementOptions RestoreStatements { get; set; } = new();
    public FunctionCallOptions FunctionCalls { get; set; } = new();
    public CaseExpressionOptions CaseExpressions { get; set; } = new();
    public OperatorOptions Operators { get; set; } = new();
}

public sealed class MetadataOptions
{
    public string? Id { get; set; }
    public string? Name { get; set; }
}

public enum TabBehaviour { Spaces, Tabs, TabsIfPossible }

public enum SemicolonWhitespace { None, SpaceBefore, NewLineBefore }

public sealed class WhitespaceOptions
{
    public TabBehaviour SpacesOrTabs { get; set; } = TabBehaviour.Spaces;
    public int NumberOfSpacesInTabs { get; set; } = 4;
    public bool WrapLongLines { get; set; } = true;
    public int WrapLinesLongerThan { get; set; } = 120;
    public SemicolonWhitespace WhiteSpaceBeforeSemiColon { get; set; } = SemicolonWhitespace.None;
    public NewLineOptions NewLines { get; set; } = new();
}

public sealed class NewLineOptions
{
    public bool PreserveExistingEmptyLinesBetweenStatements { get; set; } = true;
    public bool PreserveExistingEmptyLinesAfterBatchSeparator { get; set; } = true;
    public bool AlignGroupOfSingleLineComments { get; set; } = true;
    public bool AlignMultilineCommentsMatchingPatterns { get; set; } = true;
    public int EmptyLinesBetweenStatements { get; set; } = 1;
    public int EmptyLinesAfterBatchSeparator { get; set; } = 1;
}

// Valori di "a capo" condivisi da più chiavi; ogni chiave ne ammette un sottoinsieme.
public enum NewLineMode
{
    Never,
    Always,
    IfLongerThanMaxLineLength,
    IfSubsequentItems,
    IfMultiple,
    IfMultipleItems,
    IfLongerOrMultipleColumns,
    IfSubsequentValues,
}

public enum CommaAlignment { BeforeItem, ToList, ToStatement }

public sealed class ListOptions
{
    public NewLineMode PlaceFirstItemOnNewLine { get; set; } = NewLineMode.Never;
    public NewLineMode PlaceSubsequentItemsOnNewLines { get; set; } = NewLineMode.Always;
    public bool AlignSubsequentItemsWithFirstItem { get; set; } = true;
    public bool AlignItemsAcrossClauses { get; set; } = true;
    public bool IndentListItems { get; set; } = true;
    public bool AlignItemsToTabStops { get; set; }
    public bool AlignAliases { get; set; }
    public bool AlignComments { get; set; }
    public bool PlaceCommasBeforeItems { get; set; }
    public bool AddSpaceBeforeComma { get; set; }
    public bool AddSpaceAfterComma { get; set; } = true;
    public CommaAlignment CommaAlignment { get; set; } = CommaAlignment.BeforeItem;
}

public enum ParenthesisStyle
{
    CompactSimple,
    CompactToStatement,
    CompactIndented,
    CompactRightAligned,
    ExpandedSimple,
    ExpandedToStatement,
    ExpandedIndented,
    ExpandedRightAligned,
    ExpandedSplit,
}

public sealed class ParenthesesOptions
{
    public ParenthesisStyle ParenthesisStyle { get; set; } = ParenthesisStyle.CompactSimple;
    public bool IndentParenthesesContents { get; set; }
    public bool CollapseShortParenthesisContents { get; set; }
    public int CollapseParenthesesShorterThan { get; set; } = 80;
    public bool AddSpacesAroundParentheses { get; set; } = true;
    public bool AddSpacesInsideParentheses { get; set; }
}

public enum Casing { LeaveAsIs, Lowercase, Uppercase, LowerCamelCase, UpperCamelCase }

public sealed class CasingOptions
{
    public Casing ReservedKeywords { get; set; } = Casing.LeaveAsIs;
    public Casing BuiltInFunctions { get; set; } = Casing.LeaveAsIs;
    public Casing BuiltInDataTypes { get; set; } = Casing.LeaveAsIs;
    public Casing GlobalVariables { get; set; } = Casing.LeaveAsIs;
    public bool UseObjectDefinitionCase { get; set; }
}

public enum ClauseAlignment { LeftAligned, RightAligned, ToFirstListItem, Indented }

public sealed class DmlOptions
{
    public bool PlaceInsertTableOnNewLine { get; set; }
    public bool PlaceDistinctAndTopClausesOnNewLine { get; set; }
    public bool AddNewLineAfterDistinctAndTopClauses { get; set; }
    public bool CollapseShortStatements { get; set; }
    public int CollapseStatementsShorterThan { get; set; } = 80;
    public bool CollapseShortSubqueries { get; set; }
    public int CollapseSubqueriesShorterThan { get; set; } = 80;
    public DmlClauseOptions Clauses { get; set; } = new();
    public DmlListItemOptions ListItems { get; set; } = new();
}

public sealed class DmlClauseOptions
{
    public ClauseAlignment ClauseAlignment { get; set; } = ClauseAlignment.LeftAligned;
    public int ClauseIndentation { get; set; }
}

public sealed class DmlListItemOptions
{
    public NewLineMode PlaceFromTableOnNewLine { get; set; } = NewLineMode.Never;
    public NewLineMode PlaceWhereConditionOnNewLine { get; set; } = NewLineMode.Never;
    public NewLineMode PlaceGroupByAndOrderByOnNewLine { get; set; } = NewLineMode.Never;
}

public sealed class DdlOptions
{
    public ParenthesisStyle ParenthesisStyle { get; set; } = ParenthesisStyle.CompactSimple;
    public bool IndentParenthesesContents { get; set; }
    public bool AlignDataTypesAndConstraints { get; set; }
    public bool PlaceConstraintsOnNewLines { get; set; }
    public NewLineMode PlaceConstraintColumnsOnNewLines { get; set; } = NewLineMode.IfLongerThanMaxLineLength;
    public bool IndentClauses { get; set; }
    public NewLineMode PlaceFirstProcedureParameterOnNewLine { get; set; } = NewLineMode.IfMultipleItems;
    public bool CollapseShortStatements { get; set; }
    public int CollapseStatementsShorterThan { get; set; } = 80;
}

public sealed class ControlFlowOptions
{
    public bool PlaceBeginAndEndOnNewLine { get; set; } = true;
    public bool IndentBeginAndEndKeywords { get; set; }
    public bool IndentContentsOfStatements { get; set; } = true;
    public bool CollapseShortStatements { get; set; }
    public int CollapseStatementsShorterThan { get; set; } = 80;
}

public enum CteAlignment { LeftAligned, Indented, RightAligned }

public sealed class CteOptions
{
    public ParenthesisStyle ParenthesisStyle { get; set; } = ParenthesisStyle.CompactSimple;
    public bool IndentContents { get; set; }
    public bool PlaceNameOnNewLine { get; set; }
    public bool IndentName { get; set; }
    public bool PlaceColumnsOnNewLine { get; set; }
    public CteAlignment ColumnAlignment { get; set; } = CteAlignment.LeftAligned;
    public bool PlaceAsOnNewLine { get; set; } = true;
    public CteAlignment AsAlignment { get; set; } = CteAlignment.LeftAligned;
}

public sealed class VariableOptions
{
    public bool AlignDataTypesAndValues { get; set; } = true;
    public bool AddSpaceBetweenDataTypeAndPrecision { get; set; }
    public bool PlaceAssignedValueOnNewLineIfLongerThanMaxLineLength { get; set; } = true;
    public bool PlaceEqualsSignOnNewLine { get; set; }
}

public enum JoinKeywordAlignment { ToFrom, RightAlignedToFrom, ToTable, Indented }

public enum JoinOnKeywordAlignment { ToJoin, RightAlignedToJoin, RightAlignedToInner, ToTable, Indented }

public enum JoinOnConditionAlignment { ToOnKeyword, ToInner, ToTable, Indented }

public sealed class JoinStatementOptions
{
    public JoinOptions Join { get; set; } = new();
    public JoinOnOptions On { get; set; } = new();
}

public sealed class JoinOptions
{
    public bool PlaceOnNewLine { get; set; } = true;
    public JoinKeywordAlignment KeywordAlignment { get; set; } = JoinKeywordAlignment.ToFrom;
    public bool InsertEmptyLineBetweenJoinClauses { get; set; }
    public bool PlaceJoinTableOnNewLine { get; set; }
    public bool IndentJoinTable { get; set; } = true;
}

public sealed class JoinOnOptions
{
    public bool PlaceOnNewLine { get; set; } = true;
    public JoinOnKeywordAlignment KeywordAlignment { get; set; } = JoinOnKeywordAlignment.ToJoin;
    public bool PlaceConditionOnNewLine { get; set; }
    public JoinOnConditionAlignment ConditionAlignment { get; set; } = JoinOnConditionAlignment.ToOnKeyword;
}

public sealed class InsertStatementOptions
{
    public InsertColumnOptions Columns { get; set; } = new();
    public InsertValueOptions Values { get; set; } = new();
}

public sealed class InsertColumnOptions
{
    public ParenthesisStyle ParenthesisStyle { get; set; } = ParenthesisStyle.ExpandedToStatement;
    public bool IndentContents { get; set; } = true;
    public NewLineMode PlaceSubsequentColumnsOnNewLines { get; set; } = NewLineMode.Always;
}

public sealed class InsertValueOptions
{
    public ParenthesisStyle ParenthesisStyle { get; set; } = ParenthesisStyle.CompactToStatement;
    public bool IndentContents { get; set; }
    public NewLineMode PlaceSubsequentValuesOnNewLines { get; set; } = NewLineMode.Never;
}

public enum MoveToAlignment { None, ToMove, RightAlignedToMove }

public sealed class RestoreStatementOptions
{
    public MoveToOptions MoveTo { get; set; } = new();
}

public sealed class MoveToOptions
{
    public bool PlaceOnNewLine { get; set; } = true;
    public bool PlaceToOnNewLine { get; set; } = true;
    public MoveToAlignment ToKeywordAlignment { get; set; } = MoveToAlignment.None;
}

public sealed class FunctionCallOptions
{
    public NewLineMode PlaceArgumentsOnNewLines { get; set; } = NewLineMode.IfLongerThanMaxLineLength;
    public bool AddSpacesAroundParentheses { get; set; }
    public bool AddSpacesAroundArgumentList { get; set; }
    public bool AddSpaceBetweenEmptyParentheses { get; set; }
    public bool AddSpaceAfterFunctionCalls { get; set; }
}

public enum CaseFirstWhen { Always, IfInputExpression, Never }

public enum CaseWhenAlignment { IndentedFromCase, ToCase, ToFirstItem }

public enum CaseThenAlignment { IndentedFromWhen, ToWhen, ToWhenExpression }

public enum CaseEndAlignment { ToCase, ToWhen, RightAlignedToWhen }

public sealed class CaseExpressionOptions
{
    public bool PlaceExpressionOnNewLine { get; set; } = true;
    public CaseFirstWhen PlaceFirstWhenOnNewLine { get; set; } = CaseFirstWhen.Always;
    public CaseWhenAlignment WhenAlignment { get; set; } = CaseWhenAlignment.IndentedFromCase;
    public bool PlaceThenOnNewLine { get; set; }
    public CaseThenAlignment ThenAlignment { get; set; } = CaseThenAlignment.IndentedFromWhen;
    public bool PlaceElseOnNewLine { get; set; } = true;
    public bool AlignElseToWhen { get; set; } = true;
    public bool PlaceEndOnNewLine { get; set; } = true;
    public CaseEndAlignment EndAlignment { get; set; } = CaseEndAlignment.ToCase;
    public bool CollapseShortCaseExpressions { get; set; }
    public int CollapseCaseExpressionsShorterThan { get; set; } = 80;
}

public enum AndOrAlignment { LeftAligned, RightAligned, BeforeFirstListItem, ToFirstListItem, Indented }

public enum BetweenAndAlignment { ToBetween, RightAlignedToBetween, ToBeginningOfExpression }

public sealed class OperatorOptions
{
    public ComparisonOptions Comparison { get; set; } = new();
    public ArithmeticOptions Arithmetic { get; set; } = new();
    public AndOrOptions AndOr { get; set; } = new();
    public BetweenOptions Between { get; set; } = new();
    public InOptions In { get; set; } = new();
}

public sealed class ComparisonOptions
{
    public bool Align { get; set; }
    public bool AddSpacesAround { get; set; } = true;
}

public sealed class ArithmeticOptions
{
    public bool AddSpacesAround { get; set; } = true;
}

public sealed class AndOrOptions
{
    public NewLineMode PlaceOnNewLine { get; set; } = NewLineMode.Always;
    public AndOrAlignment Alignment { get; set; } = AndOrAlignment.LeftAligned;
    public bool PlaceKeywordBeforeCondition { get; set; } = true;
}

public sealed class BetweenOptions
{
    public bool PlaceOnNewLine { get; set; } = true;
    public bool PlaceAndKeywordOnNewLine { get; set; }
    public BetweenAndAlignment AndAlignment { get; set; } = BetweenAndAlignment.ToBetween;
}

public sealed class InOptions
{
    public bool PlaceOpeningParenthesisOnNewLine { get; set; }
    public CteAlignment Alignment { get; set; } = CteAlignment.LeftAligned;
    public NewLineMode PlaceFirstValueOnNewLine { get; set; } = NewLineMode.IfSubsequentValues;
    public NewLineMode PlaceSubsequentValuesOnNewLines { get; set; } = NewLineMode.IfLongerThanMaxLineLength;
    public bool AddSpaceAroundInContents { get; set; }
}
