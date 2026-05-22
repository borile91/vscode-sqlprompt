"joinStatements": {
    "join": {
      "keywordAlignment": "toTable",
      "indentJoinTable": false
    },
    "on": {
      "keywordAlignment": "indented",
      "conditionAlignment": "toInner"
    }
}

# join
## keywordAlignment
### toFrom (default)
SELECT     *
FROM       Person.Address
INNER JOIN Person.StateProvince
      ON StateProvince.StateProvinceID = Address.StateProvinceID
INNER JOIN Sales.SalesTerritory
      ON SalesTerritory.TerritoryID = StateProvince.TerritoryID

### toTable
SELECT *
FROM   Person.Address
       INNER JOIN Person.StateProvince
             ON StateProvince.StateProvinceID = Address.StateProvinceID
       INNER JOIN Sales.SalesTerritory
             ON SalesTerritory.TerritoryID = StateProvince.TerritoryID

# on
## keywordAlignment
### indented (default)
SELECT *
FROM   Person.Address
       INNER JOIN Person.StateProvince
             ON StateProvince.StateProvinceID = Address.StateProvinceID
       INNER JOIN Sales.SalesTerritory
             ON SalesTerritory.TerritoryID = StateProvince.TerritoryID
### toJoin
SELECT *
FROM   Person.Address
       INNER JOIN Person.StateProvince
       ON StateProvince.StateProvinceID = Address.StateProvinceID
       INNER JOIN Sales.SalesTerritory
       ON SalesTerritory.TerritoryID = StateProvince.TerritoryID

### toTable
SELECT *
FROM   Person.Address
       INNER JOIN Person.StateProvince
                  ON StateProvince.StateProvinceID = Address.StateProvinceID
       INNER JOIN Sales.SalesTerritory
                  ON SalesTerritory.TerritoryID = StateProvince.TerritoryID