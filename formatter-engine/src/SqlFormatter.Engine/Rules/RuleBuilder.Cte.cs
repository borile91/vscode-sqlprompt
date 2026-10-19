using Microsoft.SqlServer.TransactSql.ScriptDom;
using SqlFormatter.Engine.Layout;
using SqlFormatter.Engine.Style;

namespace SqlFormatter.Engine.Rules;

// WITH nome (colonne) AS (query): opzioni cte.* (verificate con la CLI, una opzione per volta)
public sealed partial class RuleBuilder
{
    public override void ExplicitVisit(WithCtesAndXmlNamespaces node)
    {
        var o = _s.Cte;
        int with = _m.FirstCode(node);
        foreach (var cte in node.CommonTableExpressions)
        {
            int name = _m.FirstCode(cte.ExpressionName);
            if (name < 0) continue;
            if (o.PlaceNameOnNewLine)
            {
                _m.Break(name);
                _m.AlignTo(name, with, o.IndentName ? _tab : 0);
            }
            if (cte.Columns.Count > 0 && o.PlaceColumnsOnNewLine)
            {
                int cols = _m.PrevCode(_m.FirstCode(cte.Columns[0]));
                _m.Break(cols);
                AlignCtePart(cols, with, o.ColumnAlignment);
            }
            int open = _m.PrevCode(_m.FirstCode(cte.QueryExpression));
            int close = _m.NextCode(_m.Last(cte.QueryExpression));
            int asKw = _m.PrevCode(open);
            if (open < 0 || close < 0 || asKw < 0) continue;
            if (o.PlaceAsOnNewLine)
            {
                _m.Break(asKw);
                AlignCtePart(asKw, with, o.AsAlignment);
            }
            ArrangeParenthesesAfter(open, close, asKw, with, o.ParenthesisStyle, o.IndentContents);
            // nome rientrato: la "(" che segue AS si allinea al nome (verificato con la CLI)
            if (o.PlaceNameOnNewLine && o.IndentName && o.ParenthesisStyle == ParenthesisStyle.CompactSimple)
            {
                _m.AlignTo(open, name, 0);
                _m.Slots[open].PadInline = true;
            }
        }
        // la query principale riparte dalla colonna di WITH
        int main = _m.NextCode(_m.Last(node));
        if (main >= 0)
        {
            _m.Break(main);
            _m.AlignTo(main, with, 0);
        }
        base.ExplicitVisit(node);
    }

    private void AlignCtePart(int slot, int with, CteAlignment alignment)
    {
        switch (alignment)
        {
            case CteAlignment.Indented: _m.AlignTo(slot, with, _tab); break;
            case CteAlignment.RightAligned: _m.AlignTo(slot, with, 0, AlignKind.Right); break;
            default: _m.AlignTo(slot, with, 0); break;
        }
    }
}
