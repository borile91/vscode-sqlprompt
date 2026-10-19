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
        FixDataTypeParentheses();
        foreach (int close in _tableFunctionCloses)
        {
            int next = close + 1;
            if (next < _m.Count && _m.Slots[next].Token.TokenType == TSqlTokenType.RightParenthesis && _s.Parentheses.AddSpacesInsideParentheses)
                _m.SpaceBefore(next);
        }
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
            // GO seguito da un ; isolato: il ; va solo a capo
            if (next < _m.Count && _m.Slots[next].Token.TokenType == TSqlTokenType.Semicolon)
                _m.SetBreaks(next, 1);
            else if (next < _m.Count && !(_m.Slots[next].IsComment && _m.Slots[next].OriginalNewLinesBefore == 0))
                _m.SetBreaks(next, AfterBatchSeparator(next));
        }
    }

    // Dopo GO SQL Prompt conserva le righe vuote originali, qualunque sia emptyLinesAfterBatchSeparator;
    // senza preserveExistingEmptyLinesBetweenStatements ne garantisce almeno una (verificato con la CLI)
    private int AfterBatchSeparator(int slot)
    {
        int original = _m.Slots[slot].OriginalNewLinesBefore;
        return Math.Max(original, _s.Whitespace.NewLines.PreserveExistingEmptyLinesBetweenStatements ? 1 : 2);
    }

    private int BlankLines(int slot, int configured, bool preserve)
    {
        int original = _m.Slots[slot].OriginalNewLinesBefore;
        if (preserve) return Math.Max(original, 1);
        return configured + 1;
    }

    // primo token degli statement di primo livello (nei batch)
    private readonly HashSet<int> _topLevelStarts = [];

    private void ArrangeStatements(IList<TSqlStatement> list, int anchor, int offset)
    {
        TSqlStatement? prev = null;
        foreach (var st in list)
        {
            if (anchor < 0) _topLevelStarts.Add(_m.FirstCode(st));
            StatementStart(st, prev, anchor, offset);
            // whiteSpaceBeforeSemiColon = newLineBefore: il ; su una riga propria, sotto l'inizio dello statement
            int semi = _m.Last(st);
            if (_s.Whitespace.WhiteSpaceBeforeSemiColon == SemicolonWhitespace.NewLineBefore
                && semi > _m.FirstCode(st) && _m.Slots[semi].Token.TokenType == TSqlTokenType.Semicolon)
            {
                _m.Break(semi);
                _m.AlignTo(semi, _m.FirstCode(st), 0);
            }
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
        DropObjectsStatement => "drop",
        _ => null,
    };

    // Inizio di uno statement: a capo con le righe vuote richieste; l'a capo va al primo
    // commento che precede lo statement, se c'è
    private void StatementStart(TSqlStatement stmt, TSqlStatement? prevStmt, int anchor, int offset)
    {
        int first = _m.FirstCode(stmt);
        if (first < 0) return;
        int lead = first;
        // commenti su riga propria che precedono lo statement (anche in testa al file)
        while (lead - 1 >= 0 && _m.Slots[lead - 1].IsComment && (_m.Slots[lead - 1].OriginalNewLinesBefore > 0 || lead - 1 == 0)) lead--;
        if (lead > 0)
        {
            var prev = _m.Slots[lead - 1];
            var nl = _s.Whitespace.NewLines;
            // dopo BEGIN, GO o un'etichetta (ERRORE:) si va solo a capo
            bool afterBlockStart = prev.Token.TokenType is TSqlTokenType.Begin or TSqlTokenType.Go
                || prevStmt is LabelStatement;
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
            // gruppo di commenti su righe proprie, seguito dal codice
            int last = i;
            while (last + 1 < _m.Count && _m.Slots[last + 1].IsComment && _m.Slots[last + 1].OriginalNewLinesBefore > 0) last++;
            int next = last + 1;
            if (next < _m.Count && _m.Slots[next].IsComment) next = -1;
            var code = next >= 0 && next < _m.Count ? _m.Slots[next] : null;
            // a capo previsto per lo statement: sta sul primo commento (StatementStart) o sul codice
            int planned = Math.Max(_m.Slots[i].Breaks, code?.Breaks ?? 0);
            bool topLevel = next >= 0 && _topLevelStarts.Contains(next);
            // un commento su riga propria subito dopo un commento in coda lo prosegue: si allinea
            // a quel commento e le righe vuote previste vanno tra i commenti e il codice
            bool continuation = i > 0 && _m.Slots[i - 1].IsLineComment && _m.Slots[i - 1].OriginalNewLinesBefore == 0
                && _m.Slots[i].IsLineComment;
            // i commenti attaccati allo statement precedente e separati da una riga vuota da quelli
            // che seguono restano con il precedente: le righe vuote previste vanno prima del gruppo
            // di commenti che apre lo statement (regola osservata con la CLI)
            int leadStart = i;
            if (_m.Slots[i].OriginalNewLinesBefore <= 1)
                for (int k = last; k > i; k--)
                    if (_m.Slots[k].OriginalNewLinesBefore >= 2) { leadStart = k; break; }
            for (int k = i; k <= last; k++)
            {
                var ck = _m.Slots[k];
                if (k == 0) ck.Breaks = 0;
                else if (k == i && continuation) ck.Breaks = 1;
                else if (k == leadStart && !continuation) ck.Breaks = Math.Max(planned, Math.Clamp(ck.OriginalNewLinesBefore, 1, 2));
                else ck.Breaks = Math.Clamp(ck.OriginalNewLinesBefore, 1, 2);
                if (continuation)
                {
                    ck.Anchor = i - 1;
                    ck.Offset = 0;
                    ck.Align = AlignKind.Left;
                }
                else if (code != null)
                {
                    ck.Anchor = code.Anchor;
                    ck.Offset = code.Offset;
                    ck.Align = code.Align;
                }
            }
            // dopo i commenti il codice va a capo una volta sola, tranne davanti agli statement
            // di primo livello (es. intestazione prima di CREATE), dove le righe vuote restano
            if (code != null && code.OriginalNewLinesBefore > 0)
            {
                if (continuation) code.Breaks = Math.Max(planned, 1);
                else code.Breaks = topLevel ? Math.Min(code.OriginalNewLinesBefore, 2) : 1;
            }
            i = last;
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
