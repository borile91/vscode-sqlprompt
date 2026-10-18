using SqlFormatter.Engine.Style;
using Xunit.Abstractions;
using SqlFormatter.Engine;

namespace SqlFormatter.Tests;

// Corpus generato con la CLI di SQL Prompt (tools/redgate-oracle/build-corpus.sh):
// expected/<stile>/<input>.sql è l'output di Redgate per inputs/<input>.sql con styles/<stile>.json.
// I casi elencati in passing.txt devono restare identici (ratchet); gli altri misurano il progresso.
public class CorpusTests(ITestOutputHelper output)
{
    public static string CorpusDir
    {
        get
        {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, "tests", "corpus"))) dir = dir.Parent;
            return Path.Combine(dir?.FullName ?? throw new DirectoryNotFoundException("corpus"), "tests", "corpus");
        }
    }

    public static IEnumerable<object[]> Cases()
    {
        foreach (var styleDir in Directory.GetDirectories(Path.Combine(CorpusDir, "expected")).Order())
            foreach (var file in Directory.GetFiles(styleDir, "*.sql").Order())
                yield return [Path.GetFileName(styleDir), Path.GetFileName(file)];
    }

    public static (string Expected, string Actual) Run(string style, string file)
    {
        var s = StyleLoader.Load(Path.Combine(CorpusDir, "styles", style + ".json"));
        string input = File.ReadAllText(Path.Combine(CorpusDir, "inputs", file));
        string expected = File.ReadAllText(Path.Combine(CorpusDir, "expected", style, file));
        var result = TSqlFormatter.Format(input, s);
        return (expected, result.Success ? result.Text : "<<errore di parsing>>");
    }

    private static HashSet<string> Passing()
    {
        string path = Path.Combine(CorpusDir, "passing.txt");
        return File.Exists(path)
            ? File.ReadAllLines(path).Where(l => l.Length > 0 && !l.StartsWith('#')).ToHashSet()
            : [];
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void CasoGiaPassanteRestaIdentico(string style, string file)
    {
        if (!Passing().Contains($"{style}/{file}")) return;
        var (expected, actual) = Run(style, file);
        Assert.Equal(expected, actual);
    }

    // Righe in comune (sottosequenza comune più lunga)
    private static int CommonLines(string[] a, string[] b)
    {
        var prev = new int[b.Length + 1];
        var cur = new int[b.Length + 1];
        for (int i = 1; i <= a.Length; i++)
        {
            for (int j = 1; j <= b.Length; j++)
                cur[j] = a[i - 1] == b[j - 1] ? prev[j - 1] + 1 : Math.Max(prev[j], cur[j - 1]);
            (prev, cur) = (cur, prev);
        }
        return prev[b.Length];
    }

    // Riepilogo: casi identici e percentuale di righe uguali, per stile
    [Fact]
    public void Punteggio()
    {
        int total = 0, exact = 0;
        long lines = 0, sameLines = 0;
        var passing = new List<string>();
        var perStyle = new SortedDictionary<string, (int Exact, int Total, long Same, long Lines)>();
        foreach (var c in Cases())
        {
            string style = (string)c[0], file = (string)c[1];
            var (expected, actual) = Run(style, file);
            total++;
            bool ok = expected == actual;
            if (ok) { exact++; passing.Add($"{style}/{file}"); }
            var e = expected.Replace("\r", "").Split('\n');
            var a = actual.Replace("\r", "").Split('\n');
            int same = CommonLines(e, a);
            lines += e.Length;
            sameLines += same;
            var ps = perStyle.GetValueOrDefault(style);
            perStyle[style] = (ps.Exact + (ok ? 1 : 0), ps.Total + 1, ps.Same + same, ps.Lines + e.Length);
        }
        output.WriteLine($"identici: {exact}/{total}  righe uguali: {100.0 * sameLines / Math.Max(1, lines):F1}%");
        foreach (var (style, v) in perStyle)
            output.WriteLine($"  {style,-24} {v.Exact,3}/{v.Total}  {100.0 * v.Same / Math.Max(1, v.Lines):F1}%");
        string? dump = Environment.GetEnvironmentVariable("CORPUS_PASSING_OUT");
        if (dump != null) File.WriteAllLines(dump, passing);
    }
}
