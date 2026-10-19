using Microsoft.SqlServer.TransactSql.ScriptDom;
using SqlFormatter.Engine.Layout;
using SqlFormatter.Engine.Style;

namespace SqlFormatter.Engine.Rules;

// Condizioni AND/OR, parentesi booleane, CASE, chiamate a funzione, IN
public sealed partial class RuleBuilder
{
    // catene AND/OR già sistemate (il visitor scende anche nei nodi interni della catena)
    private readonly HashSet<BooleanExpression> _arrangedChains = [];

    // primo operando della catena AND/OR a cui appartiene un operando (per le parentesi)
    private readonly Dictionary<int, int> _chainFirstOperand = [];

    // profondità negli argomenti di chiamate a funzione: lì AND/OR restano in linea
    private int _callArgumentDepth;

    public override void ExplicitVisit(BooleanBinaryExpression node)
    {
        if (!_arrangedChains.Contains(node))
        {
            if (_callArgumentDepth > 0) Flatten(node, []);
            else ArrangeBooleanChain(node);
        }
        base.ExplicitVisit(node);
    }

    // IIF(a = 1 AND b = 2, …): la condizione resta su una riga (verificato con la CLI)
    public override void ExplicitVisit(IIfCall node)
    {
        _callArgumentDepth++;
        base.ExplicitVisit(node);
        _callArgumentDepth--;
    }

    // dentro una sottoquery si torna alle regole normali, anche se è argomento di una funzione
    public override void ExplicitVisit(ScalarSubquery node)
    {
        ArrangeSubquery(node.QueryExpression, StatementAnchor());
        int saved = _callArgumentDepth;
        _callArgumentDepth = 0;
        base.ExplicitVisit(node);
        _callArgumentDepth = saved;
    }

    // Una catena di AND/OR al primo livello: gli operatori vanno a capo e si allineano
    // secondo operators.andOr
    private void ArrangeBooleanChain(BooleanBinaryExpression root)
    {
        var operands = new List<BooleanExpression>();
        Flatten(root, operands);
        int first = OperandStart(operands[0]);
        foreach (var operand in operands) _chainFirstOperand[_m.FirstCode(operand)] = first;
        int keyword = _m.PrevCode(first);
        // parola chiave che introduce la condizione (WHERE, ON, HAVING, IF, WHILE, WHEN…)
        if (keyword >= 0 && !Keywords.IsReservedKeyword(_m.Slots[keyword].Token)) keyword = first;

        var o = _s.Operators.AndOr;
        var points = new List<int>();
        for (int i = 1; i < operands.Count; i++)
        {
            // l'operatore si cerca tra i due operandi: alcuni nodi (es. EXISTS) non includono
            // la propria parola chiave nell'intervallo di token
            int op = _m.FindForward(_m.Last(operands[i - 1]) + 1, _m.FirstCode(operands[i]),
                sl => sl.Token.TokenType is TSqlTokenType.And or TSqlTokenType.Or);
            if (op < 0) continue;
            int start = _m.NextCode(op);
            if (o.PlaceKeywordBeforeCondition)
            {
                points.Add(op);
                AlignOperator(op, first, keyword);
            }
            else
            {
                points.Add(start);
                _m.AlignTo(start, first, 0);
            }
        }
        _m.AddGroup(Mode(o.PlaceOnNewLine), first, _m.Last(root), points, operands.Count);
    }

    // Primo token di un operando: EXISTS non include la propria parola chiave nell'intervallo
    private int OperandStart(BooleanExpression e)
    {
        int first = _m.FirstCode(e);
        if (e is ExistsPredicate)
        {
            int kw = _m.FindBackward(first, 0, sl => sl.Token.TokenType == TSqlTokenType.Exists);
            if (kw >= 0) first = kw;
        }
        return first;
    }

    private void Flatten(BooleanExpression e, List<BooleanExpression> operands)
    {
        if (e is BooleanBinaryExpression b)
        {
            _arrangedChains.Add(b);
            Flatten(b.FirstExpression, operands);
            Flatten(b.SecondExpression, operands);
        }
        else
        {
            operands.Add(e);
        }
    }

    private void AlignOperator(int op, int firstOperand, int keyword)
    {
        int len = _m.Slots[op].Text.Length;
        var alignment = _s.Operators.AndOr.Alignment;
        // senza parola chiave (es. dentro una parentesi) a sinistra e a destra l'operatore
        // finisce prima del primo operando (verificato con la CLI)
        if (keyword == firstOperand && alignment is AndOrAlignment.LeftAligned or AndOrAlignment.RightAligned)
            alignment = AndOrAlignment.BeforeFirstListItem;
        // senza allineamento al primo elemento, dentro una parentesi l'operatore rientra rispetto
        // a ciò che precede la parentesi (es. "and (a\n    or b)", verificato con la CLI)
        int open = _m.PrevCode(firstOperand);
        if (keyword == firstOperand && !_s.Lists.AlignSubsequentItemsWithFirstItem
            && _s.Operators.AndOr.Alignment is AndOrAlignment.LeftAligned or AndOrAlignment.RightAligned
            && open >= 0 && _m.Slots[open].Token.TokenType == TSqlTokenType.LeftParenthesis && _m.PrevCode(open) >= 0)
        {
            _m.AlignTo(op, _m.PrevCode(open), _tab);
            int following = _m.NextCode(op);
            if (following >= 0) _m.AlignTo(following, op, _tab);
            return;
        }
        switch (alignment)
        {
            case AndOrAlignment.LeftAligned: _m.AlignTo(op, keyword, 0); break;
            case AndOrAlignment.RightAligned: _m.AlignTo(op, keyword, 0, AlignKind.Right); break;
            case AndOrAlignment.BeforeFirstListItem: _m.AlignTo(op, firstOperand, -(len + 1)); break;
            case AndOrAlignment.ToFirstListItem: _m.AlignTo(op, firstOperand, 0); break;
            case AndOrAlignment.Indented: _m.AlignTo(op, keyword, _tab); break;
        }
        // l'operando che segue l'operatore, se va a capo, rientra rispetto all'operatore
        int next = _m.NextCode(op);
        if (next >= 0) _m.AlignTo(next, op, _tab);
        // operatore allineato alla parola chiave: l'operando si incolonna con il primo
        // (solo con il primo elemento delle liste sulla riga della parola chiave, verificato con la CLI)
        if (alignment is AndOrAlignment.LeftAligned or AndOrAlignment.RightAligned && _s.Lists.AlignSubsequentItemsWithFirstItem
            && _s.Lists.PlaceFirstItemOnNewLine == NewLineMode.Never)
            _m.AddAlignGroup([firstOperand, next]);
    }

    public override void ExplicitVisit(BooleanParenthesisExpression node)
    {
        int open = _m.FirstCode(node);
        int close = _m.Last(node);
        int inner = _m.FirstCode(node.Expression);
        // base: colonna dell'operando (l'operatore AND/OR che lo precede, o la parola chiave)
        int before = _m.PrevCode(open);
        int baseAnchor = before >= 0 && _m.Slots[before].Token.TokenType is TSqlTokenType.And or TSqlTokenType.Or
            ? before
            : open;
        if (node.Expression is BooleanBinaryExpression && before >= 0)
        {
            // dopo AND/OR la colonna dell'elemento è quella del primo operando della catena;
            // dopo WHERE/ON/… la parentesi è il primo elemento e non va a capo
            int item = baseAnchor != open && _chainFirstOperand.TryGetValue(open, out int chainFirst) ? chainFirst : open;
            ArrangeParenthesesAfter(open, close, before, item, _s.Parentheses.ParenthesisStyle, _s.Parentheses.IndentParenthesesContents);
            if (_s.Parentheses.CollapseShortParenthesisContents)
                _m.AddCollapse(open, close, _s.Parentheses.CollapseParenthesesShorterThan);
        }
        else
        {
            _m.AlignRange(inner, close, open, 1);
        }
        base.ExplicitVisit(node);
    }

    // ---- espressioni binarie (+, -, *, …) ----

    private readonly HashSet<BinaryExpression> _arrangedBinary = [];

    // Catena di operatori: se la riga è troppo lunga va a capo prima dell'operatore,
    // allineando la continuazione al primo operando
    public override void ExplicitVisit(BinaryExpression node)
    {
        if (!_arrangedBinary.Contains(node))
        {
            var operands = new List<ScalarExpression>();
            FlattenBinary(node, operands);
            int first = _m.FirstCode(operands[0]);
            var points = new List<int>();
            for (int i = 1; i < operands.Count; i++)
            {
                int op = _m.PrevCode(_m.FirstCode(operands[i]));
                points.Add(op);
                _m.AlignTo(op, first, 0);
            }
            _m.AddGroup(BreakMode.Wrap, first, _m.Last(node), points, operands.Count);
        }
        base.ExplicitVisit(node);
    }

    private void FlattenBinary(ScalarExpression e, List<ScalarExpression> operands)
    {
        if (e is BinaryExpression b)
        {
            _arrangedBinary.Add(b);
            FlattenBinary(b.FirstExpression, operands);
            FlattenBinary(b.SecondExpression, operands);
        }
        else
        {
            operands.Add(e);
        }
    }

    // ---- CASE ----

    public override void ExplicitVisit(SearchedCaseExpression node)
    {
        ArrangeCase(node, node.WhenClauses.Cast<WhenClause>().ToList(), node.ElseExpression, hasInput: false);
        base.ExplicitVisit(node);
    }

    public override void ExplicitVisit(SimpleCaseExpression node)
    {
        ArrangeCase(node, node.WhenClauses.Cast<WhenClause>().ToList(), node.ElseExpression, hasInput: true);
        base.ExplicitVisit(node);
    }

    private void ArrangeCase(TSqlFragment node, IList<WhenClause> whens, ScalarExpression? elseExpr, bool hasInput)
    {
        var o = _s.CaseExpressions;
        int @case = _m.FirstCode(node);
        int end = _m.Last(node);
        if (whens.Count == 0) return;
        int firstWhen = _m.FirstCode(whens[0]);

        bool firstOnNewLine = o.PlaceFirstWhenOnNewLine == CaseFirstWhen.Always
            || (o.PlaceFirstWhenOnNewLine == CaseFirstWhen.IfInputExpression && hasInput);
        (int anchor, int offset) whenPos = o.WhenAlignment switch
        {
            CaseWhenAlignment.ToCase => (@case, 0),
            CaseWhenAlignment.ToFirstItem when !firstOnNewLine => (firstWhen, 0),
            // primo WHEN a capo: la colonna in cui sarebbe dopo "CASE " (verificato con la CLI)
            CaseWhenAlignment.ToFirstItem => (@case, _m.Slots[@case].Text.Length + 1),
            _ => (@case, _tab),
        };
        _m.AlignRange(@case + 1, end, @case, _tab);
        if (firstOnNewLine)
        {
            _m.Break(firstWhen);
            _m.AlignTo(firstWhen, whenPos.anchor == firstWhen ? @case : whenPos.anchor, whenPos.anchor == firstWhen ? _tab : whenPos.offset);
        }

        foreach (var w in whens)
        {
            int when = _m.FirstCode(w);
            if (when != firstWhen)
            {
                _m.Break(when);
                _m.AlignTo(when, whenPos.anchor, whenPos.offset);
            }
            int thenValue = _m.FirstCode(w.ThenExpression);
            int then = _m.PrevCode(thenValue);
            _m.AlignRange(when + 1, _m.Last(w), when, _tab);
            if (o.PlaceThenOnNewLine)
            {
                _m.Break(then);
                switch (o.ThenAlignment)
                {
                    case CaseThenAlignment.ToWhen: _m.AlignTo(then, when, 0); break;
                    case CaseThenAlignment.ToWhenExpression: _m.AlignTo(then, _m.NextCode(when), 0); break;
                    default: _m.AlignTo(then, when, _tab); break;
                }
            }
            if (o.PlaceExpressionOnNewLine)
            {
                // il risultato rientra dal WHEN anche con THEN su una riga propria (verificato con la CLI)
                _m.Break(thenValue);
                _m.AlignTo(thenValue, when, _tab);
            }
        }

        if (elseExpr != null)
        {
            int elseValue = _m.FirstCode(elseExpr);
            int @else = _m.PrevCode(elseValue);
            if (o.PlaceElseOnNewLine)
            {
                // ELSE come i WHEN successivi al primo, oppure allineato a CASE (verificato con la CLI)
                _m.Break(@else);
                if (o.AlignElseToWhen) _m.AlignTo(@else, whenPos.anchor, whenPos.offset);
                else _m.AlignTo(@else, @case, 0);
            }
            _m.AlignRange(elseValue, _m.Last(elseExpr), @else, _tab);
            // con ELSE in linea anche il suo valore resta in linea
            if (o.PlaceExpressionOnNewLine && o.PlaceElseOnNewLine)
            {
                _m.Break(elseValue);
                _m.AlignTo(elseValue, @else, _tab);
            }
        }

        if (o.PlaceEndOnNewLine)
        {
            _m.Break(end);
            switch (o.EndAlignment)
            {
                case CaseEndAlignment.ToWhen: _m.AlignTo(end, firstWhen, 0); break;
                case CaseEndAlignment.RightAlignedToWhen: _m.AlignTo(end, firstWhen, 0, AlignKind.Right); break;
                default: _m.AlignTo(end, @case, 0); break;
            }
        }
        if (o.CollapseShortCaseExpressions)
            _m.AddCollapse(@case, end, o.CollapseCaseExpressionsShorterThan);
    }

    // ---- chiamate a funzione ----

    public override void ExplicitVisit(FunctionCall node)
    {
        _callArgumentDepth++;
        VisitFunctionCall(node);
        _callArgumentDepth--;
    }

    private void VisitFunctionCall(FunctionCall node)
    {
        _m.NoSpaceBefore(_m.NextCode(_m.Last(node.FunctionName)));
        if (node.Parameters.Count > 0)
        {
            int open = _m.PrevCode(_m.FirstCode(node.Parameters[0]));
            int close = _m.NextCode(_m.Last(node.Parameters[^1]));
            ArrangeArguments(open, close, node.Parameters);
            // con collapseShortParenthesisContents una sottoquery come primo argomento va a capo
            // e si allinea al nome della funzione: STUFF(\n(SELECT …), 1, 1, '')
            if (_s.Parentheses.CollapseShortParenthesisContents && node.Parameters[0] is ScalarSubquery)
            {
                int sub = _m.FirstCode(node.Parameters[0]);
                _m.Break(sub);
                _m.AlignTo(sub, _m.FirstCode(node), 0);
            }
        }
        base.ExplicitVisit(node);
    }

    private void ArrangeArguments<T>(int open, int close, IList<T> args) where T : TSqlFragment
    {
        int first = _m.FirstCode(args[0]);
        _m.AlignRange(first, close, first, 0);
        var points = new List<int>();
        for (int i = 1; i < args.Count; i++)
        {
            int start = _m.FirstCode(args[i]);
            points.Add(start);
            _m.AlignTo(start, first, 0);
        }
        _m.AddGroup(Mode(_s.FunctionCalls.PlaceArgumentsOnNewLines), open, close, points, args.Count);
    }

    // Nomi seguiti da parentesi senza spazio: tipi di dato con parametri, funzioni tabellari
    public override void ExplicitVisit(SqlDataTypeReference node)
    {
        // variables.addSpaceBetweenDataTypeAndPrecision: "varchar (10)" ovunque (verificato con la CLI)
        if (node.Parameters.Count > 0)
        {
            int open = _m.NextCode(_m.Last(node.Name));
            int close = _m.Last(node);
            _dataTypeParentheses.Add((open, close));
        }
        base.ExplicitVisit(node);
    }

    public override void ExplicitVisit(SchemaObjectFunctionTableReference node)
    {
        int open = _m.NextCode(_m.Last(node.SchemaObject));
        _m.NoSpaceBefore(open);
        // dopo la parentesi di una funzione tabellare la ) che segue è staccata: f(1, @x) );
        int close = node.Parameters.Count > 0 ? _m.NextCode(_m.Last(node.Parameters[^1])) : _m.NextCode(open);
        _tableFunctionCloses.Add(close);
        base.ExplicitVisit(node);
    }

    private readonly HashSet<int> _tableFunctionCloses = [];

    // parentesi dei tipi di dato: dopo la spaziatura delle chiamate a funzione, che non vale per i tipi
    private readonly List<(int Open, int Close)> _dataTypeParentheses = [];

    private void FixDataTypeParentheses()
    {
        foreach (var (open, close) in _dataTypeParentheses)
        {
            if (_s.Variables.AddSpaceBetweenDataTypeAndPrecision) _m.SpaceBefore(open);
            else _m.NoSpaceBefore(open);
            int inner = _m.NextCode(open);
            if (inner >= 0 && !_m.Slots[inner].IsComment) _m.NoSpaceBefore(inner);
            if (close >= 0 && _m.Slots[close].Token.TokenType == TSqlTokenType.RightParenthesis) _m.NoSpaceBefore(close);
        }
    }

    // ---- IN (valori) ----

    public override void ExplicitVisit(InPredicate node)
    {
        if (node.Values.Count > 0)
        {
            var o = _s.Operators.In;
            int first = _m.FirstCode(node.Values[0]);
            int open = _m.PrevCode(first);
            int close = _m.NextCode(_m.Last(node.Values[^1]));
            if (o.AddSpaceAroundInContents)
            {
                _m.SpaceBefore(first);
                _m.SpaceBefore(close);
            }
            _m.AlignRange(first, close, first, 0);
            var points = new List<int>();
            for (int i = 1; i < node.Values.Count; i++)
            {
                int start = _m.FirstCode(node.Values[i]);
                _m.NoSpaceBefore(_m.PrevCode(start));
                points.Add(start);
                _m.AlignTo(start, first, 0);
            }
            _m.AddGroup(Mode(o.PlaceSubsequentValuesOnNewLines), open, close, points, node.Values.Count);
        }
        base.ExplicitVisit(node);
    }
}
