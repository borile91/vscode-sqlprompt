using System.Text.Json;
using System.Text.Json.Serialization;

namespace SqlFormatter.Engine.Style;

// Lettura di uno stile JSON di SQL Prompt: chiavi in camelCase, enum come stringhe senza
// distinzione di maiuscole, chiavi sconosciute ignorate (versioni future del formato).
public static class StyleLoader
{
    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
        Converters = { new JsonStringEnumConverter(allowIntegerValues: false) },
    };

    public static FormattingStyle Parse(string json) =>
        JsonSerializer.Deserialize<FormattingStyle>(json, Options) ?? new FormattingStyle();

    public static FormattingStyle Load(string path) => Parse(File.ReadAllText(path));
}
