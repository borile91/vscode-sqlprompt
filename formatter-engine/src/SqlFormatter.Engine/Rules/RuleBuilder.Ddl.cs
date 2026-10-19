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
            // parametri delle funzioni sempre uno per riga (verificato con la CLI)
            ArrangeList(open, node.Parameters, NewLineMode.Never, NewLineMode.Always, (create, 0));
        }
        // RETURNS su una riga propria, allineato a CREATE
        int afterHeader = node.Parameters.Count > 0 ? _m.NextCode(_m.Last(node.Parameters[^1])) : _m.Last(node.Name);
        int returns = _m.FindForward(afterHeader, _m.Last(node), sl => sl.Token.Text.Equals("RETURNS", StringComparison.OrdinalIgnoreCase));
        if (returns >= 0)
        {
            _m.Break(returns);
            _m.AlignTo(returns, create, 0);
        }
        if (node.ReturnType is TableValuedFunctionReturnType tv && tv.DeclareTableVariableBody?.Definition is { } def)
            ArrangeTableDefinition(def, create);

        // AS e corpo (BEGIN … END oppure RETURN ( SELECT … ) delle funzioni inline)
        int bodyStart = node.ReturnType is SelectFunctionReturnType sel ? _m.FirstCode(sel) : -1;
        int searchFrom = returns >= 0 ? returns : afterHeader;
        int @as = _m.FindForward(searchFrom, _m.Last(node), TSqlTokenType.As);
        if (bodyStart >= 0) @as = _m.FindBackward(bodyStart, searchFrom, sl => sl.Token.TokenType == TSqlTokenType.As);
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
            if (node.ReturnType is SelectFunctionReturnType inline && body >= 0
                && _m.Slots[body].Token.TokenType == TSqlTokenType.Return)
            {
                // RETURN ( … ): la parentesi segue RETURN, la chiusa è l'ultima del corpo
                int open = _m.NextCode(body);
                int close = _m.FindBackward(_m.Last(node), open + 1, sl => sl.Token.TokenType == TSqlTokenType.RightParenthesis);
                if (open < 0 || _m.Slots[open].Token.TokenType != TSqlTokenType.LeftParenthesis) open = -1;
                if (open > body && close > open)
                    ArrangeParentheses(open, close, body, _s.Parentheses.ParenthesisStyle, _s.Parentheses.IndentParenthesesContents);
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

    // WITH ( opzione = valore, … ): a capo solo se la riga è troppo lunga;
    // con una sola opzione nei vincoli tutto attaccato: WITH(FILLFACTOR = 80)
    private void ArrangeIndexOptions(IList<IndexOption> options)
    {
        if (options.Count == 1)
        {
            int only = _m.FirstCode(options[0]);
            int o = _m.PrevCode(only);
            int c = _m.NextCode(_m.Last(options[0]));
            if (o >= 0 && _m.Slots[o].Token.TokenType == TSqlTokenType.LeftParenthesis)
            {
                _m.NoSpaceBefore(o);
                _m.NoSpaceBefore(only);
                _m.NoSpaceBefore(c);
            }
            return;
        }
        if (options.Count < 2) return;
        int first = _m.FirstCode(options[0]);
        int open = _m.PrevCode(first);
        int close = _m.NextCode(_m.Last(options[^1]));
        ArrangeList(open, options, NewLineMode.Never, NewLineMode.IfLongerThanMaxLineLength);
        _m.AlignRange(first, close, first, 0);
    }

    // ---- indici ----

    // CREATE INDEX nome / ON tabella ( colonne ) / INCLUDE / WHERE / WITH, rientrati
    public override void ExplicitVisit(CreateIndexStatement node)
    {
        int create = _m.FirstCode(node);
        int on = _m.PrevCode(_m.FirstCode(node.OnName));
        IndexClause(on, create);
        if (node.IncludeColumns.Count > 0)
            IndexClause(_m.FindBackward(_m.FirstCode(node.IncludeColumns[0]), on, sl => sl.Token.Text.Equals("INCLUDE", StringComparison.OrdinalIgnoreCase)), create);
        if (node.FilterPredicate != null)
            IndexClause(_m.FindBackward(_m.FirstCode(node.FilterPredicate), on, sl => sl.Token.TokenType == TSqlTokenType.Where), create);
        if (node.IndexOptions.Count > 0)
            IndexClause(_m.FindBackward(_m.FirstCode(node.IndexOptions[0]), on, sl => sl.Token.TokenType == TSqlTokenType.With), create);
        base.ExplicitVisit(node);
    }

    // ALTER INDEX nome / ON tabella / azione
    public override void ExplicitVisit(AlterIndexStatement node)
    {
        int alter = _m.FirstCode(node);
        int on = _m.PrevCode(_m.FirstCode(node.OnName));
        IndexClause(on, alter);
        IndexClause(_m.NextCode(_m.Last(node.OnName)), alter);
        base.ExplicitVisit(node);
    }

    private void IndexClause(int keyword, int statement)
    {
        if (keyword < 0 || keyword <= statement) return;
        _m.Break(keyword);
        _m.AlignTo(keyword, statement, _tab);
    }
}
