using System.Text.Json;
using System.Text.Json.Nodes;
using SqlFormatter.Engine;
using SqlFormatter.Engine.Style;

// Sidecar del formatter per l'estensione VS Code.
// Modalità predefinita: una richiesta JSON per riga su stdin, una risposta JSON per riga su stdout.
//   richiesta: {"id":1,"sql":"...","style":{...stile SQL Prompt...}}
//   risposta:  {"id":1,"ok":true,"text":"..."}  oppure  {"id":1,"ok":false,"errors":[{"line":1,"column":1,"message":"..."}]}
// Modalità di prova: format <stile.json> <file.sql>  → stampa il risultato su stdout.

if (args.Length == 3 && args[0] == "format")
{
    var style = StyleLoader.Load(args[1]);
    var result = TSqlFormatter.Format(File.ReadAllText(args[2]), style);
    if (!result.Success)
    {
        foreach (var e in result.Errors) Console.Error.WriteLine($"{e.Line}:{e.Column} {e.Message}");
        return 1;
    }
    Console.Out.Write(result.Text);
    return 0;
}

var stdout = Console.OpenStandardOutput();
using var writer = new StreamWriter(stdout) { AutoFlush = true };
string? line;
while ((line = Console.In.ReadLine()) != null)
{
    if (line.Length == 0) continue;
    var response = new JsonObject();
    try
    {
        var request = JsonNode.Parse(line)!.AsObject();
        response["id"] = request["id"]?.DeepClone();
        var style = request["style"] is JsonObject s ? StyleLoader.Parse(s.ToJsonString()) : new FormattingStyle();
        var result = TSqlFormatter.Format(request["sql"]?.GetValue<string>() ?? "", style);
        response["ok"] = result.Success;
        if (result.Success)
            response["text"] = result.Text;
        else
            response["errors"] = new JsonArray(result.Errors
                .Select(e => (JsonNode)new JsonObject { ["line"] = e.Line, ["column"] = e.Column, ["message"] = e.Message })
                .ToArray());
    }
    catch (Exception ex)
    {
        response["ok"] = false;
        response["errors"] = new JsonArray(new JsonObject { ["line"] = 0, ["column"] = 0, ["message"] = ex.Message });
    }
    writer.WriteLine(response.ToJsonString(new JsonSerializerOptions { WriteIndented = false }));
}
return 0;
