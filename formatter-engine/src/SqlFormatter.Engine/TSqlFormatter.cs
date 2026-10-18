using Microsoft.SqlServer.TransactSql.ScriptDom;
using SqlFormatter.Engine.Casing;
using SqlFormatter.Engine.Layout;
using SqlFormatter.Engine.Rules;
using SqlFormatter.Engine.Style;

namespace SqlFormatter.Engine;

public sealed record FormatError(int Line, int Column, string Message);

public sealed record FormatResult(bool Success, string Text, IReadOnlyList<FormatError> Errors);

// Punto d'ingresso: parsing con ScriptDom, regole dallo stile, layout, stampa.
// Come SQL Prompt, uno script che non si analizza non viene formattato.
public static class TSqlFormatter
{
    public static FormatResult Format(string sql, FormattingStyle style)
    {
        var parser = new TSql170Parser(initialQuotedIdentifiers: true);
        var fragment = parser.Parse(new StringReader(sql), out IList<ParseError> errors);
        if (errors.Count > 0 || fragment is not TSqlScript script)
            return new FormatResult(false, sql, errors.Select(e => new FormatError(e.Line, e.Column, e.Message)).ToList());

        var model = new LayoutModel(script.ScriptTokenStream);
        if (model.Count == 0) return new FormatResult(true, sql, []);

        new RuleBuilder(model, style).Build(script);
        CasingRules.Apply(model, script, style.Casing);

        string newLine = sql.Contains("\r\n") ? "\r\n" : "\n";
        string text = new LayoutSolver(model, style).Render(newLine);
        // a capo finale come nell'originale
        if (EndsWithNewLine(sql)) text += newLine;
        return new FormatResult(true, text, []);
    }

    private static bool EndsWithNewLine(string s) => s.EndsWith('\n');
}
