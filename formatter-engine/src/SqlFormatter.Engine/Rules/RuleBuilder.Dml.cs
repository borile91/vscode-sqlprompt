using Microsoft.SqlServer.TransactSql.ScriptDom;
using SqlFormatter.Engine.Layout;
using SqlFormatter.Engine.Style;

namespace SqlFormatter.Engine.Rules;

// SELECT, FROM/JOIN, WHERE, GROUP BY, ORDER BY, INSERT, UPDATE, DELETE
public sealed partial class RuleBuilder
{
    // SELECT delle query aperte: le clausole si allineano al SELECT della propria query
    private readonly Stack<int> _queryStarts = new();
    // colonna comune degli elementi delle clausole (alignItemsAcrossClauses) della query aperta:
    // le tabelle dei JOIN allineati a FROM vi si aggiungono
    private readonly Stack<List<int>?> _acrossClauses = new();

    public override void ExplicitVisit(QuerySpecification node)
    {
        int select = _m.FirstCode(node);
        var clauses = new List<(int Keyword, int FirstItem)>();

        // SELECT [DISTINCT] [TOP (n)] elementi
        int afterSelect = select;
        if (node.UniqueRowFilter != UniqueRowFilter.NotSpecified) afterSelect = _m.NextCode(afterSelect);
        if (node.TopRowFilter != null) afterSelect = _m.Last(node.TopRowFilter);
        if (node.SelectElements.Count > 0)
        {
            int first = _m.FirstCode(node.SelectElements[0]);
            int firstAfterKeyword = _m.NextCode(select);
            ArrangeList(select, node.SelectElements, _s.Lists.PlaceFirstItemOnNewLine, _s.Lists.PlaceSubsequentItemsOnNewLines);
            // DISTINCT/TOP su una riga propria, nella colonna degli elementi
            if (afterSelect != select && _s.Dml.PlaceDistinctAndTopClausesOnNewLine)
            {
                _m.Break(firstAfterKeyword);
                _m.AlignTo(firstAfterKeyword, select, 0);
            }
            // dopo DISTINCT/TOP il primo elemento va a capo, nella colonna in cui sarebbe dopo SELECT
            if (afterSelect != select && _s.Dml.AddNewLineAfterDistinctAndTopClauses)
            {
                _m.Break(first);
                _m.AlignTo(first, select, _m.Slots[select].Text.Length + 1);
                clauses.Add((select, first));
            }
            clauses.Add((select, firstAfterKeyword));
            if (_s.Lists.AlignAliases) AlignAliases(node.SelectElements);
        }

        if (_selectInto.TryGetValue(select, out int intoItem))
            clauses.Add((_m.PrevCode(intoItem), intoItem));
        if (node.FromClause != null)
        {
            int kw = _m.FirstCode(node.FromClause);
            Clause(kw, select);
            var refs = node.FromClause.TableReferences;
            if (refs.Count > 0)
            {
                ArrangeList(kw, refs, _s.Dml.ListItems.PlaceFromTableOnNewLine, NewLineMode.Always);
                clauses.Add((kw, _m.FirstCode(refs[0])));
                if (_s.Lists.AlignAliases) AlignTableAliases(refs);
            }
        }
        if (node.WhereClause != null)
        {
            int kw = _m.FirstCode(node.WhereClause);
            Clause(kw, select);
            if (node.WhereClause.SearchCondition != null)
            {
                FirstItemOnNewLine(kw, node.WhereClause.SearchCondition, _s.Dml.ListItems.PlaceWhereConditionOnNewLine);
                clauses.Add((kw, _m.FirstCode(node.WhereClause.SearchCondition)));
            }
        }
        if (node.GroupByClause != null)
        {
            int kw = _m.FirstCode(node.GroupByClause);
            Clause(kw, select);
            var items = node.GroupByClause.GroupingSpecifications;
            if (items.Count > 0)
            {
                ArrangeList(kw, items, _s.Dml.ListItems.PlaceGroupByAndOrderByOnNewLine, _s.Lists.PlaceSubsequentItemsOnNewLines);
                clauses.Add((kw, _m.FirstCode(items[0])));
            }
        }
        if (node.HavingClause != null)
        {
            int kw = _m.FirstCode(node.HavingClause);
            Clause(kw, select);
            if (node.HavingClause.SearchCondition != null)
                clauses.Add((kw, _m.FirstCode(node.HavingClause.SearchCondition)));
        }
        if (node.OrderByClause != null)
        {
            int kw = _m.FirstCode(node.OrderByClause);
            Clause(kw, select);
            var items = node.OrderByClause.OrderByElements;
            if (items.Count > 0)
            {
                ArrangeList(kw, items, _s.Dml.ListItems.PlaceGroupByAndOrderByOnNewLine, _s.Lists.PlaceSubsequentItemsOnNewLines);
                clauses.Add((kw, _m.FirstCode(items[0])));
            }
        }

        if (node.ForClause != null)
        {
            int kw = _m.FindBackward(_m.FirstCode(node.ForClause), select, sl => sl.Token.TokenType == TSqlTokenType.For);
            Clause(kw, select);
            // sottoquery tra parentesi compatte: FOR XML si allinea alla parentesi, non al SELECT
            int open = _m.PrevCode(select);
            if (open >= 0 && _m.Slots[open].Token.TokenType == TSqlTokenType.LeftParenthesis
                && _s.Parentheses.ParenthesisStyle.ToString().StartsWith("Compact"))
                _m.AlignTo(kw, open, 0);
        }

        // gli elementi di tutte le clausole partono dalla colonna della parola chiave più lunga;
        // un elemento a capo (es. tabella del FROM con placeFromTableOnNewLine) va in quella colonna.
        // Con le parole chiave allineate a destra gli elementi seguono già la parola chiave.
        List<int>? across = null;
        if (_s.Lists.AlignItemsAcrossClauses && _s.Lists.AlignSubsequentItemsWithFirstItem && _s.Dml.Clauses.ClauseAlignment != ClauseAlignment.RightAligned)
        {
            across = _m.AddAlignGroup(clauses.Select(c => c.FirstItem));
            if (across != null) _m.FollowingGroups.Add(across);
        }

        _queryStarts.Push(select);
        _acrossClauses.Push(across);
        base.ExplicitVisit(node);
        _acrossClauses.Pop();
        _queryStarts.Pop();
    }

    // Parola chiave di clausola: a capo e allineata all'inizio dello statement
    private void Clause(int keyword, int statementStart)
    {
        if (keyword < 0) return;
        _m.Break(keyword);
        switch (_s.Dml.Clauses.ClauseAlignment)
        {
            case ClauseAlignment.RightAligned:
                _m.AlignTo(keyword, statementStart, 0, AlignKind.Right);
                break;
            default:
                _m.AlignTo(keyword, statementStart, _s.Dml.Clauses.ClauseIndentation);
                break;
        }
    }

    private void FirstItemOnNewLine(int keyword, TSqlFragment item, NewLineMode mode)
    {
        int first = _m.FirstCode(item);
        // "se sono più d'uno": più condizioni AND/OR, oppure una condizione con sottoquery (verificato con la CLI)
        bool multiple = item is BooleanBinaryExpression || ContainsSubquery(item);
        if (mode == NewLineMode.Always || mode == NewLineMode.IfMultiple && multiple)
        {
            _m.Break(first);
            _m.AlignTo(first, keyword, _tab);
        }
    }

    private static bool ContainsSubquery(TSqlFragment fragment)
    {
        var finder = new SubqueryFinder();
        fragment.Accept(finder);
        return finder.Found;
    }

    private sealed class SubqueryFinder : TSqlFragmentVisitor
    {
        public bool Found { get; private set; }
        public override void Visit(QueryExpression node) => Found = true;
    }

    // Lista di elementi separati da virgola dopo una parola chiave
    // unaligned: dove vanno gli elementi successivi se non si allineano al primo
    // (default: parola chiave + tab)
    private void ArrangeList<T>(int keyword, IList<T> items, NewLineMode firstMode, NewLineMode subsequentMode,
        (int Anchor, int Offset)? unaligned = null) where T : TSqlFragment
    {
        if (items.Count == 0) return;
        int first = _m.FirstCode(items[0]);
        int last = _m.Last(items[^1]);
        int extended = last;
        while (extended + 1 < _m.Count && _m.Slots[extended + 1].IsComment && _m.Slots[extended + 1].OriginalNewLinesBefore == 0) extended++;
        // la virgola o il ; dopo l'ultimo elemento possono precedere il commento in coda
        if (extended == last && last + 2 < _m.Count
            && _m.Slots[last + 1].Token.TokenType is TSqlTokenType.Comma or TSqlTokenType.Semicolon
            && _m.Slots[last + 2].IsLineComment && _m.Slots[last + 2].OriginalNewLinesBefore == 0)
            extended = last + 2;
        _listRanges.Add((first, extended));

        bool firstBreaks = firstMode == NewLineMode.Always
            || (firstMode is NewLineMode.IfSubsequentItems or NewLineMode.IfMultiple or NewLineMode.IfMultipleItems && items.Count > 1);
        if (firstBreaks)
        {
            _m.Break(first);
            _m.AlignTo(first, keyword, _s.Lists.IndentListItems ? _tab : 0);
        }

        bool commasBefore = _s.Lists.PlaceCommasBeforeItems;
        var points = new List<int>();
        for (int i = 0; i < items.Count; i++)
        {
            int start = _m.FirstCode(items[i]);
            int end = _m.Last(items[i]);
            // il contenuto dell'elemento, se va a capo, rientra rispetto all'inizio dell'elemento
            _m.AlignRange(start + 1, end, start, _tab);
            if (i == 0) continue;

            var un = unaligned ?? (keyword, _tab);
            int itemAnchor = _s.Lists.AlignSubsequentItemsWithFirstItem ? first : un.Anchor;
            int itemOffset = _s.Lists.AlignSubsequentItemsWithFirstItem ? 0 : un.Offset;
            int comma = _m.FindBackward(start - 1, 0, sl => sl.Token.TokenType == TSqlTokenType.Comma);
            if (commasBefore && comma >= 0)
            {
                points.Add(comma);
                const int width = 2;
                switch (_s.Lists.CommaAlignment)
                {
                    case CommaAlignment.BeforeItem:
                        _m.AlignTo(comma, itemAnchor, itemOffset - width);
                        break;
                    case CommaAlignment.ToList:
                        _m.AlignTo(comma, itemAnchor, itemOffset);
                        break;
                    default:
                        // virgola sotto lo statement, elemento comunque nella colonna del primo (verificato con la CLI)
                        _m.AlignTo(comma, _queryStarts.Count > 0 ? _queryStarts.Peek() : keyword, 0);
                        _m.AlignTo(start, itemAnchor, itemOffset);
                        _m.Slots[start].PadInline = true;
                        break;
                }
            }
            else
            {
                points.Add(start);
                _m.AlignTo(start, itemAnchor, itemOffset);
            }
        }
        _m.AddGroup(Mode(subsequentMode), keyword, last, points, items.Count).ContentStart = first;
    }

    // AS degli alias allineati in colonna
    private void AlignAliases(IList<SelectElement> elements)
    {
        var aliases = new List<int>();
        foreach (var e in elements)
        {
            if (e is SelectScalarExpression { ColumnName: not null } sc)
            {
                int alias = _m.First(sc.ColumnName);
                int @as = _m.PrevCode(alias);
                aliases.Add(@as >= 0 && _m.Slots[@as].Token.TokenType == TSqlTokenType.As ? @as : alias);
            }
        }
        _m.AddAlignGroup(aliases);
    }

    // Alias delle tabelle di FROM e JOIN in colonna (alignAliases, verificato con la CLI)
    private void AlignTableAliases(IList<TableReference> refs)
    {
        var aliases = new List<int>();
        void Collect(TableReference t)
        {
            switch (t)
            {
                case JoinTableReference j:
                    Collect(j.FirstTableReference);
                    Collect(j.SecondTableReference);
                    break;
                case TableReferenceWithAlias { Alias: not null } a when a is NamedTableReference:
                    int alias = _m.First(a.Alias);
                    int @as = _m.PrevCode(alias);
                    aliases.Add(@as >= 0 && _m.Slots[@as].Token.TokenType == TSqlTokenType.As ? @as : alias);
                    break;
            }
        }
        foreach (var r in refs) Collect(r);
        _m.AddAlignGroup(aliases);
    }

    // ---- FROM e JOIN ----

    private int FromKeyword(TSqlFragment tableRef)
    {
        // la parola chiave FROM (o UPDATE/DELETE) che apre la lista di tabelle
        int i = _m.FindBackward(_m.FirstCode(tableRef) - 1, 0, sl => sl.Token.TokenType == TSqlTokenType.From);
        return i;
    }

    private int LeftmostTable(TableReference t)
    {
        while (t is JoinTableReference j) t = j.FirstTableReference;
        return _m.FirstCode(t);
    }

    public override void ExplicitVisit(QualifiedJoin node)
    {
        ArrangeJoin(node, node.SearchCondition);
        base.ExplicitVisit(node);
    }

    public override void ExplicitVisit(UnqualifiedJoin node)
    {
        ArrangeJoin(node, null);
        base.ExplicitVisit(node);
    }

    private void ArrangeJoin(JoinTableReference node, BooleanExpression? condition)
    {
        var o = _s.JoinStatements;
        int join = _m.NextCode(_m.Last(node.FirstTableReference));
        int table = _m.FirstCode(node.SecondTableReference);
        if (join < 0 || table < 0) return;
        int from = FromKeyword(node);
        int leftmost = LeftmostTable(node);

        if (o.Join.PlaceOnNewLine)
        {
            _m.Break(join);
            switch (o.Join.KeywordAlignment)
            {
                case JoinKeywordAlignment.ToFrom: _m.AlignTo(join, from, 0); break;
                case JoinKeywordAlignment.RightAlignedToFrom: _m.AlignTo(join, from, 0, AlignKind.Right); break;
                case JoinKeywordAlignment.ToTable: _m.AlignTo(join, leftmost, 0); break;
                case JoinKeywordAlignment.Indented: _m.AlignTo(join, from, _tab); break;
            }
        }
        // il resto del JOIN rientra rispetto alla parola chiave
        _m.AlignRange(join + 1, _m.Last(node), join, _tab);

        if (o.Join.PlaceJoinTableOnNewLine)
        {
            _m.Break(table);
            _m.AlignTo(table, join, o.Join.IndentJoinTable ? _tab : 0);
        }
        // la tabella del JOIN si incolonna con gli elementi delle clausole (se va a capo prende la
        // colonna comune), tranne con il JOIN allineato alla prima tabella (verificato con la CLI)
        if (o.Join.KeywordAlignment != JoinKeywordAlignment.ToTable
            && _acrossClauses.Count > 0 && _acrossClauses.Peek() is { } across)
            across.Add(table);
        if (o.Join.InsertEmptyLineBetweenJoinClauses && node.FirstTableReference is JoinTableReference)
            _m.Break(join, 2);

        if (condition == null) return;
        int on = _m.PrevCode(_m.FirstCode(condition));
        int lastJoinWord = _m.PrevCode(table);
        if (o.On.PlaceOnNewLine)
        {
            _m.Break(on);
            switch (o.On.KeywordAlignment)
            {
                case JoinOnKeywordAlignment.ToJoin: _m.AlignTo(on, join, 0); break;
                case JoinOnKeywordAlignment.RightAlignedToJoin: _m.AlignTo(on, lastJoinWord, 0, AlignKind.Right); break;
                case JoinOnKeywordAlignment.RightAlignedToInner: _m.AlignTo(on, join, 0, AlignKind.Right); break;
                case JoinOnKeywordAlignment.ToTable: _m.AlignTo(on, table, 0); break;
                case JoinOnKeywordAlignment.Indented: _m.AlignTo(on, join, _tab); break;
            }
        }
        int cond = _m.FirstCode(condition);
        _m.AlignRange(cond, _m.Last(condition), on, _tab);
        if (o.On.PlaceConditionOnNewLine)
        {
            _m.Break(cond);
            switch (o.On.ConditionAlignment)
            {
                case JoinOnConditionAlignment.ToOnKeyword: _m.AlignTo(cond, on, 0); break;
                case JoinOnConditionAlignment.ToInner: _m.AlignTo(cond, join, 0); break;
                case JoinOnConditionAlignment.ToTable: _m.AlignTo(cond, table, 0); break;
                case JoinOnConditionAlignment.Indented: _m.AlignTo(cond, on, _tab); break;
            }
        }
    }

    // ---- sottoquery e tabelle derivate ----

    public override void ExplicitVisit(QueryDerivedTable node)
    {
        ArrangeSubquery(node.QueryExpression, StatementAnchor());
        base.ExplicitVisit(node);
    }

    private int StatementAnchor() => _queryStarts.Count > 0 ? _queryStarts.Peek() : -1;

    // Parentesi intorno a una sottoquery secondo lo stile delle parentesi
    private void ArrangeSubquery(QueryExpression query, int baseAnchor)
    {
        int open = _m.PrevCode(_m.FirstCode(query));
        int close = _m.NextCode(_m.Last(query));
        if (open < 0 || close < 0 || _m.Slots[open].Token.TokenType != TSqlTokenType.LeftParenthesis) return;
        int keyword = _m.PrevCode(open);
        // EXISTS (…): la colonna dell'elemento è quella di EXISTS; dopo FROM/JOIN la parentesi è l'elemento
        int item = keyword < 0 ? baseAnchor
            : _m.Slots[keyword].Token.TokenType == TSqlTokenType.Exists ? keyword
            : IsClauseKeyword(keyword) ? open
            : baseAnchor;
        ArrangeParenthesesAfter(open, close, keyword, item, _s.Parentheses.ParenthesisStyle, _s.Parentheses.IndentParenthesesContents);
        if (_s.Dml.CollapseShortSubqueries)
            _m.AddCollapse(open, close, _s.Dml.CollapseSubqueriesShorterThan);
        // anche una sottoquery è uno statement: vale collapseShortStatements (verificato con la CLI)
        if (_s.Dml.CollapseShortStatements)
            _m.AddCollapse(open, close, _s.Dml.CollapseStatementsShorterThan);
        // anche le sottoquery sono parentesi: valgono le soglie delle parentesi
        if (_s.Parentheses.CollapseShortParenthesisContents)
            _m.AddCollapse(open, close, _s.Parentheses.CollapseParenthesesShorterThan);
    }

    // Parola chiave dopo cui la parentesi è il primo elemento della clausola
    private bool IsClauseKeyword(int slot) => _m.Slots[slot].Token.TokenType is TSqlTokenType.From or TSqlTokenType.Join
        or TSqlTokenType.Where or TSqlTokenType.Having or TSqlTokenType.On or TSqlTokenType.Select
        || _m.Slots[slot].Text.Equals("APPLY", StringComparison.OrdinalIgnoreCase);

    // Parentesi dopo una parola chiave (AS di una CTE, EXISTS, AND/OR, IN…) secondo lo stile delle parentesi
    // (verificato con la CLI, una opzione per volta):
    // - compatte: il contenuto segue "("; la "(" resta dopo la parola chiave (simple), va a capo alla
    //   colonna dell'elemento (toStatement), rientrata rispetto alla parola chiave (indented) o
    //   allineata alla sua fine (rightAligned);
    // - espanse: come le compatte per la "(", poi contenuto e ")" su righe proprie alla colonna della "(";
    //   split lascia la "(" dopo la parola chiave e porta contenuto e ")" alla colonna dell'elemento.
    // item è il token che dà la colonna dell'elemento; se è la "(" stessa (primo elemento di una
    // clausola) la parentesi non va a capo.
    // boolean: parentesi di una condizione (AND/OR), con qualche differenza osservata con la CLI
    private void ArrangeParenthesesAfter(int open, int close, int keyword, int item, ParenthesisStyle style, bool indentContents,
        bool boolean = false)
    {
        int first = _m.NextCode(open);
        int last = _m.PrevCode(close);
        if (first < 0 || first > last || keyword < 0) return;
        bool firstItem = item == open;
        bool expanded = style.ToString().StartsWith("Expanded");
        bool openFollows = firstItem || style is ParenthesisStyle.CompactSimple or ParenthesisStyle.ExpandedSimple or ParenthesisStyle.ExpandedSplit;
        if (!openFollows)
        {
            _m.Break(open);
            switch (style)
            {
                case ParenthesisStyle.CompactToStatement:
                case ParenthesisStyle.ExpandedToStatement:
                    _m.AlignTo(open, item, 0);
                    break;
                case ParenthesisStyle.CompactIndented:
                case ParenthesisStyle.ExpandedIndented:
                    _m.AlignTo(open, keyword, _tab);
                    break;
                default:
                    // dopo AND/OR la "(" allineata a destra non sta prima della colonna degli operandi
                    if (boolean && _m.Slots[keyword].Token.TokenType is TSqlTokenType.And or TSqlTokenType.Or)
                        _m.AlignTo(open, item, 0);
                    else
                        _m.AlignTo(open, keyword, 0, AlignKind.Right);
                    break;
            }
        }
        if (expanded && boolean)
        {
            // condizione: il contenuto parte dopo la "(" (sulla sua colonna se la "(" è il primo elemento
            // di WHERE con toStatement/rightAligned); con split la ")" torna alla parola chiave
            int shift = firstItem && style is ParenthesisStyle.ExpandedToStatement or ParenthesisStyle.ExpandedRightAligned ? 0 : 1;
            _m.Break(first);
            _m.AlignRange(first, last, open, shift + (indentContents ? _tab : 0));
            _m.Break(close);
            _m.AlignTo(close, style == ParenthesisStyle.ExpandedSplit ? keyword : open, 0);
        }
        else if (expanded)
        {
            int column = style == ParenthesisStyle.ExpandedSplit && !firstItem ? item : open;
            _m.Break(first);
            _m.AlignRange(first, last, column, indentContents ? _tab : 0);
            _m.Break(close);
            _m.AlignTo(close, column, 0);
        }
        else if (indentContents && style is ParenthesisStyle.CompactSimple or ParenthesisStyle.CompactToStatement)
        {
            // contenuto rientrato anche sulla riga della "(": "(   select"; con le compatte
            // rientrate o allineate a destra la "(" è già rientrata (verificato con la CLI)
            _m.AlignRange(first, last, open, _tab);
            _m.Slots[first].PadInline = true;
        }
        else
        {
            // se il contenuto va a capo (es. dopo un commento) riparte dalla colonna della parentesi
            _m.AlignRange(first, last, open, 0);
        }
    }

    private void ArrangeParentheses(int open, int close, int baseAnchor, ParenthesisStyle style, bool indentContents)
    {
        int first = open + 1;
        int last = close - 1;
        if (first > last) return;
        int contentOffset = indentContents ? _tab : 0;
        switch (style)
        {
            case ParenthesisStyle.ExpandedToStatement:
            case ParenthesisStyle.ExpandedIndented:
            case ParenthesisStyle.ExpandedRightAligned:
            case ParenthesisStyle.ExpandedSplit:
                _m.Break(open);
                _m.AlignTo(open, baseAnchor, style == ParenthesisStyle.ExpandedIndented ? _tab : 0);
                _m.Break(first);
                _m.AlignRange(first, last, open, contentOffset);
                _m.Break(close);
                _m.AlignTo(close, open, 0);
                break;
            case ParenthesisStyle.ExpandedSimple:
                _m.Break(first);
                _m.AlignRange(first, last, baseAnchor, contentOffset);
                _m.Break(close);
                _m.AlignTo(close, baseAnchor, 0);
                break;
            default:
                // compatte: il contenuto segue la parentesi; se va a capo (es. dopo un commento)
                // riparte dalla colonna della parentesi
                _m.AlignRange(first, last, open, 0);
                break;
        }
    }

    // ---- INSERT, UPDATE, DELETE ----

    public override void ExplicitVisit(UpdateSpecification node)
    {
        int update = _m.FirstCode(node);
        var items = new List<int> { _m.NextCode(update) };
        if (node.SetClauses.Count > 0)
        {
            int set = _m.PrevCode(_m.FirstCode(node.SetClauses[0]));
            Clause(set, update);
            ArrangeList(set, node.SetClauses, NewLineMode.Never, _s.Lists.PlaceSubsequentItemsOnNewLines);
            items.Add(_m.FirstCode(node.SetClauses[0]));
        }
        if (node.FromClause != null)
        {
            int kw = _m.FirstCode(node.FromClause);
            Clause(kw, update);
            ArrangeList(kw, node.FromClause.TableReferences, _s.Dml.ListItems.PlaceFromTableOnNewLine, NewLineMode.Always);
            items.Add(_m.FirstCode(node.FromClause.TableReferences[0]));
        }
        if (node.WhereClause != null)
        {
            int kw = _m.FirstCode(node.WhereClause);
            Clause(kw, update);
            if (node.WhereClause.SearchCondition != null)
            {
                FirstItemOnNewLine(kw, node.WhereClause.SearchCondition, _s.Dml.ListItems.PlaceWhereConditionOnNewLine);
                items.Add(_m.FirstCode(node.WhereClause.SearchCondition));
            }
        }
        if (_s.Lists.AlignItemsAcrossClauses && _s.Lists.AlignSubsequentItemsWithFirstItem && _s.Dml.Clauses.ClauseAlignment != ClauseAlignment.RightAligned
            && _m.AddAlignGroup(items) is { } across)
            _m.FollowingGroups.Add(across);
        _queryStarts.Push(update);
        base.ExplicitVisit(node);
        _queryStarts.Pop();
    }

    public override void ExplicitVisit(DeleteSpecification node)
    {
        int delete = _m.FirstCode(node);
        // DELETE destinazione FROM …: gli elementi delle clausole partono dalla stessa colonna;
        // con DELETE FROM destinazione non c'è nulla da incolonnare
        var items = new List<int>();
        if (node.FromClause != null && _m.NextCode(delete) == _m.FirstCode(node.Target)) items.Add(_m.FirstCode(node.Target));
        if (node.FromClause != null)
        {
            int kw = _m.FirstCode(node.FromClause);
            Clause(kw, delete);
            ArrangeList(kw, node.FromClause.TableReferences, _s.Dml.ListItems.PlaceFromTableOnNewLine, NewLineMode.Always);
            items.Add(_m.FirstCode(node.FromClause.TableReferences[0]));
        }
        else if (_s.Dml.ListItems.PlaceFromTableOnNewLine == NewLineMode.Always)
        {
            // DELETE FROM destinazione: la destinazione va a capo nella colonna dopo DELETE
            int target = _m.FirstCode(node.Target);
            _m.Break(target);
            _m.AlignTo(target, delete, _m.Slots[delete].Text.Length + 1);
        }
        if (node.WhereClause != null)
        {
            int kw = _m.FirstCode(node.WhereClause);
            Clause(kw, delete);
            if (node.WhereClause.SearchCondition != null)
            {
                FirstItemOnNewLine(kw, node.WhereClause.SearchCondition, _s.Dml.ListItems.PlaceWhereConditionOnNewLine);
                items.Add(_m.FirstCode(node.WhereClause.SearchCondition));
            }
        }
        if (_s.Lists.AlignItemsAcrossClauses && _s.Lists.AlignSubsequentItemsWithFirstItem && items.Count > 1 && _s.Dml.Clauses.ClauseAlignment != ClauseAlignment.RightAligned
            && _m.AddAlignGroup(items) is { } across)
            _m.FollowingGroups.Add(across);
        _queryStarts.Push(delete);
        base.ExplicitVisit(node);
        _queryStarts.Pop();
    }

    public override void ExplicitVisit(InsertSpecification node)
    {
        int insert = _m.FirstCode(node);
        var cols = _s.InsertStatements.Columns;
        if (node.Columns.Count > 0)
        {
            int open = _m.PrevCode(_m.FirstCode(node.Columns[0]));
            int close = _m.NextCode(_m.Last(node.Columns[^1]));
            // con le colonne compatte semplici il rientro del contenuto non si vede (verificato con la CLI)
            ArrangeParenthesesAfter(open, close, insert, insert, cols.ParenthesisStyle,
                cols.IndentContents && cols.ParenthesisStyle != ParenthesisStyle.CompactSimple);
            ArrangeList(open, node.Columns, NewLineMode.Never, cols.PlaceSubsequentColumnsOnNewLines);
        }
        // dml.placeInsertTableOnNewLine: la tabella di destinazione a capo, rientrata da INSERT
        if (_s.Dml.PlaceInsertTableOnNewLine && node.Target != null)
        {
            int target = _m.FirstCode(node.Target);
            _m.Break(target);
            _m.AlignTo(target, insert, _tab);
        }
        if (node.InsertSource is ValuesInsertSource values)
        {
            // VALUES sotto INSERT, senza il rientro delle clausole (verificato con la CLI)
            int kw = _m.FirstCode(values);
            _m.Break(kw);
            _m.AlignTo(kw, insert, 0);
            var v = _s.InsertStatements.Values;
            // più righe: una per riga, separate come una lista (sempre a capo, verificato con la CLI)
            if (values.RowValues.Count > 1)
                ArrangeList(kw, values.RowValues, NewLineMode.Never, NewLineMode.Always);
            foreach (var row in values.RowValues)
            {
                if (row.ColumnValues.Count == 0) continue;
                int open = _m.PrevCode(_m.FirstCode(row.ColumnValues[0]));
                int close = _m.NextCode(_m.Last(row.ColumnValues[^1]));
                // espanse: come le altre parentesi, con VALUES come riferimento (verificato con la CLI)
                if (v.ParenthesisStyle.ToString().StartsWith("Expanded"))
                    ArrangeParenthesesAfter(open, close, kw, kw, v.ParenthesisStyle, v.IndentContents);
                else
                    ArrangeParentheses(open, close, kw, v.ParenthesisStyle, v.IndentContents);
                ArrangeList(open, row.ColumnValues, NewLineMode.Never, v.PlaceSubsequentValuesOnNewLines);
                // compatte non semplici: la riga di valori va a capo sotto VALUES (verificato con la CLI)
                if (row == values.RowValues[0])
                {
                    switch (v.ParenthesisStyle)
                    {
                        case ParenthesisStyle.CompactToStatement: _m.Break(open); _m.AlignTo(open, kw, 0); break;
                        case ParenthesisStyle.CompactIndented: _m.Break(open); _m.AlignTo(open, kw, _tab); break;
                        case ParenthesisStyle.CompactRightAligned: _m.Break(open); _m.AlignTo(open, kw, 0, AlignKind.Right); break;
                    }
                }
            }
        }
        else if (node.InsertSource is SelectInsertSource sel)
        {
            int first = _m.FirstCode(sel);
            _m.Break(first);
            _m.AlignTo(first, insert, 0);
        }
        _queryStarts.Push(insert);
        base.ExplicitVisit(node);
        _queryStarts.Pop();
    }

    // ---- EXEC ----

    public override void ExplicitVisit(ExecutableProcedureReference node)
    {
        if (node.Parameters.Count > 0)
        {
            int name = _m.Last(node.ProcedureReference);
            ArrangeList(name, node.Parameters, NewLineMode.Never, _s.Lists.PlaceSubsequentItemsOnNewLines);
        }
        base.ExplicitVisit(node);
    }

    // ---- statement DML compattati se corti ----

    // SELECT … INTO tabella: INTO è una clausola, incolonnata con le altre
    private readonly Dictionary<int, int> _selectInto = new();

    public override void ExplicitVisit(SelectStatement node)
    {
        if (node.Into != null && node.QueryExpression is QuerySpecification qs)
        {
            int into = _m.PrevCode(_m.First(node.Into));
            int select = _m.FirstCode(qs);
            Clause(into, select);
            _selectInto[select] = _m.First(node.Into);
        }
        CollapseStatement(node, _s.Dml.CollapseShortStatements, _s.Dml.CollapseStatementsShorterThan);
        base.ExplicitVisit(node);
    }

    public override void ExplicitVisit(UpdateStatement node)
    {
        CollapseStatement(node, _s.Dml.CollapseShortStatements, _s.Dml.CollapseStatementsShorterThan);
        base.ExplicitVisit(node);
    }

    public override void ExplicitVisit(DeleteStatement node)
    {
        CollapseStatement(node, _s.Dml.CollapseShortStatements, _s.Dml.CollapseStatementsShorterThan);
        base.ExplicitVisit(node);
    }

    public override void ExplicitVisit(InsertStatement node)
    {
        CollapseStatement(node, _s.Dml.CollapseShortStatements, _s.Dml.CollapseStatementsShorterThan);
        base.ExplicitVisit(node);
    }

    private void CollapseStatement(TSqlFragment node, bool enabled, int maxLength)
    {
        if (enabled) _m.AddCollapse(_m.FirstCode(node), _m.Last(node), maxLength);
    }
}
