using Microsoft.SqlServer.TransactSql.ScriptDom;
using SqlFormatter.Engine.Layout;
using SqlFormatter.Engine.Style;

namespace SqlFormatter.Engine.Rules;

// MERGE, clausola OUTPUT, tabelle ( VALUES … ) (modello: output della CLI sugli script reali)
public sealed partial class RuleBuilder
{
    // MERGE INTO t USING s ON … WHEN … THEN …: USING, ON e WHEN sotto MERGE
    public override void ExplicitVisit(MergeSpecification node)
    {
        int merge = _m.FirstCode(node);
        if (node.TableReference != null)
        {
            int @using = _m.FindBackward(_m.FirstCode(node.TableReference), merge, sl => sl.Text.Equals("USING", StringComparison.OrdinalIgnoreCase));
            if (@using > merge) MergeClause(@using, merge);
        }
        if (node.SearchCondition != null)
        {
            int on = _m.FindBackward(_m.FirstCode(node.SearchCondition), merge, sl => sl.Token.TokenType == TSqlTokenType.On);
            if (on > merge) MergeClause(on, merge);
        }
        foreach (var clause in node.ActionClauses)
        {
            // l'intervallo della clausola non comprende sempre WHEN
            int when = _m.FindBackward(_m.FirstCode(clause), merge, sl => sl.Text.Equals("WHEN", StringComparison.OrdinalIgnoreCase));
            if (when <= merge) continue;
            MergeClause(when, merge);
            // l'azione segue THEN; se la riga è troppo lunga va a capo, rientrata da WHEN
            int action = _m.FirstCode(clause.Action);
            if (action > when)
            {
                _m.AlignTo(action, when, _tab);
                _m.AddGroup(BreakMode.IfLong, action, _m.Last(clause.Action), [action]).OnlyIfTooLong = true;
            }
            switch (clause.Action)
            {
                case UpdateMergeAction update when update.SetClauses.Count > 0:
                    int set = _m.PrevCode(_m.FirstCode(update.SetClauses[0]));
                    ArrangeList(set, update.SetClauses, NewLineMode.Never, _s.Lists.PlaceSubsequentItemsOnNewLines);
                    break;
                case InsertMergeAction insert:
                    // colonne sempre compatte, VALUES sotto INSERT
                    if (insert.Columns.Count > 0)
                    {
                        int open = _m.PrevCode(_m.FirstCode(insert.Columns[0]));
                        int close = _m.NextCode(_m.Last(insert.Columns[^1]));
                        ArrangeParenthesesAfter(open, close, action, action, ParenthesisStyle.CompactSimple, false);
                        ArrangeList(open, insert.Columns, NewLineMode.Never, _s.InsertStatements.Columns.PlaceSubsequentColumnsOnNewLines);
                    }
                    if (insert.Source is ValuesInsertSource values) ArrangeInsertValues(action, values);
                    break;
            }
        }
        ArrangeOutput(node.OutputClause, node.OutputIntoClause, merge);
        _queryStarts.Push(merge);
        base.ExplicitVisit(node);
        _queryStarts.Pop();
    }

    private void MergeClause(int keyword, int merge)
    {
        _m.Break(keyword);
        _m.AlignTo(keyword, merge, 0);
    }

    // OUTPUT elenco [INTO destinazione]: una clausola come le altre, con l'elenco come una lista
    private void ArrangeOutput(OutputClause? output, OutputIntoClause? outputInto, int statement)
    {
        if (output != null && output.SelectColumns.Count > 0)
        {
            int kw = _m.FirstCode(output);
            Clause(kw, statement);
            ArrangeList(kw, output.SelectColumns, _s.Lists.PlaceFirstItemOnNewLine, _s.Lists.PlaceSubsequentItemsOnNewLines);
        }
        if (outputInto != null && outputInto.SelectColumns.Count > 0)
        {
            int kw = _m.FirstCode(outputInto);
            Clause(kw, statement);
            ArrangeList(kw, outputInto.SelectColumns, _s.Lists.PlaceFirstItemOnNewLine, _s.Lists.PlaceSubsequentItemsOnNewLines);
            if (outputInto.IntoTable != null)
            {
                int into = _m.PrevCode(_m.FirstCode(outputInto.IntoTable));
                if (into > kw) Clause(into, statement);
                if (outputInto.IntoTableColumns.Count > 0)
                {
                    int open = _m.PrevCode(_m.FirstCode(outputInto.IntoTableColumns[0]));
                    ArrangeList(open, outputInto.IntoTableColumns, NewLineMode.Never, _s.InsertStatements.Columns.PlaceSubsequentColumnsOnNewLines);
                }
            }
        }
    }

    public override void ExplicitVisit(DeleteSpecification node)
    {
        ArrangeOutput(node.OutputClause, node.OutputIntoClause, _m.FirstCode(node));
        VisitDelete(node);
    }

    public override void ExplicitVisit(UpdateSpecification node)
    {
        ArrangeOutput(node.OutputClause, node.OutputIntoClause, _m.FirstCode(node));
        VisitUpdate(node);
    }

    public override void ExplicitVisit(InsertSpecification node)
    {
        ArrangeOutput(node.OutputClause, node.OutputIntoClause, _m.FirstCode(node));
        VisitInsert(node);
    }

    // FROM ( VALUES ( … ), ( … ) ) AS x: le righe come gli elementi di una lista
    public override void ExplicitVisit(InlineDerivedTable node)
    {
        if (node.RowValues.Count > 1)
        {
            int values = _m.PrevCode(_m.PrevCode(_m.FirstCode(node.RowValues[0].ColumnValues.FirstOrDefault() ?? (TSqlFragment)node.RowValues[0])));
            if (values >= 0 && _m.Slots[values].Text.Equals("VALUES", StringComparison.OrdinalIgnoreCase))
                ArrangeList(values, node.RowValues, NewLineMode.Never, _s.Lists.PlaceSubsequentItemsOnNewLines);
        }
        base.ExplicitVisit(node);
    }
}
