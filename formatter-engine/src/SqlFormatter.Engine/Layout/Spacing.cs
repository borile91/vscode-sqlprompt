using Microsoft.SqlServer.TransactSql.ScriptDom;
using SqlFormatter.Engine.Style;

namespace SqlFormatter.Engine.Layout;

// Spazi tra token sulla stessa riga, decisi dalla sola coppia di token.
// I provider che conoscono il contesto (chiamate a funzione, tipi di dato, IN) li correggono dopo.
public static class Spacing
{
    private static readonly HashSet<TSqlTokenType> Comparison =
    [
        TSqlTokenType.EqualsSign, TSqlTokenType.LessThan, TSqlTokenType.GreaterThan,
        TSqlTokenType.Bang,
    ];

    private static readonly HashSet<TSqlTokenType> Arithmetic =
    [
        TSqlTokenType.Plus, TSqlTokenType.Minus, TSqlTokenType.Star, TSqlTokenType.Divide,
        TSqlTokenType.PercentSign, TSqlTokenType.Ampersand, TSqlTokenType.VerticalLine, TSqlTokenType.Circumflex,
        TSqlTokenType.AddEquals, TSqlTokenType.SubtractEquals, TSqlTokenType.MultiplyEquals, TSqlTokenType.DivideEquals,
        TSqlTokenType.ModEquals, TSqlTokenType.BitwiseAndEquals, TSqlTokenType.BitwiseOrEquals, TSqlTokenType.BitwiseXorEquals,
        TSqlTokenType.Concat,
    ];

    public static void Apply(LayoutModel m, FormattingStyle s)
    {
        for (int i = 0; i < m.Count; i++)
        {
            var cur = m.Slots[i];
            if (i == 0) { cur.SpaceBefore = false; continue; }
            var prev = m.Slots[i - 1];
            cur.SpaceBefore = SpaceBetween(m, i - 1, i, s);
        }
    }

    // Parentesi di chiamata (funzioni, tipi di dato, CAST…): spazi interni secondo functionCalls
    // e virgole tra argomenti senza spazio prima; le opzioni delle liste valgono per le altre parentesi
    public static void FixCallParentheses(LayoutModel m, FormattingStyle s)
    {
        bool inner = s.FunctionCalls.AddSpacesAroundArgumentList;
        for (int i = 1; i < m.Count; i++)
        {
            var open = m.Slots[i];
            if (open.Token.TokenType != TSqlTokenType.LeftParenthesis || open.SpaceBefore) continue;
            var prev = m.Slots[i - 1].Token;
            if (prev.TokenType is not (TSqlTokenType.Identifier or TSqlTokenType.QuotedIdentifier) && !Keywords.IsReservedKeyword(prev)) continue;
            int depth = 0, close = -1;
            for (int j = i; j < m.Count; j++)
            {
                var t = m.Slots[j].Token.TokenType;
                if (t == TSqlTokenType.LeftParenthesis) depth++;
                else if (t == TSqlTokenType.RightParenthesis && --depth == 0) { close = j; break; }
                else if (t == TSqlTokenType.Comma && depth == 1) m.Slots[j].SpaceBefore = false;
            }
            if (close < 0) continue;
            if (close == i + 1)
            {
                m.Slots[close].SpaceBefore = s.FunctionCalls.AddSpaceBetweenEmptyParentheses;
                continue;
            }
            if (!m.Slots[i + 1].IsComment) m.Slots[i + 1].SpaceBefore = inner;
            if (!m.Slots[close - 1].IsComment) m.Slots[close].SpaceBefore = inner;
        }
    }

    private static bool SpaceBetween(LayoutModel m, int p, int c, FormattingStyle s)
    {
        var prev = m.Slots[p].Token;
        var cur = m.Slots[c].Token;
        var pt = prev.TokenType;
        var ct = cur.TokenType;

        if (m.Slots[c].IsComment || m.Slots[p].IsComment) return true;
        if (ct == TSqlTokenType.Semicolon) return s.Whitespace.WhiteSpaceBeforeSemiColon == SemicolonWhitespace.SpaceBefore;
        // addSpaceBeforeComma non ha effetti visibili nell'output di SQL Prompt (verificato con la CLI)
        if (ct == TSqlTokenType.Comma) return false;
        if (pt == TSqlTokenType.Comma) return s.Lists.AddSpaceAfterComma;
        if (ct == TSqlTokenType.Dot || pt == TSqlTokenType.Dot) return false;
        if (ct == TSqlTokenType.DoubleColon || pt == TSqlTokenType.DoubleColon) return false;
        // parentesi consecutive "((" e "))" sempre attaccate
        if (ct == TSqlTokenType.RightParenthesis)
            return pt is not (TSqlTokenType.LeftParenthesis or TSqlTokenType.RightParenthesis) && s.Parentheses.AddSpacesInsideParentheses;
        if (pt == TSqlTokenType.LeftParenthesis)
            return ct is not (TSqlTokenType.RightParenthesis or TSqlTokenType.LeftParenthesis) && s.Parentheses.AddSpacesInsideParentheses;
        if (ct == TSqlTokenType.LeftParenthesis)
        {
            if (IsCallName(prev)) return false;
            // altre parole chiave seguite da parentesi (RAISERROR(, IIF(…): si mantiene l'originale
            if (Keywords.IsReservedKeyword(prev) && !Structural.Contains(prev.TokenType)) return !AdjacentInSource(prev, cur);
            return true;
        }

        // operatori composti scritti come più token (>=, <>, !=, !<)
        if (IsComparisonPart(pt) && IsComparisonPart(ct) && AdjacentInSource(prev, cur)) return false;

        if (IsComparisonPart(ct) || IsComparisonPart(pt)) return s.Operators.Comparison.AddSpacesAround;
        if (Arithmetic.Contains(ct)) return s.Operators.Arithmetic.AddSpacesAround || ct == TSqlTokenType.Star && IsStarColumn(m, c);
        if (Arithmetic.Contains(pt))
        {
            if (IsUnary(m, p)) return false;
            if (pt == TSqlTokenType.Star && IsStarColumn(m, p)) return true;
            return s.Operators.Arithmetic.AddSpacesAround;
        }
        return true;
    }

    // Parole chiave dopo le quali la parentesi è sempre staccata
    private static readonly HashSet<TSqlTokenType> Structural =
    [
        TSqlTokenType.In, TSqlTokenType.As, TSqlTokenType.Values, TSqlTokenType.On, TSqlTokenType.And, TSqlTokenType.Or,
        TSqlTokenType.Exists, TSqlTokenType.With, TSqlTokenType.Over, TSqlTokenType.Key, TSqlTokenType.References,
        TSqlTokenType.Table, TSqlTokenType.Procedure, TSqlTokenType.If, TSqlTokenType.While, TSqlTokenType.Return,
        TSqlTokenType.Select, TSqlTokenType.Where, TSqlTokenType.Then, TSqlTokenType.Else, TSqlTokenType.Not,
        TSqlTokenType.From, TSqlTokenType.Join, TSqlTokenType.By, TSqlTokenType.Into, TSqlTokenType.When,
        TSqlTokenType.Case, TSqlTokenType.Union, TSqlTokenType.Except, TSqlTokenType.Intersect, TSqlTokenType.Default,
        TSqlTokenType.Check, TSqlTokenType.Unique, TSqlTokenType.Clustered, TSqlTokenType.NonClustered, TSqlTokenType.Top,
        TSqlTokenType.Set, TSqlTokenType.Having, TSqlTokenType.Is, TSqlTokenType.Between, TSqlTokenType.Like,
        TSqlTokenType.Begin, TSqlTokenType.End, TSqlTokenType.Function, TSqlTokenType.View,
    ];

    private static bool IsComparisonPart(TSqlTokenType t) => Comparison.Contains(t);

    private static bool AdjacentInSource(TSqlParserToken a, TSqlParserToken b) => a.Offset + a.Text.Length == b.Offset;

    // Parole chiave seguite da parentesi senza spazio (CAST(...), IDENTITY(...)); per i nomi
    // (funzioni, tipi di dato) decidono i provider che conoscono l'AST
    private static bool IsCallName(TSqlParserToken t) => IsKeywordCall(t);

    private static readonly HashSet<string> KeywordCalls = new(StringComparer.OrdinalIgnoreCase)
    {
        "CAST", "CONVERT", "COALESCE", "NULLIF", "IDENTITY", "LEFT", "RIGHT", "USER", "CURRENT_USER",
        "SESSION_USER", "SYSTEM_USER", "COLLATE", "CONTAINS", "FREETEXT", "OPENQUERY", "OPENROWSET",
        "OPENDATASOURCE", "OPENXML", "TRY_CONVERT", "TRY_CAST", "FILE", "UPDATE", "NEXT", "IIF", "PARSE", "TRY_PARSE", "PATH", "RAW",
    };

    private static bool IsKeywordCall(TSqlParserToken t) =>
        KeywordCalls.Contains(t.Text) && t.TokenType is not TSqlTokenType.Update and not TSqlTokenType.File;

    // Meno/più unario: dopo operatori, parentesi aperte, virgole e parole chiave
    private static bool IsUnary(LayoutModel m, int op)
    {
        var t = m.Slots[op].Token.TokenType;
        if (t is not TSqlTokenType.Minus and not TSqlTokenType.Plus and not TSqlTokenType.Tilde) return false;
        int before = m.PrevCode(op);
        if (before < 0) return true;
        var bt = m.Slots[before].Token;
        if (bt.TokenType is TSqlTokenType.LeftParenthesis or TSqlTokenType.Comma) return true;
        if (Comparison.Contains(bt.TokenType) || Arithmetic.Contains(bt.TokenType)) return true;
        return Keywords.IsReservedKeyword(bt) && bt.TokenType is not TSqlTokenType.Null;
    }

    // SELECT * / COUNT(*) / t.*: l'asterisco come colonna, non come moltiplicazione
    private static bool IsStarColumn(LayoutModel m, int star)
    {
        int before = m.PrevCode(star);
        if (before < 0) return true;
        var bt = m.Slots[before].Token.TokenType;
        return bt is TSqlTokenType.LeftParenthesis or TSqlTokenType.Comma or TSqlTokenType.Dot
            || Keywords.IsReservedKeyword(m.Slots[before].Token);
    }
}
