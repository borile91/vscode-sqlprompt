using Microsoft.SqlServer.TransactSql.ScriptDom;

namespace SqlFormatter.Engine.Layout;

// Regole di layout raccolte dai provider e lette dal risolutore.
// Ogni token significativo (non spazio) ha un indice "slot" 0..N-1; le regole lavorano sugli slot.

public enum BreakMode
{
    // a capo su ogni punto
    Always,
    // a capo su tutti i punti se l'intervallo non sta nella larghezza massima
    IfLong,
    // a capo se più di un elemento, altrimenti come IfLong
    IfLongOrMultiple,
    // a capo su un punto solo se il pezzo che segue non sta più nella riga (riempimento)
    Wrap,
    Never,
}

public enum AlignKind { Left, Right }

public sealed class Slot
{
    public required TSqlParserToken Token { get; init; }
    public required int StreamIndex { get; init; }
    public string Text { get; set; } = "";

    // a capo forzati prima del token (0 = stessa riga)
    public int Breaks { get; set; }
    // righe vuote originali prima del token (per le opzioni preserveExisting*)
    public int OriginalNewLinesBefore { get; set; }
    public bool SpaceBefore { get; set; } = true;

    // colonna quando il token apre una riga: colonna(Anchor) + Offset
    public int Anchor { get; set; } = -1;
    public int Offset { get; set; }
    public AlignKind Align { get; set; } = AlignKind.Left;

    public bool IsComment => Token.TokenType is TSqlTokenType.SingleLineComment or TSqlTokenType.MultilineComment;
    public bool IsLineComment => Token.TokenType == TSqlTokenType.SingleLineComment;
}

public sealed class BreakGroup
{
    public required BreakMode Mode { get; init; }
    public required int First { get; init; }
    public required int Last { get; init; }
    public List<int> Points { get; } = [];
    public int ItemCount { get; init; }
    // primo token del primo elemento (per riconoscere elementi su più righe)
    public int ContentStart { get; set; } = -1;
    public bool Broken { get; set; }
}

public sealed class CollapseRange
{
    public required int First { get; init; }
    public required int Last { get; init; }
    public required int MaxLength { get; init; }
    public bool Collapsed { get; set; }
}

public sealed class LayoutModel
{
    private readonly Dictionary<int, int> _streamToSlot = new();

    public List<Slot> Slots { get; } = [];
    public List<BreakGroup> Groups { get; } = [];
    public List<CollapseRange> Collapses { get; } = [];
    // Token che, quando restano sulla riga del token precedente, si allineano alla stessa colonna
    // (la massima tra le loro colonne naturali): elementi dopo le parole chiave, alias, tipi di dato
    public List<List<int>> AlignGroups { get; } = [];
    // per ogni gruppo, token la cui fine (+1 spazio) entra nel calcolo della colonna comune
    // senza essere spostati (es. tipi di dato delle DECLARE senza valore)
    public Dictionary<List<int>, List<int>> AlignGroupEnds { get; } = new();
    public IList<TSqlParserToken> Stream { get; }

    public LayoutModel(IList<TSqlParserToken> stream)
    {
        Stream = stream;
        int newLines = 0;
        for (int i = 0; i < stream.Count; i++)
        {
            var t = stream[i];
            if (t.TokenType == TSqlTokenType.WhiteSpace)
            {
                newLines += CountNewLines(t.Text);
                continue;
            }
            if (t.TokenType == TSqlTokenType.EndOfFile)
                continue;
            _streamToSlot[i] = Slots.Count;
            string text = t.Text;
            int trailingNewLines = 0;
            // con fine riga LF il commento di riga ScriptDom include il \n: va tolto dal testo
            // e contato come a capo prima del token successivo
            if (t.TokenType == TSqlTokenType.SingleLineComment)
            {
                trailingNewLines = CountNewLines(text);
                text = text.TrimEnd('\r', '\n');
            }
            Slots.Add(new Slot { Token = t, StreamIndex = i, Text = text, OriginalNewLinesBefore = newLines });
            newLines = trailingNewLines;
        }
    }

    public int Count => Slots.Count;

    // Slot del primo token significativo con indice di stream >= streamIndex
    public int SlotAtOrAfter(int streamIndex)
    {
        for (int i = streamIndex; i < Stream.Count; i++)
            if (_streamToSlot.TryGetValue(i, out int s)) return s;
        return -1;
    }

    // Slot dell'ultimo token significativo con indice di stream <= streamIndex
    public int SlotAtOrBefore(int streamIndex)
    {
        for (int i = streamIndex; i >= 0; i--)
            if (_streamToSlot.TryGetValue(i, out int s)) return s;
        return -1;
    }

    public int First(TSqlFragment f) => SlotAtOrAfter(f.FirstTokenIndex);
    public int Last(TSqlFragment f) => SlotAtOrBefore(f.LastTokenIndex);

    // Primo token non commento del frammento
    public int FirstCode(TSqlFragment f)
    {
        int s = First(f);
        while (s >= 0 && s <= Last(f) && Slots[s].IsComment) s++;
        return s;
    }

    public int FindForward(int from, int to, Func<Slot, bool> match)
    {
        for (int i = Math.Max(from, 0); i <= to && i < Count; i++)
            if (match(Slots[i])) return i;
        return -1;
    }

    public int FindForward(int from, int to, TSqlTokenType type) => FindForward(from, to, s => s.Token.TokenType == type);

    public int FindBackward(int from, int to, Func<Slot, bool> match)
    {
        for (int i = Math.Min(from, Count - 1); i >= to && i >= 0; i--)
            if (match(Slots[i])) return i;
        return -1;
    }

    // Slot precedente non commento
    public int PrevCode(int slot)
    {
        int i = slot - 1;
        while (i >= 0 && Slots[i].IsComment) i--;
        return i;
    }

    public int NextCode(int slot)
    {
        int i = slot + 1;
        while (i < Count && Slots[i].IsComment) i++;
        return i < Count ? i : -1;
    }

    public void Break(int slot, int lines = 1)
    {
        if (slot < 0) return;
        Slots[slot].Breaks = Math.Max(Slots[slot].Breaks, lines);
    }

    public void SetBreaks(int slot, int lines)
    {
        if (slot >= 0) Slots[slot].Breaks = lines;
    }

    // Allinea un singolo token (se apre una riga) all'ancora
    public void AlignTo(int slot, int anchor, int offset = 0, AlignKind kind = AlignKind.Left)
    {
        if (slot < 0 || anchor < 0) return;
        var s = Slots[slot];
        s.Anchor = anchor;
        s.Offset = offset;
        s.Align = kind;
    }

    // Allinea all'ancora tutti i token dell'intervallo [first, last]; i frammenti figli
    // visitati dopo possono sovrascrivere i propri sotto-intervalli
    public void AlignRange(int first, int last, int anchor, int offset)
    {
        if (first < 0 || anchor < 0) return;
        for (int i = first; i <= last && i < Count; i++)
        {
            if (i == anchor) continue;
            Slots[i].Anchor = anchor;
            Slots[i].Offset = offset;
            Slots[i].Align = AlignKind.Left;
        }
    }

    public BreakGroup AddGroup(BreakMode mode, int first, int last, IEnumerable<int> points, int itemCount = 0)
    {
        var g = new BreakGroup { Mode = mode, First = first, Last = last, ItemCount = itemCount };
        g.Points.AddRange(points.Where(p => p >= 0));
        if (mode != BreakMode.Never && g.Points.Count > 0) Groups.Add(g);
        return g;
    }

    public void AddCollapse(int first, int last, int maxLength)
    {
        if (first >= 0 && last > first)
            Collapses.Add(new CollapseRange { First = first, Last = last, MaxLength = maxLength });
    }

    public void AddAlignGroup(IEnumerable<int> slots, IEnumerable<int>? ends = null)
    {
        var list = slots.Where(x => x >= 0).Distinct().ToList();
        var endList = ends?.Where(x => x >= 0).ToList() ?? [];
        if (list.Count + endList.Count < 2 || list.Count == 0) return;
        AlignGroups.Add(list);
        if (endList.Count > 0) AlignGroupEnds[list] = endList;
    }

    public void NoSpaceBefore(int slot)
    {
        if (slot >= 0) Slots[slot].SpaceBefore = false;
    }

    public void SpaceBefore(int slot)
    {
        if (slot >= 0) Slots[slot].SpaceBefore = true;
    }

    private static int CountNewLines(string text)
    {
        int n = 0;
        foreach (char c in text) if (c == '\n') n++;
        return n;
    }
}
