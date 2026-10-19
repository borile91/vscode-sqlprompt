using Microsoft.SqlServer.TransactSql.ScriptDom;
using SqlFormatter.Engine.Layout;
using SqlFormatter.Engine.Style;

namespace SqlFormatter.Engine.Rules;

// BEGIN/END, IF/ELSE, WHILE, TRY/CATCH, procedure, viste, tabelle, DECLARE
public sealed partial class RuleBuilder
{
    // blocchi già posizionati come corpo di IF/ELSE/WHILE
    private readonly HashSet<TSqlStatement> _controlBodies = [];

    // BEGIN … END come statement a sé: rientrato se indentBeginAndEndKeywords
    private void IndentStandaloneBlock(TSqlStatement node)
    {
        if (_controlBodies.Contains(node) || !_s.ControlFlow.IndentBeginAndEndKeywords) return;
        int begin = _m.FirstCode(node);
        var slot = _m.Slots[begin];
        // se il contenitore rientra già i suoi statement, il rientro non si somma
        if (slot.Offset > 0) return;
        int anchor = slot.Anchor, offset = slot.Offset + _tab;
        for (int i = begin; i <= _m.Last(node); i++)
        {
            _m.Slots[i].Anchor = anchor;
            _m.Slots[i].Offset = offset;
        }
    }

    public override void ExplicitVisit(BeginEndBlockStatement node)
    {
        IndentStandaloneBlock(node);
        int begin = _m.FirstCode(node);
        int end = EndKeyword(node);
        ArrangeStatements(node.StatementList.Statements, begin, _tab);
        if (end >= 0)
        {
            _m.Break(end);
            _m.AlignTo(end, begin, 0);
            // il ; dopo END resta attaccato
        }
        base.ExplicitVisit(node);
    }

    private int EndKeyword(TSqlFragment block)
    {
        return _m.FindBackward(_m.Last(block), _m.FirstCode(block), sl => sl.Token.TokenType == TSqlTokenType.End);
    }

    public override void ExplicitVisit(TryCatchStatement node)
    {
        IndentStandaloneBlock(node);
        int begin = _m.FirstCode(node);
        ArrangeStatements(node.TryStatements.Statements, begin, _tab);
        ArrangeStatements(node.CatchStatements.Statements, begin, _tab);
        // END TRY, BEGIN CATCH, END CATCH allineati al BEGIN TRY
        for (int i = begin + 1; i <= _m.Last(node); i++)
        {
            var t = _m.Slots[i].Token.TokenType;
            if (t is TSqlTokenType.End or TSqlTokenType.Begin && IsTryCatchKeyword(i))
            {
                _m.Break(i);
                _m.AlignTo(i, begin, 0);
            }
        }
        base.ExplicitVisit(node);
    }

    private bool IsTryCatchKeyword(int slot)
    {
        int next = _m.NextCode(slot);
        return next >= 0 && _m.Slots[next].Token.Text.ToUpperInvariant() is "TRY" or "CATCH";
    }

    public override void ExplicitVisit(IfStatement node)
    {
        int @if = _m.FirstCode(node);
        int before = _m.PrevCode(@if);
        // ELSE IF: il blocco si allinea all'ELSE
        int head = before >= 0 && _m.Slots[before].Token.TokenType == TSqlTokenType.Else ? before : @if;
        ArrangeControlBody(head, node.ThenStatement);
        if (node.ElseStatement != null)
        {
            int @else = _m.PrevCode(_m.FirstCode(node.ElseStatement));
            _m.Break(@else);
            _m.AlignTo(@else, head, 0);
            if (node.ElseStatement is IfStatement)
                _m.AlignRange(@else + 1, _m.Last(node.ElseStatement), @else, 0);
            else
                ArrangeControlBody(@else, node.ElseStatement);
        }
        if (_s.ControlFlow.CollapseShortStatements && node.ThenStatement is not BeginEndBlockStatement)
            _m.AddCollapse(@if, _m.Last(node.ThenStatement), _s.ControlFlow.CollapseStatementsShorterThan);
        base.ExplicitVisit(node);
    }

    public override void ExplicitVisit(WhileStatement node)
    {
        int head = _m.FirstCode(node);
        ArrangeControlBody(head, node.Statement);
        base.ExplicitVisit(node);
    }

    // Corpo di IF/ELSE/WHILE: un blocco BEGIN/END o un singolo statement rientrato
    private void ArrangeControlBody(int head, TSqlStatement body)
    {
        var o = _s.ControlFlow;
        int first = _m.FirstCode(body);
        int indent = o.IndentContentsOfStatements ? _tab : 0;
        _controlBodies.Add(body);
        if (body is BeginEndBlockStatement)
        {
            if (o.PlaceBeginAndEndOnNewLine) _m.Break(first);
            _m.AlignRange(first, _m.Last(body), head, o.IndentBeginAndEndKeywords ? _tab : 0);
        }
        else
        {
            _m.Break(first);
            _m.AlignRange(first, _m.Last(body), head, indent);
            _m.AlignTo(first, head, indent);
        }
    }

    // ---- procedure, funzioni, viste ----

    public override void ExplicitVisit(CreateProcedureStatement node) { ArrangeProcedure(node); base.ExplicitVisit(node); }
    public override void ExplicitVisit(AlterProcedureStatement node) { ArrangeProcedure(node); base.ExplicitVisit(node); }
    public override void ExplicitVisit(CreateOrAlterProcedureStatement node) { ArrangeProcedure(node); base.ExplicitVisit(node); }

    private void ArrangeProcedure(ProcedureStatementBody node)
    {
        int create = _m.FirstCode(node);
        int name = _m.FirstCode(node.ProcedureReference);
        var d = _s.Ddl;
        if (node.Parameters.Count > 0)
        {
            int firstParam = _m.FirstCode(node.Parameters[0]);
            int lastParam = _m.Last(node.Parameters[^1]);
            int open = _m.PrevCode(firstParam);
            int close = _m.NextCode(lastParam);
            bool hasParens = open >= 0 && _m.Slots[open].Token.TokenType == TSqlTokenType.LeftParenthesis;
            if (hasParens)
            {
                ArrangeParentheses(open, close, create, d.ParenthesisStyle, d.IndentParenthesesContents);
                ArrangeList(open, node.Parameters, NewLineMode.Never, _s.Lists.PlaceSubsequentItemsOnNewLines, (create, 0));
            }
            else
            {
                ArrangeList(create, node.Parameters, d.PlaceFirstProcedureParameterOnNewLine, _s.Lists.PlaceSubsequentItemsOnNewLines, (create, 0));
            }
        }
        if (node.StatementList != null && node.StatementList.Statements.Count > 0)
        {
            int @as = _m.PrevCode(_m.FirstCode(node.StatementList.Statements[0]));
            while (@as > name && _m.Slots[@as].Token.TokenType != TSqlTokenType.As) @as = _m.PrevCode(@as);
            if (@as > name)
            {
                _m.Break(@as);
                _m.AlignTo(@as, create, 0);
            }
            ArrangeStatements(node.StatementList.Statements, create, d.IndentClauses ? _tab : 0);
            int first = _m.FirstCode(node.StatementList.Statements[0]);
            _m.SetBreaks(first, 1);
        }
    }

    public override void ExplicitVisit(CreateViewStatement node) { ArrangeView(node); base.ExplicitVisit(node); }
    public override void ExplicitVisit(AlterViewStatement node) { ArrangeView(node); base.ExplicitVisit(node); }
    public override void ExplicitVisit(CreateOrAlterViewStatement node) { ArrangeView(node); base.ExplicitVisit(node); }

    private void ArrangeView(ViewStatementBody node)
    {
        int create = _m.FirstCode(node);
        int select = _m.FirstCode(node.SelectStatement);
        int @as = _m.PrevCode(select);
        _m.Break(@as);
        _m.AlignTo(@as, create, 0);
        _m.Break(select);
        _m.AlignRange(select, _m.Last(node), create, _s.Ddl.IndentClauses ? _tab : 0);
    }

    // ---- tabelle ----

    public override void ExplicitVisit(CreateTableStatement node)
    {
        if (node.Definition != null)
        {
            int create = _m.FirstCode(node);
            ArrangeTableDefinition(node.Definition, create);
            if (_s.Ddl.CollapseShortStatements)
                _m.AddCollapse(create, _m.Last(node), _s.Ddl.CollapseStatementsShorterThan);
        }
        base.ExplicitVisit(node);
    }

    // ---- cursori ----

    // CURSOR … FOR: la SELECT va a capo, allineata all'inizio dello statement
    public override void ExplicitVisit(CursorDefinition node)
    {
        if (node.Select != null)
        {
            int select = _m.FirstCode(node.Select);
            int stmt = _m.FindBackward(select, 0, sl => sl.Token.TokenType is TSqlTokenType.Set or TSqlTokenType.Declare);
            _m.Break(select);
            _m.AlignRange(select, _m.Last(node.Select), stmt >= 0 ? stmt : select, 0);
        }
        base.ExplicitVisit(node);
    }

    // FETCH … INTO: INTO a capo allineato a FETCH, variabili come una lista
    public override void ExplicitVisit(FetchCursorStatement node)
    {
        if (node.IntoVariables.Count > 0)
        {
            int fetch = _m.FirstCode(node);
            int into = _m.PrevCode(_m.FirstCode(node.IntoVariables[0]));
            _m.Break(into);
            _m.AlignTo(into, fetch, 0);
            ArrangeList(into, node.IntoVariables, NewLineMode.Never, _s.Lists.PlaceSubsequentItemsOnNewLines);
        }
        base.ExplicitVisit(node);
    }

    // ---- variabili ----

    public override void ExplicitVisit(DeclareVariableStatement node)
    {
        int declare = _m.FirstCode(node);
        if (node.Declarations.Count > 0)
        {
            ArrangeList(declare, node.Declarations, NewLineMode.Never, _s.Lists.PlaceSubsequentItemsOnNewLines);
            if (_s.Variables.AlignDataTypesAndValues && node.Declarations.Count > 1)
            {
                _m.AddAlignGroup(node.Declarations.Where(d => d.DataType != null).Select(d => _m.FirstCode(d.DataType)));
                // = incolonnati: con almeno due valori la colonna tiene conto anche dei tipi senza valore
                var values = node.Declarations.Where(d => d.Value != null).ToList();
                _m.AddAlignGroup(
                    values.Select(d => _m.PrevCode(_m.FirstCode(d.Value))),
                    values.Count > 1 ? node.Declarations.Where(d => d.Value == null && d.DataType != null).Select(d => _m.Last(d.DataType)) : null);
            }
        }
        base.ExplicitVisit(node);
    }
}
