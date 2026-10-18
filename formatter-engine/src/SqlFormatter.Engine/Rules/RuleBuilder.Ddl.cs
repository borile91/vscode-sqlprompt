using Microsoft.SqlServer.TransactSql.ScriptDom;
using SqlFormatter.Engine.Layout;
using SqlFormatter.Engine.Style;

namespace SqlFormatter.Engine.Rules;

// Funzioni, ALTER TABLE, vincoli, opzioni degli indici
public sealed partial class RuleBuilder
{
    public override void ExplicitVisit(CreateFunctionStatement node) { ArrangeFunction(node); base.ExplicitVisit(node); }
    public override void ExplicitVisit(AlterFunctionStatement node) { ArrangeFunction(node); base.ExplicitVisit(node); }
    public override void ExplicitVisit(CreateOrAlterFunctionStatement node) { ArrangeFunction(node); base.ExplicitVisit(node); }

    private void ArrangeFunction(FunctionStatementBody node)
    {
        int create = _m.FirstCode(node);
        var d = _s.Ddl;
        if (node.Parameters.Count > 0)
        {
            int open = _m.PrevCode(_m.FirstCode(node.Parameters[0]));
            int close = _m.NextCode(_m.Last(node.Parameters[^1]));
            ArrangeParentheses(open, close, create, d.ParenthesisStyle, d.IndentParenthesesContents);
            ArrangeList(open, node.Parameters, NewLineMode.Never, NewLineMode.Always);
        }
        if (node.ReturnType != null)
        {
            int returns = _m.PrevCode(_m.FirstCode(node.ReturnType));
            _m.Break(returns);
            _m.AlignRange(returns, _m.Last(node.ReturnType), create, 0);
            if (node.ReturnType is TableValuedFunctionReturnType tv && tv.DeclareTableVariableBody?.Definition is { } def)
                ArrangeTableDefinition(def, create);
        }
        // AS e BEGIN … END del corpo
        int lastHeader = node.ReturnType != null ? _m.Last(node.ReturnType) : _m.Last(node.Name);
        int @as = _m.FindForward(lastHeader + 1, _m.Last(node), TSqlTokenType.As);
        if (@as >= 0)
        {
            _m.Break(@as);
            _m.AlignTo(@as, create, 0);
            int body = _m.NextCode(@as);
            if (body >= 0)
            {
                _m.Break(body);
                _m.AlignRange(body, _m.Last(node), create, d.IndentClauses ? _tab : 0);
            }
        }
        if (node.StatementList != null)
        {
            int begin = _m.FindBackward(_m.FirstCode(node.StatementList.Statements.FirstOrDefault() ?? (TSqlFragment)node) - 1, create,
                sl => sl.Token.TokenType == TSqlTokenType.Begin);
            if (begin >= 0 && node.StatementList.Statements.Count > 0 && node.StatementList.Statements[0] is not BeginEndBlockStatement)
            {
                ArrangeStatements(node.StatementList.Statements, begin, _tab);
                _m.SetBreaks(_m.FirstCode(node.StatementList.Statements[0]), 1);
                int end = _m.FindBackward(_m.Last(node), begin, sl => sl.Token.TokenType == TSqlTokenType.End);
                if (end > begin)
                {
                    _m.Break(end);
                    _m.AlignTo(end, begin, 0);
                }
            }
        }
    }

    // Colonne e vincoli di una tabella (CREATE TABLE, tabelle restituite, variabili tabella)
    private void ArrangeTableDefinition(TableDefinition def, int statementStart)
    {
        var items = new List<TSqlFragment>();
        items.AddRange(def.ColumnDefinitions);
        items.AddRange(def.TableConstraints);
        items.AddRange(def.Indexes);
        items = items.OrderBy(f => f.FirstTokenIndex).ToList();
        if (items.Count == 0) return;
        int open = _m.PrevCode(_m.FirstCode(items[0]));
        int close = _m.NextCode(_m.Last(items[^1]));
        ArrangeParentheses(open, close, statementStart, _s.Ddl.ParenthesisStyle, _s.Ddl.IndentParenthesesContents);
        ArrangeList(open, items, NewLineMode.Never, NewLineMode.Always);
    }

    public override void ExplicitVisit(AlterTableAddTableElementStatement node)
    {
        int alter = _m.FirstCode(node);
        int add = _m.FindForward(_m.Last(node.SchemaObjectName) + 1, _m.Last(node), TSqlTokenType.Add);
        if (add >= 0)
        {
            _m.Break(add);
            _m.AlignRange(add, _m.Last(node), alter, 0);
            _m.AlignRange(add + 1, _m.Last(node), add, _tab);
        }
        base.ExplicitVisit(node);
    }

    // CONSTRAINT nome: il corpo del vincolo va a capo se richiesto
    private void ArrangeConstraint(ConstraintDefinition node)
    {
        if (node.ConstraintIdentifier == null) return;
        int keyword = _m.PrevCode(_m.First(node.ConstraintIdentifier));
        int body = _m.NextCode(_m.Last(node.ConstraintIdentifier));
        if (body < 0 || body > _m.Last(node)) return;
        _m.AlignRange(body, _m.Last(node), keyword, _tab);
        if (_s.Ddl.PlaceConstraintsOnNewLines) _m.Break(body);
    }

    private void ArrangeConstraintColumns<T>(IList<T> columns) where T : TSqlFragment
    {
        if (columns.Count == 0) return;
        int open = _m.PrevCode(_m.FirstCode(columns[0]));
        int close = _m.NextCode(_m.Last(columns[^1]));
        if (open < 0 || _m.Slots[open].Token.TokenType != TSqlTokenType.LeftParenthesis) return;
        var points = new List<int> { _m.FirstCode(columns[0]) };
        _m.AlignTo(points[0], open, _tab);
        for (int i = 1; i < columns.Count; i++)
        {
            int start = _m.FirstCode(columns[i]);
            points.Add(start);
            _m.AlignTo(start, open, _tab);
        }
        points.Add(close);
        _m.AlignTo(close, open, 0);
        _m.AddGroup(Mode(_s.Ddl.PlaceConstraintColumnsOnNewLines), open, close, points, columns.Count);
    }

    public override void ExplicitVisit(UniqueConstraintDefinition node)
    {
        ArrangeConstraint(node);
        ArrangeConstraintColumns(node.Columns);
        ArrangeIndexOptions(node.IndexOptions);
        base.ExplicitVisit(node);
    }

    public override void ExplicitVisit(ForeignKeyConstraintDefinition node)
    {
        ArrangeConstraint(node);
        ArrangeConstraintColumns(node.Columns);
        ArrangeConstraintColumns(node.ReferencedTableColumns);
        if (_s.Ddl.PlaceConstraintsOnNewLines)
        {
            int references = _m.PrevCode(_m.First(node.ReferenceTableName));
            int fk = _m.FirstCode(node);
            if (node.ConstraintIdentifier != null) fk = _m.NextCode(_m.Last(node.ConstraintIdentifier));
            _m.Break(references);
            _m.AlignTo(references, fk, 0);
        }
        base.ExplicitVisit(node);
    }

    public override void ExplicitVisit(DefaultConstraintDefinition node) { ArrangeConstraint(node); base.ExplicitVisit(node); }
    public override void ExplicitVisit(CheckConstraintDefinition node) { ArrangeConstraint(node); base.ExplicitVisit(node); }

    // WITH ( opzione = valore, … ): a capo solo se la riga è troppo lunga
    private void ArrangeIndexOptions(IList<IndexOption> options)
    {
        if (options.Count < 2) return;
        int first = _m.FirstCode(options[0]);
        int open = _m.PrevCode(first);
        int close = _m.NextCode(_m.Last(options[^1]));
        ArrangeList(open, options, NewLineMode.Never, NewLineMode.IfLongerThanMaxLineLength);
        _m.AlignRange(first, close, first, 0);
    }
}
