  "lists": {
    "placeSubsequentItemsOnNewLines": "never",
    "alignComments": true,
    "placeCommasBeforeItems": true,
    "addSpaceBeforeComma": true,
    "commaAlignment": "toStatement"
}

## placeCommasBeforeItems
### true
SELECT TerritoryID, Name, [Group] -- nvarchar(50)
     , SalesYTD AS YearToDate     -- money
     , SalesLastYear AS LastYear  -- money
FROM   Sales.SalesTerritory

### false (default)
SELECT TerritoryID, Name, [Group] , -- nvarchar(50)
       SalesYTD AS YearToDate ,     -- money
       SalesLastYear AS LastYear    -- money
FROM   Sales.SalesTerritory

## addSpaceBeforeComma
### true (default)
SELECT TerritoryID, Name, [Group] -- nvarchar(50)
     , SalesYTD AS YearToDate     -- money
     , SalesLastYear AS LastYear  -- money
FROM   Sales.SalesTerritory

### false
SELECT TerritoryID, Name, [Group] -- nvarchar(50)
      ,SalesYTD AS YearToDate     -- money
      ,SalesLastYear AS LastYear  -- money
FROM   Sales.SalesTerritory

SELECT TerritoryID, Name, [Group] , -- nvarchar(50)
       SalesYTD AS YearToDate ,     -- money
       SalesLastYear AS LastYear    -- money
FROM   Sales.SalesTerritory

## commaAlignment (valido solo per placeCommasBeforeItems = true)
### toStatement
SELECT TerritoryID, Name, [Group] -- nvarchar(50)
,      SalesYTD AS YearToDate     -- money
,      SalesLastYear AS LastYear  -- money
FROM   Sales.SalesTerritory

### beforeItem
SELECT TerritoryID, Name, [Group] -- nvarchar(50)
     , SalesYTD AS YearToDate     -- money
     , SalesLastYear AS LastYear  -- money
FROM   Sales.SalesTerritory

### toList
SELECT TerritoryID, Name, [Group]  -- nvarchar(50)
       , SalesYTD AS YearToDate    -- money
       , SalesLastYear AS LastYear -- money
FROM   Sales.SalesTerritory