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
    private readonly int _width;
    private readonly bool[] _collapsedInside;
    private readonly int[] _groupBreaks;
    // punti di riempimento: lunghezza del pezzo che inizia nel punto (fino al punto successivo)
    private readonly int[] _wrapSegment;
    private readonly bool[] _wrapBreak;
    private int[] _col = [];
    private int[] _end = [];
    private int[] _line = [];

    public LayoutSolver(LayoutModel model, FormattingStyle style)
    {
        _m = model;
        _style = style;
        _width = style.Whitespace.WrapLongLines ? style.Whitespace.WrapLinesLongerThan : int.MaxValue;
        _collapsedInside = new bool[model.Count];
        _groupBreaks = new int[model.Count];
        _wrapSegment = new int[model.Count];
        _wrapBreak = new bool[model.Count];
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
            sb.Append(NormalizeNewLines(s.Text, newLine));
        }
        return sb.ToString();
    }

    private void Solve()
    {
        // dopo un commento di riga si va sempre a capo
        for (int i = 0; i + 1 < _m.Count; i++)
            if (_m.Slots[i].IsLineComment) _m.Break(i + 1);

        DecideCollapses();
        PrepareWraps();

        foreach (var g in _m.Groups)
        {
            if (g.Mode == BreakMode.Always || (g.Mode == BreakMode.IfLongOrMultiple && g.ItemCount > 1))
                ApplyGroup(g);
        }

        // gruppi condizionati alla lunghezza: dall'esterno verso l'interno
        var pending = _m.Groups
            .Where(g => !g.Broken && g.Mode is BreakMode.IfLong or BreakMode.IfLongOrMultiple)
            .OrderBy(g => g.First).ThenByDescending(g => g.Last)
            .ToList();
        ComputeColumns();
        bool changed = true;
        while (changed)
        {
            changed = false;
            foreach (var g in pending)
            {
                if (g.Broken || !Exceeds(g.First, g.Last)) continue;
                ApplyGroup(g);
                ComputeColumns();
                changed = true;
                break;
            }
        }
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
                _wrapSegment[pts[k]] = Math.Max(_wrapSegment[pts[k]], FlatLength(pts[k], Math.Min(end, _m.Count - 1)));
            }
        }
    }

    private void ApplyGroup(BreakGroup g)
    {
        g.Broken = true;
        foreach (int p in g.Points) _groupBreaks[p] = Math.Max(_groupBreaks[p], 1);
    }

    private void DecideCollapses()
    {
        foreach (var c in _m.Collapses.OrderBy(c => c.First).ThenByDescending(c => c.Last))
        {
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

    private int EffectiveBreaks(int i)
    {
        if (i == 0) return 0;
        var s = _m.Slots[i];
        if (_m.Slots[i - 1].IsLineComment) return Math.Max(1, s.Breaks);
        if (_collapsedInside[i]) return 0;
        return Math.Max(Math.Max(s.Breaks, _groupBreaks[i]), _wrapBreak[i] ? 1 : 0);
    }

    // Colonne di tutti i token; i gruppi di allineamento verticale richiedono qualche iterazione
    // perché spostare un token sposta anche quelli che seguono sulla stessa riga
    private void ComputeColumns()
    {
        int n = _m.Count;
        var padTo = new int[n];
        for (int iter = 0; iter < 4; iter++)
        {
            ComputeColumnsOnce(padTo);
            bool changed = false;
            foreach (var g in _m.AlignGroups)
            {
                // si allinea in colonna solo se ogni membro sta su una riga diversa
                if (g.Select(x => _line[x]).Distinct().Count() != g.Count) continue;
                int max = 0;
                foreach (int x in g) max = Math.Max(max, _col[x]);
                foreach (int x in g)
                {
                    if (EffectiveBreaks(x) > 0 || padTo[x] == max) continue;
                    if (padTo[x] < max) { padTo[x] = max; changed = true; }
                }
            }
            if (!changed) break;
        }
    }

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
                && _end[i - 1] + 1 + _wrapSegment[i] > _width)
                _wrapBreak[i] = true;
            if (i > 0) line += EffectiveBreaks(i) + CountNewLines(_m.Slots[i - 1].Text);
            _line[i] = line;
            if (i == 0 || EffectiveBreaks(i) > 0)
                col = IndentColumn(i);
            else
                col = Math.Max(_end[i - 1] + (s.SpaceBefore ? 1 : 0), padTo[i]);
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

    private bool Exceeds(int first, int last)
    {
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
