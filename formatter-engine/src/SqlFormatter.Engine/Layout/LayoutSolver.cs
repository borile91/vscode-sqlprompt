using System.Text;
using SqlFormatter.Engine.Style;

namespace SqlFormatter.Engine.Layout;

// Trasforma le regole del modello in testo:
// 1. a capo obbligatori (dopo i commenti di riga, gruppi Always);
// 2. intervalli compattati se corti (dall'esterno verso l'interno);
// 3. gruppi IfLong spezzati uno alla volta, dal più esterno, finché tutto sta nella larghezza;
// 4. stampa con indentazione calcolata dalle ancore.
public sealed class LayoutSolver
{
    private readonly LayoutModel _m;
    private readonly FormattingStyle _style;
    // larghezza per le scelte "se più lunga del massimo"
    private readonly int _width;
    // larghezza per il riempimento, attivo solo con wrapLongLines
    private readonly int _wrapWidth;
    private readonly bool[] _collapsedInside;
    private readonly int[] _groupBreaks;
    // punti di riempimento: lunghezza del pezzo che inizia nel punto (fino al punto successivo)
    private readonly int[] _wrapSegment;
    private readonly bool[] _wrapBreak;
    // punti di riempimento spezzati perché il pezzo, su più righe, sfora il limite
    private readonly bool[] _wrapForced;
    private readonly List<(int Point, int Last)> _wrapRanges = [];
    private int[] _col = [];
    private int[] _end = [];
    private int[] _line = [];

    public LayoutSolver(LayoutModel model, FormattingStyle style)
    {
        _m = model;
        _style = style;
        _width = style.Whitespace.WrapLongLines ? style.Whitespace.WrapLinesLongerThan : int.MaxValue;
        _wrapWidth = style.Whitespace.WrapLongLines ? style.Whitespace.WrapLinesLongerThan : int.MaxValue;
        _collapsedInside = new bool[model.Count];
        _groupBreaks = new int[model.Count];
        _wrapSegment = new int[model.Count];
        _wrapBreak = new bool[model.Count];
        _wrapForced = new bool[model.Count];
    }

    public string Render(string newLine)
    {
        Solve();
        var sb = new StringBuilder();
        for (int i = 0; i < _m.Count; i++)
        {
            var s = _m.Slots[i];
            int b = EffectiveBreaks(i);
            if (i > 0 && b > 0)
            {
                for (int k = 0; k < b; k++) sb.Append(newLine);
                sb.Append(Indent(_col[i]));
            }
            else if (i > 0 && _col[i] > _end[i - 1])
            {
                sb.Append(' ', _col[i] - _end[i - 1]);
            }
            else if (i == 0)
            {
                sb.Append(Indent(_col[i]));
            }
            string text = s.Token.TokenType != Microsoft.SqlServer.TransactSql.ScriptDom.TSqlTokenType.MultilineComment ? s.Text
                : _style.Whitespace.NewLines.AlignMultilineCommentsMatchingPatterns && StarredComment(s.Text)
                    ? AlignContinuationLines(s.Text, _col[i])
                    : ShiftContinuationLines(s.Text, _col[i] - (s.Token.Column - 1));
            sb.Append(NormalizeNewLines(text, newLine));
        }
        return sb.ToString();
    }

    private void Solve()
    {
        // dopo un commento di riga si va sempre a capo
        for (int i = 0; i + 1 < _m.Count; i++)
            if (_m.Slots[i].IsLineComment) _m.Break(i + 1);

        DecideCollapses();

        foreach (var g in _m.Groups)
        {
            if (g.Mode == BreakMode.Always || (g.Mode == BreakMode.IfLongOrMultiple && g.ItemCount > 1))
                ApplyGroup(g);
        }

        PrepareWraps();

        // gruppi condizionati alla lunghezza: dall'esterno verso l'interno
        var pending = _m.Groups
            .Where(g => !g.Broken && g.Mode is BreakMode.IfLong or BreakMode.IfLongOrMultiple)
            .OrderBy(g => g.First).ThenByDescending(g => g.Last)
            .ToList();
        ComputeColumns();
        // Ciclo dall'esterno verso l'interno: a ogni passo si corregge la prima violazione
        // (per posizione) tra intervalli compattati troppo lunghi, gruppi da spezzare e
        // pezzi di riempimento con righe oltre il limite; poi si ricalcola
        while (true)
        {
            var candidates = new List<(int First, int Last, Action Fix)>();
            foreach (var c in _m.Collapses.Where(c => c.Collapsed))
                if (_end[c.Last] > c.MaxLength)
                    candidates.Add((c.First, c.Last, () => Uncollapse(c)));
            foreach (var g in pending)
            {
                if (g.Broken || g.Points.All(p => _collapsedInside[p])) continue;
                // un commento di riga dentro il gruppo obbliga comunque ad andare a capo
                if (Exceeds(g.First, g.Last) || HasLineComment(g.First, g.Last - 1) || SpansLines(g))
                    candidates.Add((g.First, g.Last, () => ApplyGroup(g)));
            }
            foreach (var (p, last) in _wrapRanges)
            {
                if (_wrapForced[p] || _collapsedInside[p] || EffectiveBreaks(p) > 0) continue;
                if (ExceedsWrap(p, last))
                    candidates.Add((p, last, () => _wrapForced[p] = true));
            }
            if (candidates.Count == 0) break;
            candidates.OrderBy(c => c.First).ThenByDescending(c => c.Last).First().Fix();
            ComputeColumns();
        }
    }

    // Riapre un intervallo e rivaluta quelli che contiene, rimasti in sospeso finché era chiuso
    // Un gruppo "se lungo" va a capo anche se uno dei suoi elementi occupa già più righe
    private bool SpansLines(BreakGroup g)
    {
        if (g.Mode != BreakMode.IfLong) return false;
        // a capo interni agli elementi: cambi di riga che non cadono su un punto del gruppo
        // (si parte dal primo elemento: l'a capo dopo la parola chiave non conta)
        int start = g.ContentStart >= 0 ? g.ContentStart : g.First + 1;
        while (start <= g.Last && _m.Slots[start].IsComment) start++;
        for (int i = start + 1; i <= g.Last; i++)
            if (_line[i] != _line[i - 1] && !g.Points.Contains(i)) return true;
        return false;
    }

    private void Uncollapse(CollapseRange c)
    {
        c.Collapsed = false;
        _rejected.Add(c);
        // stesso intervallo con un'altra soglia: va riaperto anche quello
        foreach (var same in _m.Collapses.Where(x => x.First == c.First && x.Last == c.Last))
        {
            same.Collapsed = false;
            _rejected.Add(same);
        }
        for (int i = c.First + 1; i <= c.Last; i++) _collapsedInside[i] = false;
        foreach (var inner in _m.Collapses.Where(x => x.Collapsed && x.First >= c.First && x.Last <= c.Last))
            for (int i = inner.First + 1; i <= inner.Last; i++) _collapsedInside[i] = true;
        DecideCollapses(c.First, c.Last);
    }

    private bool ExceedsWrap(int first, int last)
    {
        for (int i = first; i <= last; i++)
            if (_end[i] > _wrapWidth) return true;
        return false;
    }

    private void PrepareWraps()
    {
        foreach (var g in _m.Groups.Where(g => g.Mode == BreakMode.Wrap))
        {
            var pts = g.Points.Where(p => p >= g.First && p <= g.Last).OrderBy(p => p).ToList();
            for (int k = 0; k < pts.Count; k++)
            {
                int end = k + 1 < pts.Count ? pts[k + 1] - 1 : g.Last;
                // la virgola che chiude il pezzo resta sulla riga
                if (end + 1 < _m.Count && end + 1 <= g.Last + 1 && _m.Slots[Math.Min(end + 1, _m.Count - 1)].Token.TokenType == Microsoft.SqlServer.TransactSql.ScriptDom.TSqlTokenType.Comma)
                    end++;
                // un pezzo che non starebbe comunque in una riga intera non si sposta (come SQL Prompt)
                int flat = FlatLength(pts[k], Math.Min(end, _m.Count - 1));
                _wrapRanges.Add((pts[k], Math.Min(end, _m.Count - 1)));
                _wrapSegment[pts[k]] = flat > _wrapWidth ? 0 : Math.Max(_wrapSegment[pts[k]], flat);
            }
        }
    }

    private void ApplyGroup(BreakGroup g)
    {
        g.Broken = true;
        foreach (int p in g.Points) _groupBreaks[p] = Math.Max(_groupBreaks[p], 1);
    }

    // intervalli riaperti perché troppo lunghi sulla riga: non si compattano più
    private readonly HashSet<CollapseRange> _rejected = [];

    private void DecideCollapses(int from = 0, int to = int.MaxValue)
    {
        foreach (var c in _m.Collapses.OrderBy(c => c.First).ThenByDescending(c => c.Last))
        {
            if (c.First < from || c.Last > to || c.Collapsed || _rejected.Contains(c)) continue;
            if (_collapsedInside[c.First]) continue;
            if (HasLineComment(c.First, c.Last - 1)) continue;
            if (FlatLength(c.First, c.Last) >= c.MaxLength) continue;
            c.Collapsed = true;
            for (int i = c.First + 1; i <= c.Last; i++) _collapsedInside[i] = true;
        }
    }

    private bool HasLineComment(int first, int last)
    {
        for (int i = first; i <= last; i++)
            if (_m.Slots[i].IsLineComment) return true;
        return false;
    }

    // Lunghezza dell'intervallo stampato su una sola riga
    private int FlatLength(int first, int last)
    {
        int len = 0;
        for (int i = first; i <= last; i++)
        {
            if (i > first && _m.Slots[i].SpaceBefore) len++;
            len += _m.Slots[i].Text.Length;
        }
        return len;
    }

    // Lunghezza del pezzo fino al primo a capo già deciso al suo interno: un elemento su più
    // righe conta solo per la sua prima riga
    private int FirstLineLength(int first, int last)
    {
        int len = 0;
        for (int i = first; i <= last; i++)
        {
            if (i > first && EffectiveBreaks(i) > 0) break;
            if (i > first && _m.Slots[i].SpaceBefore) len++;
            len += _m.Slots[i].Text.Length;
        }
        return len;
    }

    private int EffectiveBreaks(int i)
    {
        if (i == 0) return 0;
        var s = _m.Slots[i];
        if (_m.Slots[i - 1].IsLineComment) return Math.Max(1, s.Breaks);
        if (_collapsedInside[i]) return 0;
        return Math.Max(Math.Max(s.Breaks, _groupBreaks[i]), _wrapBreak[i] || _wrapForced[i] ? 1 : 0);
    }

    // Colonne di tutti i token; i gruppi di allineamento verticale richiedono qualche iterazione
    // perché spostare un token sposta anche quelli che seguono sulla stessa riga
    private void ComputeColumns()
    {
        int n = _m.Count;
        var padTo = new int[n];
        _followsGroup = new bool[n];
        foreach (var g in _m.FollowingGroups)
            foreach (int x in g) _followsGroup[x] = true;
        for (int iter = 0; iter < 50; iter++)
        {
            ComputeColumnsOnce(padTo);
            bool changed = false;
            foreach (var g in _m.AlignGroups)
            {
                // si allinea in colonna solo se ogni membro sta su una riga diversa
                if (g.Select(x => _line[x]).Distinct().Count() != g.Count) continue;
                bool following = _m.FollowingGroups.Contains(g);
                int max = 0;
                foreach (int x in g)
                    if (!following || EffectiveBreaks(x) == 0) max = Math.Max(max, _col[x]);
                if (following)
                {
                    if (max == 0) continue;
                    // colonna comune arrotondata alla tabulazione successiva (lists.alignItemsToTabStops)
                    int tab = Math.Max(1, _style.Whitespace.NumberOfSpacesInTabs);
                    if (_style.Lists.AlignItemsToTabStops && max % tab != 0) max = (max / tab + 1) * tab;
                    foreach (int x in g)
                    {
                        if (EffectiveBreaks(x) == 0 || padTo[x] == max) continue;
                        padTo[x] = max;
                        changed = true;
                    }
                }
                if (_m.AlignGroupEnds.TryGetValue(g, out var ends))
                {
                    var memberLines = g.Select(x => _line[x]).ToHashSet();
                    if (ends.Any(e => memberLines.Contains(_line[e]))) continue;
                    foreach (int e in ends) max = Math.Max(max, _end[e]);
                }
                foreach (int x in g)
                {
                    if (EffectiveBreaks(x) > 0 || padTo[x] == max) continue;
                    if (padTo[x] < max) { padTo[x] = max; changed = true; }
                }
            }
            if (!changed) break;
        }
    }

    // membri di gruppi "a seguire" (vedi LayoutModel.FollowingGroups)
    private bool[] _followsGroup = [];

    private void ComputeColumnsOnce(int[] padTo)
    {
        int n = _m.Count;
        _col = new int[n];
        _end = new int[n];
        _line = new int[n];
        int line = 0;
        Array.Clear(_wrapBreak);
        for (int i = 0; i < n; i++)
        {
            var s = _m.Slots[i];
            int col;
            if (i > 0 && _wrapSegment[i] > 0 && !_collapsedInside[i] && EffectiveBreaks(i) == 0
                && _end[i - 1] + 1 + _wrapSegment[i] > _wrapWidth)
                _wrapBreak[i] = true;
            if (i > 0) line += EffectiveBreaks(i) + CountNewLines(_m.Slots[i - 1].Text);
            _line[i] = line;
            if (i == 0 || EffectiveBreaks(i) > 0)
                col = _followsGroup[i] && padTo[i] > 0 ? padTo[i] : IndentColumn(i);
            else
                col = Math.Max(Math.Max(_end[i - 1] + (s.SpaceBefore ? 1 : 0), padTo[i]),
                    s.PadInline ? IndentColumn(i) : 0);
            _col[i] = col;
            int nl = s.Text.LastIndexOf('\n');
            _end[i] = nl < 0 ? col + s.Text.Length : s.Text.Length - nl - 1;
        }
    }

    private int IndentColumn(int i)
    {
        var s = _m.Slots[i];
        if (s.Anchor < 0 || s.Anchor >= i) return Math.Max(0, s.Offset);
        int a = s.Anchor;
        int col = s.Align == AlignKind.Right
            ? _col[a] + _m.Slots[a].Text.Length - s.Text.Length + s.Offset
            : _col[a] + s.Offset;
        return Math.Max(0, col);
    }

    // L'intervallo sfora se sfora una delle sue righe, comprese le ) , che lo seguono attaccate
    // sulla sua ultima riga (il ; finale non conta, verificato con la CLI)
    private bool Exceeds(int first, int last)
    {
        while (last + 1 < _m.Count && EffectiveBreaks(last + 1) == 0
               && _m.Slots[last + 1].Token.TokenType is Microsoft.SqlServer.TransactSql.ScriptDom.TSqlTokenType.RightParenthesis
                   or Microsoft.SqlServer.TransactSql.ScriptDom.TSqlTokenType.Comma) last++;
        for (int i = first; i <= last; i++)
            if (_end[i] > _width) return true;
        return false;
    }

    private string Indent(int col)
    {
        if (col <= 0) return "";
        var ws = _style.Whitespace;
        if (ws.SpacesOrTabs == TabBehaviour.Spaces || ws.NumberOfSpacesInTabs <= 0)
            return new string(' ', col);
        int tabs = col / ws.NumberOfSpacesInTabs;
        int rest = col % ws.NumberOfSpacesInTabs;
        return new string('\t', tabs) + new string(' ', rest);
    }

    // Commento a blocco con tutte le righe successive che iniziano con "*" (stile /* … * … */)
    private static bool StarredComment(string text)
    {
        var lines = text.Replace("\r\n", "\n").Split('\n');
        return lines.Length > 1 && lines.Skip(1).All(l => l.TrimStart().Length == 0 || l.TrimStart().StartsWith('*'));
    }

    // Le righe con "*" si allineano alla colonna di "/*" (verificato con la CLI)
    private static string AlignContinuationLines(string text, int column)
    {
        var lines = text.Replace("\r\n", "\n").Split('\n');
        for (int k = 1; k < lines.Length; k++)
        {
            string trimmed = lines[k].TrimStart();
            if (trimmed.Length > 0) lines[k] = new string(' ', column) + trimmed;
        }
        return string.Join("\n", lines);
    }

    // Sposta di delta colonne le righe successive alla prima di un commento a blocco
    // (le tabulazioni iniziali diventano spazi)
    private string ShiftContinuationLines(string text, int delta)
    {
        if (delta == 0 || !text.Contains('\n')) return text;
        int tab = Math.Max(1, _style.Whitespace.NumberOfSpacesInTabs);
        var lines = text.Replace("\r\n", "\n").Split('\n');
        for (int k = 1; k < lines.Length; k++)
        {
            string line = lines[k];
            int col = 0, p = 0;
            while (p < line.Length && (line[p] == ' ' || line[p] == '\t'))
            {
                col = line[p] == '\t' ? (col / tab + 1) * tab : col + 1;
                p++;
            }
            if (p == line.Length) continue;
            lines[k] = new string(' ', Math.Max(0, col + delta)) + line[p..];
        }
        return string.Join("\n", lines);
    }

    private static int CountNewLines(string text)
    {
        int n = 0;
        foreach (char c in text) if (c == '\n') n++;
        return n;
    }

    private static string NormalizeNewLines(string text, string newLine)
    {
        if (!text.Contains('\n')) return text;
        return text.Replace("\r\n", "\n").Replace("\n", newLine);
    }
}
