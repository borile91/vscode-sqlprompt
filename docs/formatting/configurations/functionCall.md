# config
  "functionCalls": {
    "placeArgumentsOnNewLines": "never",
    "addSpacesAroundParentheses": true,
    "addSpacesAroundArgumentList": true,
    "addSpaceBetweenEmptyParentheses": true,
    "addSpaceAfterFunctionCalls": true
  }

## result
SELECT SalesOrderID, DATEPART ( MONTH, DueDate ) AS [MonthDue]
FROM   Sales.SalesOrderHeader
WHERE  DueDate > DATEADD ( MONTH, -6, GETDATE ( ))

# config (default)
  "functionCalls": {
    "placeArgumentsOnNewLines": "wrap",
    "addSpacesAroundParentheses": false,
    "addSpacesAroundArgumentList": false,
    "addSpaceBetweenEmptyParentheses": false,
    "addSpaceAfterFunctionCalls": false
  }

## result
SELECT SalesOrderID, DATEPART ( MONTH, DueDate ) AS [MonthDue]
FROM   Sales.SalesOrderHeader
WHERE  DueDate > DATEADD ( MONTH, -6, GETDATE ( ))