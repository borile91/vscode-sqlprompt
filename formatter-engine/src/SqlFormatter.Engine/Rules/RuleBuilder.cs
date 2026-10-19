using Microsoft.SqlServer.TransactSql.ScriptDom;
using SqlFormatter.Engine.Layout;
using SqlFormatter.Engine.Style;

namespace SqlFormatter.Engine.Rules;

// Visita l'AST di ScriptDom e traduce le opzioni di stile in regole sul modello di layout.
// I genitori vengono visitati prima dei figli: un figlio può sovrascrivere le regole
// (ancore, a capo) che il genitore ha impostato sul proprio intervallo di token.
public sealed partial class RuleBuilder : TSqlFragmentVisitor
{
    private readonly LayoutModel _m;
    private readonly FormattingStyle _s;
    private readonly int _tab;

    public RuleBuilder(LayoutModel model, FormattingStyle style)
    {
        _m = model;
        _s = style;
        _tab = Math.Max(1, style.Whitespace.NumberOfSpacesInTabs);
    }

    public void Build(TSqlScript script)
    {
        Spacing.Apply(_m, _s);
        script.Accept(this);
        Spacing.FixCallParentheses(_m, _s);
        ArrangeBatches(script);
        ArrangeComments();
    }

    // ---- statement e batch ----

    private void ArrangeBatches(TSqlScript script)
    {
        var nl = _s.Whitespace.NewLines;
        // ogni GO su una riga propria, statement successivi separati dalle righe vuote richieste
        for (int i = 0; i < _m.Count; i++)
        {
            if (_m.Slots[i].Token.TokenType != TSqlTokenType.Go) continue;
            _m.Break(i);
            _m.AlignTo(i, -1);
            int next = i + 1;
            if (next < _m.Count && !(_m.Slots[next].IsComment && _m.Slots[next].OriginalNewLinesBefore == 0))
                _m.SetBreaks(next, BlankLines(next, nl.EmptyLinesAfterBatchSeparator, nl.PreserveExistingEmptyLinesAfterBatchSeparator));
        }
    }

    private int BlankLines(int slot, int configured, bool preserve)
    {
        int original = _m.Slots[slot].OriginalNewLinesBefore;
        if (preserve) return Math.Max(original, 1);
        return configured + 1;
    }

    private void ArrangeStatements(IList<TSqlStatement> list, int anchor, int offset)
    {
        TSqlStatement? prev = null;
        foreach (var st in list)
        {
            StatementStart(st, prev, anchor, offset);
            prev = st;
        }
    }

    // Statement brevi che, se consecutivi dello stesso gruppo, restano senza righe vuote tra loro
    private static string? GroupKey(TSqlStatement s) => s switch
    {
        DeclareVariableStatement => "declare",
        SetVariableStatement => "set",
        PrintStatement => "print",
        CloseCursorStatement or DeallocateCursorStatement => "cursor-close",
        _ => null,
    };

    // Inizio di uno statement: a capo con le righe vuote richieste; l'a capo va al primo
    // commento che precede lo statement, se c'è
    private void StatementStart(TSqlStatement stmt, TSqlStatement? prevStmt, int anchor, int offset)
    {
        int first = _m.FirstCode(stmt);
        if (first < 0) return;
        int lead = first;
        while (lead - 1 >= 0 && _m.Slots[lead - 1].IsComment && _m.Slots[lead - 1].OriginalNewLinesBefore > 0) lead--;
        if (lead > 0)
        {
            var prev = _m.Slots[lead - 1];
            var nl = _s.Whitespace.NewLines;
            bool afterBlockStart = prev.Token.TokenType is TSqlTokenType.Begin or TSqlTokenType.Go;
            bool grouped = prevStmt != null && GroupKey(stmt) != null && GroupKey(stmt) == GroupKey(prevStmt)
                && !nl.PreserveExistingEmptyLinesBetweenStatements;
            // primo statement di un blocco (BEGIN, BEGIN TRY, corpo di procedura): nessuna riga vuota
            bool firstInBlock = prevStmt == null && anchor >= 0;
            int lines = afterBlockStart || grouped || firstInBlock ? 1 : BlankLines(lead, nl.EmptyLinesBetweenStatements, nl.PreserveExistingEmptyLinesBetweenStatements);
            if (prev.Token.TokenType == TSqlTokenType.Go) lines = Math.Max(lines, _m.Slots[lead].Breaks);
            _m.SetBreaks(lead, lines);
        }
        // tutto lo statement parte dalla colonna dell'ancora; i provider dei figli precisano
        for (int i = lead; i <= _m.Last(stmt); i++)
        {
            if (i == anchor) continue;
            _m.Slots[i].Anchor = anchor;
            _m.Slots[i].Offset = offset;
        }
    }

    public override void ExplicitVisit(TSqlBatch node)
    {
        ArrangeStatements(node.Statements, -1, 0);
        base.ExplicitVisit(node);
    }

    // ---- commenti ----

    // Un commento su riga propria si allinea al codice che segue e prende l'a capo
    // destinato a quel codice; un commento in coda resta sulla riga del codice precedente
    private void ArrangeComments()
    {
        // commenti in coda dentro la stessa lista: incolonnati dopo l'elemento più lungo
        // (lists.alignComments); vale la lista più interna che contiene il commento
        if (_s.Lists.AlignComments)
        {
            var byList = new Dictionary<(int, int), List<int>>();
            for (int i = 1; i < _m.Count; i++)
            {
                var c = _m.Slots[i];
                if (!c.IsLineComment || c.OriginalNewLinesBefore > 0) continue;
                var inner = _listRanges.Where(r => r.First <= i && i <= r.Last)
                    .OrderBy(r => r.Last - r.First).Cast<(int First, int Last)?>().FirstOrDefault();
                if (inner == null) continue;
                if (!byList.TryGetValue(inner.Value, out var list)) byList[inner.Value] = list = [];
                list.Add(i);
            }
            foreach (var group in byList.Values) _m.AddAlignGroup(group);
        }

        for (int i = 0; i < _m.Count; i++)
        {
            var c = _m.Slots[i];
            if (!c.IsComment) continue;
            if (c.OriginalNewLinesBefore == 0 && i > 0)
            {
                c.Breaks = 0;
                c.SpaceBefore = true;
                continue;
            }
            int next = i;
            while (next < _m.Count && _m.Slots[next].IsComment) next++;
            if (next >= _m.Count)
            {
                c.Breaks = Math.Max(c.Breaks, Math.Min(c.OriginalNewLinesBefore, 2));
                continue;
            }
            var code = _m.Slots[next];
            if (i > 0)
            {
                // l'a capo previsto per il codice passa al primo commento del gruppo
                int lines = Math.Max(c.Breaks, Math.Max(code.Breaks, 1));
                if (code.Breaks == 0) lines = Math.Min(Math.Max(c.OriginalNewLinesBefore, 1), 2);
                c.Breaks = lines;
                if (code.OriginalNewLinesBefore > 0) code.Breaks = Math.Min(code.OriginalNewLinesBefore, 2);
            }
            c.Anchor = code.Anchor;
            c.Offset = code.Offset;
            c.Align = code.Align;
        }
    }

    // intervalli delle liste (dal primo elemento al commento in coda dopo l'ultimo)
    private readonly List<(int First, int Last)> _listRanges = [];

    // ---- utilità ----

    private int Width => _s.Whitespace.WrapLongLines ? _s.Whitespace.WrapLinesLongerThan : int.MaxValue;

    private static BreakMode Mode(NewLineMode mode) => mode switch
    {
        NewLineMode.Always => BreakMode.Always,
        NewLineMode.Never => BreakMode.Wrap,
        NewLineMode.IfLongerThanMaxLineLength => BreakMode.IfLong,
        _ => BreakMode.IfLongOrMultiple,
    };

    // Parola chiave che precede il frammento (es. il WHERE prima della condizione)
    private int KeywordBefore(TSqlFragment f) => _m.PrevCode(_m.FirstCode(f));
}
