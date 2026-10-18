using Microsoft.SqlServer.TransactSql.ScriptDom;

namespace SqlFormatter.Engine;

public static class Keywords
{
    // Token che ScriptDom riconosce come parola chiave: il nome del tipo di token coincide
    // con il testo (senza underscore), es. TSqlTokenType.CurrentUser ↔ CURRENT_USER
    public static bool IsReservedKeyword(TSqlParserToken t)
    {
        if (t.TokenType is TSqlTokenType.Identifier or TSqlTokenType.QuotedIdentifier or TSqlTokenType.Variable
            or TSqlTokenType.AsciiStringLiteral or TSqlTokenType.UnicodeStringLiteral or TSqlTokenType.Integer
            or TSqlTokenType.Numeric or TSqlTokenType.Real or TSqlTokenType.Money or TSqlTokenType.HexLiteral
            or TSqlTokenType.SingleLineComment or TSqlTokenType.MultilineComment or TSqlTokenType.WhiteSpace
            or TSqlTokenType.Label or TSqlTokenType.EndOfFile)
            return false;
        if (t.Text.Length == 0 || !char.IsLetter(t.Text[0])) return false;
        return string.Equals(t.TokenType.ToString(), t.Text.Replace("_", ""), StringComparison.OrdinalIgnoreCase);
    }

    // Funzioni di sistema T-SQL (nomi senza schema)
    public static readonly HashSet<string> BuiltInFunctions = new(StringComparer.OrdinalIgnoreCase)
    {
        // aggregazione e finestra
        "AVG", "CHECKSUM_AGG", "COUNT", "COUNT_BIG", "GROUPING", "GROUPING_ID", "MAX", "MIN", "STDEV", "STDEVP",
        "STRING_AGG", "SUM", "VAR", "VARP", "APPROX_COUNT_DISTINCT", "APPROX_PERCENTILE_CONT", "APPROX_PERCENTILE_DISC",
        "CUME_DIST", "FIRST_VALUE", "LAG", "LAST_VALUE", "LEAD", "PERCENTILE_CONT", "PERCENTILE_DISC", "PERCENT_RANK",
        "DENSE_RANK", "NTILE", "RANK", "ROW_NUMBER",
        // conversione e logica
        "CAST", "CONVERT", "PARSE", "TRY_CAST", "TRY_CONVERT", "TRY_PARSE", "CHOOSE", "IIF", "COALESCE", "NULLIF",
        "ISNULL", "ISNUMERIC", "ISDATE", "GREATEST", "LEAST",
        // stringhe
        "ASCII", "CHAR", "CHARINDEX", "CONCAT", "CONCAT_WS", "DIFFERENCE", "FORMAT", "LEFT", "LEN", "LOWER", "LTRIM",
        "NCHAR", "PATINDEX", "QUOTENAME", "REPLACE", "REPLICATE", "REVERSE", "RIGHT", "RTRIM", "SOUNDEX", "SPACE",
        "STR", "STRING_ESCAPE", "STRING_SPLIT", "STUFF", "SUBSTRING", "TRANSLATE", "TRIM", "UNICODE", "UPPER",
        "DATALENGTH", "COMPRESS", "DECOMPRESS",
        // date
        "CURRENT_TIMESTAMP", "DATEADD", "DATEDIFF", "DATEDIFF_BIG", "DATEFROMPARTS", "DATENAME", "DATEPART",
        "DATETIME2FROMPARTS", "DATETIMEFROMPARTS", "DATETIMEOFFSETFROMPARTS", "DATETRUNC", "DATE_BUCKET", "DAY",
        "EOMONTH", "GETDATE", "GETUTCDATE", "MONTH", "SMALLDATETIMEFROMPARTS", "SWITCHOFFSET", "SYSDATETIME",
        "SYSDATETIMEOFFSET", "SYSUTCDATETIME", "TIMEFROMPARTS", "TODATETIMEOFFSET", "YEAR",
        // matematica
        "ABS", "ACOS", "ASIN", "ATAN", "ATN2", "CEILING", "COS", "COT", "DEGREES", "EXP", "FLOOR", "LOG", "LOG10",
        "PI", "POWER", "RADIANS", "RAND", "ROUND", "SIGN", "SIN", "SQRT", "SQUARE", "TAN",
        // sistema e metadati
        "APP_NAME", "COL_LENGTH", "COL_NAME", "COLUMNPROPERTY", "DATABASEPROPERTYEX", "DB_ID", "DB_NAME",
        "ERROR_LINE", "ERROR_MESSAGE", "ERROR_NUMBER", "ERROR_PROCEDURE", "ERROR_SEVERITY", "ERROR_STATE",
        "FILE_ID", "FILE_NAME", "FORMATMESSAGE", "GET_FILESTREAM_TRANSACTION_CONTEXT", "HOST_ID", "HOST_NAME",
        "IDENT_CURRENT", "IDENT_INCR", "IDENT_SEED", "INDEX_COL", "INDEXPROPERTY", "ISJSON", "JSON_MODIFY",
        "JSON_OBJECT", "JSON_ARRAY", "JSON_QUERY", "JSON_VALUE", "NEWID", "NEWSEQUENTIALID", "OBJECT_DEFINITION",
        "OBJECT_ID", "OBJECT_NAME", "OBJECT_SCHEMA_NAME", "OBJECTPROPERTY", "OBJECTPROPERTYEX", "ORIGINAL_LOGIN",
        "PERMISSIONS", "ROWCOUNT_BIG", "SCHEMA_ID", "SCHEMA_NAME", "SCOPE_IDENTITY", "SERVERPROPERTY",
        "SESSION_CONTEXT", "SUSER_ID", "SUSER_NAME", "SUSER_SID", "SUSER_SNAME", "TYPE_ID", "TYPE_NAME",
        "TYPEPROPERTY", "USER_ID", "USER_NAME", "XACT_STATE", "CHECKSUM", "BINARY_CHECKSUM", "HASHBYTES",
        "CRYPT_GEN_RANDOM", "ENCRYPTBYKEY", "DECRYPTBYKEY", "HAS_PERMS_BY_NAME", "IS_MEMBER", "IS_ROLEMEMBER",
        "IS_SRVROLEMEMBER", "OPENJSON", "OPENQUERY", "OPENROWSET", "OPENXML", "OPENDATASOURCE", "CONTEXT_INFO",
        "CURRENT_REQUEST_ID", "CURRENT_TRANSACTION_ID", "MIN_ACTIVE_ROWVERSION", "TRIGGER_NESTLEVEL",
        "EVENTDATA", "COLUMNS_UPDATED", "UPDATE", "FULLTEXTCATALOGPROPERTY", "FULLTEXTSERVICEPROPERTY",
        "STATS_DATE", "APPLOCK_MODE", "APPLOCK_TEST", "ASSEMBLYPROPERTY", "CERTENCODED", "CERTPRIVATEKEY",
    };
}
