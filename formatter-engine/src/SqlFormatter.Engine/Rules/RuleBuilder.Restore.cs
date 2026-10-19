using Microsoft.SqlServer.TransactSql.ScriptDom;
using SqlFormatter.Engine.Layout;
using SqlFormatter.Engine.Style;

namespace SqlFormatter.Engine.Rules;

// RESTORE … FROM … WITH MOVE … TO …: opzioni restoreStatements.moveTo (verificate con la CLI)
public sealed partial class RuleBuilder
{
    public override void ExplicitVisit(RestoreStatement node)
    {
        var o = _s.RestoreStatements.MoveTo;
        int restore = _m.FirstCode(node);
        // FROM e WITH a capo, allineati a RESTORE
        if (node.Devices.Count > 0)
        {
            int from = _m.FindBackward(_m.FirstCode(node.Devices[0]), restore, sl => sl.Token.TokenType == TSqlTokenType.From);
            if (from > restore)
            {
                _m.Break(from);
                _m.AlignTo(from, restore, 0);
            }
        }
        if (node.Options.Count > 0)
        {
            int first = OptionStart(node.Options[0]);
            int with = _m.PrevCode(first);
            if (with > restore && _m.Slots[with].Token.TokenType == TSqlTokenType.With)
            {
                _m.Break(with);
                _m.AlignTo(with, restore, 0);
            }
            // opzioni successive a capo, allineate alla prima (moveTo.placeOnNewLine)
            for (int i = 1; i < node.Options.Count; i++)
            {
                int start = OptionStart(node.Options[i]);
                if (o.PlaceOnNewLine) _m.Break(start);
                _m.AlignTo(start, first, 0);
            }
            foreach (var move in node.Options.OfType<MoveRestoreOption>())
            {
                int moveKw = OptionStart(move);
                int to = _m.PrevCode(_m.FirstCode(move.OSFileName));
                if (to < 0 || !o.PlaceToOnNewLine) continue;
                _m.Break(to);
                if (o.ToKeywordAlignment == MoveToAlignment.RightAlignedToMove) _m.AlignTo(to, moveKw, 0, AlignKind.Right);
                else _m.AlignTo(to, moveKw, 0);
            }
        }
        base.ExplicitVisit(node);
    }

    // l'intervallo di token di MOVE … TO … non include sempre la parola MOVE
    private int OptionStart(RestoreOption option)
    {
        int first = _m.FirstCode(option);
        int prev = _m.PrevCode(first);
        return prev >= 0 && _m.Slots[prev].Text.Equals("MOVE", StringComparison.OrdinalIgnoreCase) ? prev : first;
    }
}
