using Microsoft.SqlServer.TransactSql.ScriptDom;
using SqlFormatter.Engine.Layout;
using SqlFormatter.Engine.Style;

namespace SqlFormatter.Engine.Casing;

// Maiuscole/minuscole di parole chiave, funzioni di sistema, tipi di dato e variabili globali.
// I nomi veri (nodi Identifier dell'AST) non si toccano; un token Identifier fuori da un nodo
// Identifier è una parola chiave non riservata (NOCOUNT, NOLOCK, RETURNS…).
public sealed class CasingRules : TSqlFragmentVisitor
{
    private readonly LayoutModel _m;
    private readonly HashSet<int> _names = [];
    private readonly HashSet<int> _functions = [];
    private readonly HashSet<int> _dataTypes = [];
    // nome dichiarato (parametri, DECLARE) per ogni variabile, senza distinzione di maiuscole
    private readonly Dictionary<string, string> _declared = new(StringComparer.OrdinalIgnoreCase);

    private CasingRules(LayoutModel model) => _m = model;

    public static void Apply(LayoutModel model, TSqlScript script, CasingOptions options)
    {
        var rules = new CasingRules(model);
        script.Accept(rules);
        rules.Recase(options);
        if (options.UseObjectDefinitionCase)
            foreach (var batch in script.Batches)
                foreach (var stmt in batch.Statements)
                    AliasCasing.Apply(model, stmt);
    }

    public override void ExplicitVisit(Identifier node)
    {
        for (int i = _m.First(node); i >= 0 && i <= _m.Last(node); i++) _names.Add(i);
        base.ExplicitVisit(node);
    }

    public override void ExplicitVisit(FunctionCall node)
    {
        if (node.CallTarget == null && node.FunctionName != null && Keywords.BuiltInFunctions.Contains(node.FunctionName.Value))
            _functions.Add(_m.First(node.FunctionName));
        base.ExplicitVisit(node);
    }

    // parametri della procedura: valgono anche per i nomi dei parametri di EXEC
    private readonly Dictionary<string, string> _procParams = new(StringComparer.OrdinalIgnoreCase);

    public override void ExplicitVisit(ProcedureParameter node)
    {
        if (node.VariableName != null)
        {
            _declared.TryAdd(node.VariableName.Value, node.VariableName.Value);
            _procParams.TryAdd(node.VariableName.Value, node.VariableName.Value);
        }
        base.ExplicitVisit(node);
    }

    // EXEC p @Param = @var: @Param prende il maiuscolo solo dai parametri della procedura
    // che contiene la chiamata, non dalle variabili DECLARE (verificato con la CLI)
    private readonly HashSet<int> _execParamNames = [];

    public override void ExplicitVisit(ExecuteParameter node)
    {
        if (node.Variable != null) _execParamNames.Add(_m.First(node.Variable));
        base.ExplicitVisit(node);
    }

    public override void ExplicitVisit(DeclareVariableElement node)
    {
        if (node.VariableName != null) _declared.TryAdd(node.VariableName.Value, node.VariableName.Value);
        base.ExplicitVisit(node);
    }

    public override void ExplicitVisit(SqlDataTypeReference node)
    {
        if (node.SqlDataTypeOption != SqlDataTypeOption.None && node.Name != null)
            foreach (var id in node.Name.Identifiers)
                _dataTypes.Add(_m.First(id));
        base.ExplicitVisit(node);
    }

    private void Recase(CasingOptions o)
    {
        for (int i = 0; i < _m.Count; i++)
        {
            var slot = _m.Slots[i];
            var t = slot.Token;
            Style.Casing casing;
            if (_functions.Contains(i)) casing = o.BuiltInFunctions;
            else if (_dataTypes.Contains(i)) casing = o.BuiltInDataTypes;
            else if (t.TokenType == TSqlTokenType.Variable && t.Text.StartsWith("@@")) casing = o.GlobalVariables;
            else if (t.TokenType == TSqlTokenType.Variable)
            {
                // useObjectDefinitionCase: la variabile prende le maiuscole della sua dichiarazione
                var source = _execParamNames.Contains(i) ? _procParams : _declared;
                if (o.UseObjectDefinitionCase && source.TryGetValue(slot.Text, out var declared))
                    slot.Text = declared;
                continue;
            }
            else if (Keywords.IsReservedKeyword(t)) casing = o.ReservedKeywords;
            else if (t.TokenType == TSqlTokenType.Identifier && !_names.Contains(i)) casing = o.ReservedKeywords;
            else continue;
            slot.Text = Apply(slot.Text, casing);
        }
    }

    private static string Apply(string text, Style.Casing casing) => casing switch
    {
        Style.Casing.Uppercase => text.ToUpperInvariant(),
        Style.Casing.Lowercase => text.ToLowerInvariant(),
        Style.Casing.UpperCamelCase => Camel(text, upper: true),
        Style.Casing.LowerCamelCase => Camel(text, upper: false),
        _ => text,
    };

    // Nomi composti di più parole: in camel case ogni parola ha l'iniziale maiuscola
    // (GETDATE → GetDate / getDate, @@ROWCOUNT → @@RowCount / @@rowCount)
    private static readonly Dictionary<string, string> Words = new(StringComparer.OrdinalIgnoreCase)
    {
        ["GETDATE"] = "GetDate", ["GETUTCDATE"] = "GetUtcDate", ["SYSDATETIME"] = "SysDateTime",
        ["SYSUTCDATETIME"] = "SysUtcDateTime", ["SYSDATETIMEOFFSET"] = "SysDateTimeOffset",
        ["DATEADD"] = "DateAdd", ["DATEDIFF"] = "DateDiff", ["DATEDIFF_BIG"] = "DateDiff_Big", ["DATEPART"] = "DatePart",
        ["DATENAME"] = "DateName", ["DATEFROMPARTS"] = "DateFromParts", ["DATETIMEFROMPARTS"] = "DateTimeFromParts",
        ["EOMONTH"] = "EoMonth", ["ISNULL"] = "IsNull", ["ISNUMERIC"] = "IsNumeric", ["ISDATE"] = "IsDate",
        ["NULLIF"] = "NullIf", ["DATALENGTH"] = "DataLength", ["CHARINDEX"] = "CharIndex", ["PATINDEX"] = "PatIndex",
        ["SUBSTRING"] = "SubString", ["LTRIM"] = "LTrim", ["RTRIM"] = "RTrim", ["NEWID"] = "NewId",
        ["NEWSEQUENTIALID"] = "NewSequentialId", ["OBJECT_ID"] = "Object_Id", ["OBJECT_NAME"] = "Object_Name",
        ["DB_NAME"] = "Db_Name", ["DB_ID"] = "Db_Id", ["SCOPE_IDENTITY"] = "Scope_Identity", ["IDENT_CURRENT"] = "Ident_Current",
        ["ROW_NUMBER"] = "Row_Number", ["DENSE_RANK"] = "Dense_Rank", ["COUNT_BIG"] = "Count_Big", ["STRING_AGG"] = "String_Agg",
        ["CONCAT_WS"] = "Concat_Ws", ["ERROR_MESSAGE"] = "Error_Message", ["ERROR_NUMBER"] = "Error_Number",
        ["ERROR_LINE"] = "Error_Line", ["ERROR_SEVERITY"] = "Error_Severity", ["ERROR_STATE"] = "Error_State",
        ["ERROR_PROCEDURE"] = "Error_Procedure", ["TRY_CONVERT"] = "Try_Convert", ["TRY_CAST"] = "Try_Cast",
        ["TRY_PARSE"] = "Try_Parse",
        ["ROWCOUNT"] = "RowCount", ["TRANCOUNT"] = "TranCount", ["FETCH_STATUS"] = "Fetch_Status",
        ["SERVERNAME"] = "ServerName", ["SERVICENAME"] = "ServiceName", ["SPID"] = "SpId", ["DATEFIRST"] = "DateFirst",
        ["PROCID"] = "ProcId", ["LANGUAGE"] = "Language", ["NESTLEVEL"] = "NestLevel",
    };

    private static string Camel(string text, bool upper)
    {
        int p = 0;
        while (p < text.Length && text[p] == '@') p++;
        string prefix = text[..p], name = text[p..];
        if (name.Length == 0) return text;
        string camel = Words.TryGetValue(name, out var w) ? w : char.ToUpperInvariant(name[0]) + name[1..].ToLowerInvariant();
        if (!upper) camel = char.ToLowerInvariant(camel[0]) + camel[1..];
        return prefix + camel;
    }
}

// useObjectDefinitionCase per gli alias di tabella: i riferimenti (T.colonna) prendono le
// maiuscole della definizione (… AS t). Ogni query ha il proprio ambito: valgono gli alias
// della sua FROM e poi quelli delle query che la contengono
internal sealed class AliasCasing : TSqlFragmentVisitor
{
    private readonly LayoutModel _m;
    private readonly List<Dictionary<string, string>> _scopes = [];

    private AliasCasing(LayoutModel model) => _m = model;

    public static void Apply(LayoutModel model, TSqlStatement statement) => statement.Accept(new AliasCasing(model));

    public override void ExplicitVisit(QuerySpecification node) => WithScope(node.FromClause?.TableReferences, () => base.ExplicitVisit(node));
    public override void ExplicitVisit(UpdateSpecification node) => WithScope(Refs(node.FromClause, null), () => { RecaseTarget(node.Target); base.ExplicitVisit(node); });
    public override void ExplicitVisit(DeleteSpecification node) => WithScope(Refs(node.FromClause, null), () => { RecaseTarget(node.Target); base.ExplicitVisit(node); });

    // UPDATE p SET … FROM … AS p: il target è un alias della FROM
    private void RecaseTarget(TableReference? target)
    {
        if (target is not NamedTableReference { SchemaObject.Identifiers.Count: 1 } named) return;
        var id = named.SchemaObject.Identifiers[0];
        if (id.QuoteType != QuoteType.NotQuoted || _scopes.Count == 0) return;
        if (_scopes[^1].TryGetValue(id.Value, out var defined))
        {
            int slot = _m.First(id);
            if (slot >= 0) _m.Slots[slot].Text = defined;
        }
    }

    private static IList<TableReference> Refs(FromClause? from, TableReference? target)
    {
        var list = new List<TableReference>();
        if (from != null) list.AddRange(from.TableReferences);
        if (target != null) list.Add(target);
        return list;
    }

    private void WithScope(IList<TableReference>? refs, Action visit)
    {
        var scope = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (refs != null) foreach (var r in refs) Collect(r, scope);
        _scopes.Add(scope);
        visit();
        _scopes.RemoveAt(_scopes.Count - 1);
    }

    private static void Collect(TableReference r, Dictionary<string, string> scope)
    {
        switch (r)
        {
            case JoinTableReference j:
                Collect(j.FirstTableReference, scope);
                Collect(j.SecondTableReference, scope);
                break;
            case JoinParenthesisTableReference p:
                Collect(p.Join, scope);
                break;
            case TableReferenceWithAlias a when a.Alias != null:
                scope.TryAdd(a.Alias.Value, a.Alias.Value);
                break;
        }
    }

    // qualificatori nei riferimenti a colonna: t.colonna, t.*
    public override void ExplicitVisit(ColumnReferenceExpression node)
    {
        var ids = node.MultiPartIdentifier?.Identifiers;
        if (ids != null && ids.Count >= 2 && ids[^2].QuoteType == QuoteType.NotQuoted)
        {
            var id = ids[^2];
            for (int k = _scopes.Count - 1; k >= 0; k--)
            {
                if (!_scopes[k].TryGetValue(id.Value, out var defined)) continue;
                int slot = _m.First(id);
                if (slot >= 0) _m.Slots[slot].Text = defined;
                break;
            }
        }
        base.ExplicitVisit(node);
    }
}
