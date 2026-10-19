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

    public override void ExplicitVisit(ProcedureParameter node)
    {
        if (node.VariableName != null) _declared.TryAdd(node.VariableName.Value, node.VariableName.Value);
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
                if (o.UseObjectDefinitionCase && _declared.TryGetValue(slot.Text, out var declared)) slot.Text = declared;
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
        Style.Casing.UpperCamelCase => text.Length == 0 ? text : char.ToUpperInvariant(text[0]) + text[1..].ToLowerInvariant(),
        Style.Casing.LowerCamelCase => text.ToLowerInvariant(),
        _ => text,
    };
}
