# config
  "cte": {
    "asAlignment": "leftAligned"
  }

# asAlignment
## leftAligned (default)
WITH myCte
AS ( SELECT 1 a ), mySecondCte ( Col1, Col2 )
AS ( SELECT 'Test' AS ThisIsAColumn, 'Test2' AS ThisIsAnotherColumn
     FROM   Person.BusinessEntityContact )
SELECT * FROM myCte

## rightAligned
WITH myCte
  AS ( SELECT 1 a ), mySecondCte ( Col1, Col2 )
  AS ( SELECT 'Test' AS ThisIsAColumn, 'Test2' AS ThisIsAnotherColumn
       FROM   Person.BusinessEntityContact )
SELECT * FROM myCte

## indented
WITH myCte
    AS ( SELECT 1 a ), mySecondCte ( Col1, Col2 )
    AS ( SELECT 'Test' AS ThisIsAColumn, 'Test2' AS ThisIsAnotherColumn
         FROM   Person.BusinessEntityContact )
SELECT * FROM myCte