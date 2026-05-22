# config 1
 "variables": {
    "placeAssignedValueOnNewLineIfLongerThanMaxLineLength": false
  }
  
# result
DECLARE @ErrorMessage NVARCHAR(MAX)
      , @ErrorLine    NVARCHAR(5) = CONVERT(NVARCHAR(5), ERROR_LINE())
      , @ErrorNumber  INT         = ERROR_NUMBER();

SET @ErrorMessage = N': Error: ' + CONVERT(NVARCHAR(10), @ErrorNumber) + N' Line: ' + @ErrorLine + N' - ' + ERROR_MESSAGE();

# config 2
  "variables": {
    "alignDataTypesAndValues": false,
    "addSpaceBetweenDataTypeAndPrecision": true,
    "placeEqualsSignOnNewLine": true
  }

# result
DECLARE @ErrorMessage NVARCHAR (MAX)
      , @ErrorLine NVARCHAR (5) = CONVERT(NVARCHAR (5), ERROR_LINE())
      , @ErrorNumber INT = ERROR_NUMBER();

SET @ErrorMessage = N': Error: ' + CONVERT(NVARCHAR (10), @ErrorNumber) + N' Line: ' + @ErrorLine + N' - ' + ERROR_MESSAGE();