> options applied to SELECT, INSERT, UPDATE, DELETE statements

# config 1
  "dml": {
    "placeInsertTableOnNewLine": true,
    "placeDistinctAndTopClausesOnNewLine": true,
    "addNewLineAfterDistinctAndTopClauses": true,
    "collapseStatementsShorterThan": 75,
    "collapseSubqueriesShorterThan": 15,
    "clauses": {
      "clauseAlignment": "toFirstListItem", // or toStatement
      "clauseIndentation": 4
    },
    "listItems": {
      "placeFromTableOnNewLine": "ifMultiple", // or always or never
      "placeWhereConditionOnNewLine": "ifMultiple", // or always or never
      "placeGroupByAndOrderByOnNewLine": "ifMultiple" // or always or never
    }
  }

## result
INSERT
      #Sales
          SELECT
                       TOP ( 5 )
                       SalesTerritory.name AS Name, SUM(SalesLastYear) AS TotalSalesLastYear
              FROM
                       Sales.SalesTerritory
                       INNER JOIN
                             (
                             SELECT N'North America'
                             UNION ALL
                             SELECT N'Europe'
                             ) AS groups(name)
                             ON Sales.SalesTerritory.[Group] = groups.name
              WHERE    SalesLastYear > 0
              GROUP BY SalesTerritory.name;


DELETE FROM temp.jobDurations
    WHERE fullFileName = 'test';


# config 2
  "dml": {
    "collapseStatementsShorterThan": 75,
    "collapseSubqueriesShorterThan": 15,
    "listItems": {
      "placeFromTableOnNewLine": "always",
      "placeWhereConditionOnNewLine": "always",
      "placeGroupByAndOrderByOnNewLine": "always"
    }
  },

## result
INSERT #Sales
SELECT TOP ( 5 ) SalesTerritory.name AS Name, SUM(SalesLastYear) AS TotalSalesLastYear
FROM
       Sales.SalesTerritory
       INNER JOIN
             (
             SELECT N'North America'
             UNION ALL
             SELECT N'Europe'
             ) AS groups(name)
             ON Sales.SalesTerritory.[Group] = groups.name
WHERE
       SalesLastYear > 0
GROUP BY
       SalesTerritory.name;


DELETE FROM
       temp.jobDurations
WHERE
      fullFileName = 'test';

# config 3
  "dml": {
    "collapseShortStatements": true,
    "collapseStatementsShorterThan": 35,
    "collapseShortSubqueries": true,
    "collapseSubqueriesShorterThan": 35
  }

# result
INSERT #Sales
SELECT   TOP ( 5 ) SalesTerritory.name AS Name, SUM(SalesLastYear) AS TotalSalesLastYear
FROM     Sales.SalesTerritory
         INNER JOIN
               (
               SELECT N'North America'
               UNION ALL
               SELECT N'Europe'
               ) AS groups(name)
               ON Sales.SalesTerritory.[Group] = groups.name
WHERE    SalesLastYear > 0
GROUP BY SalesTerritory.name;


DELETE FROM temp.jobDurations
WHERE fullFileName = 'test';