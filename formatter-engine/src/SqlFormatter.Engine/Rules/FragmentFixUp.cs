using Microsoft.SqlServer.TransactSql.ScriptDom;

namespace SqlFormatter.Engine.Rules;

// Correzioni agli intervalli di token dell'AST di ScriptDom prima di raccogliere le regole.
// EXISTS ( … ): il nodo ExistsPredicate parte dalla parentesi, non dalla parola chiave;
// lo stesso errore si propaga ai nodi che iniziano con quel predicato.
public sealed class FragmentFixUp : TSqlFragmentVisitor
{
    private readonly List<TSqlFragment> _all = [];

    public static void Apply(TSqlScript script)
    {
        var fix = new FragmentFixUp();
        script.Accept(fix);
        fix.FixExists(script.ScriptTokenStream);
    }

    public override void Visit(TSqlFragment node)
    {
        _all.Add(node);
        base.Visit(node);
    }

    private void FixExists(IList<TSqlParserToken> tokens)
    {
        var moves = new Dictionary<int, int>();
        foreach (var e in _all.OfType<ExistsPredicate>())
        {
            int i = e.FirstTokenIndex - 1;
            while (i >= 0 && tokens[i].TokenType is TSqlTokenType.WhiteSpace or TSqlTokenType.SingleLineComment or TSqlTokenType.MultilineComment) i--;
            if (i >= 0 && tokens[i].TokenType == TSqlTokenType.Exists) moves[e.FirstTokenIndex] = i;
        }
        if (moves.Count == 0) return;
        foreach (var node in _all)
        {
            if (moves.TryGetValue(node.FirstTokenIndex, out int start) && node is not ScalarSubquery && node is not QueryExpression)
                node.FirstTokenIndex = start;
        }
    }
}
