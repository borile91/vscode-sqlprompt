using SqlFormatter.Engine.Style;
using Xunit.Abstractions;
using SqlFormatter.Engine;

namespace SqlFormatter.Tests;

// Una opzione per volta (tools/redgate-oracle/build-options.sh): per ogni sezione dell'editor degli stili,
// lo stile predefinito più una sola opzione cambiata, applicato all'SQL di anteprima della sezione.
// expected/<caso>.sql è l'output della CLI di SQL Prompt; i casi in passing.txt devono restare identici.
public class OptionTests(ITestOutputHelper output)
{
    public static string OptionsDir => Path.Combine(Path.GetDirectoryName(CorpusTests.CorpusDir)!, "options");

    public static IEnumerable<object[]> Cases() =>
        File.ReadAllLines(Path.Combine(OptionsDir, "cases.txt"))
            .Where(l => l.Length > 0)
            .Select(l => l.Split(' '))
            .Select(p => new object[] { p[0], p[1] });

    public static (string Expected, string Actual) Run(string name, string section)
    {
        var style = StyleLoader.Load(Path.Combine(OptionsDir, "styles", name + ".json"));
        string input = File.ReadAllText(Path.Combine(OptionsDir, "inputs", section + ".sql"));
        string expected = File.ReadAllText(Path.Combine(OptionsDir, "expected", name + ".sql"));
        var result = TSqlFormatter.Format(input, style);
        return (Lf(expected), Lf(result.Success ? result.Text : "<<errore di parsing>>"));
    }

    // la CLI scrive CRLF; a fine file un a capo in più o in meno non conta
    private static string Lf(string text) => text.Replace("\r\n", "\n").TrimEnd('\n');

    private static HashSet<string> Passing()
    {
        string path = Path.Combine(OptionsDir, "passing.txt");
        return File.Exists(path)
            ? File.ReadAllLines(path).Where(l => l.Length > 0 && !l.StartsWith('#')).ToHashSet()
            : [];
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void OpzioneGiaPassanteRestaIdentica(string name, string section)
    {
        if (!Passing().Contains(name)) return;
        var (expected, actual) = Run(name, section);
        Assert.Equal(expected, actual);
    }

    // Riepilogo per sezione; con OPTIONS_PASSING_OUT scrive l'elenco dei casi identici
    [Fact]
    public void Punteggio()
    {
        var passing = new List<string>();
        var perSection = new SortedDictionary<string, (int Exact, int Total)>();
        var failing = new List<string>();
        foreach (var c in Cases())
        {
            string name = (string)c[0], section = (string)c[1];
            var (expected, actual) = Run(name, section);
            bool ok = expected == actual;
            if (ok) passing.Add(name); else failing.Add(name);
            var ps = perSection.GetValueOrDefault(section);
            perSection[section] = (ps.Exact + (ok ? 1 : 0), ps.Total + 1);
        }
        output.WriteLine($"identici: {passing.Count}/{passing.Count + failing.Count}");
        foreach (var (section, v) in perSection) output.WriteLine($"  {section,-14} {v.Exact,3}/{v.Total}");
        foreach (var f in failing) output.WriteLine($"  diverso: {f}");
        string? dump = Environment.GetEnvironmentVariable("OPTIONS_PASSING_OUT");
        if (dump != null) File.WriteAllLines(dump, passing);
    }
}
