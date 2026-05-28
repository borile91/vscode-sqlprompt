# config 1
  "whitespace": {
    "numberOfSpacesInTabs": 4,
    "wrapLinesLongerThan": 200,
    "newLines": {
      "preserveExistingEmptyLinesBetweenStatements": false,
      "preserveExistingEmptyLinesAfterBatchSeparator": false,
      "alignMultilineCommentsMatchingPatterns": true,
      "emptyLinesBetweenStatements": 1,
      "emptyLinesAfterBatchSeparator": 1
    }
  }

# result

USE AdventureWorks;
GO


PRINT 'Test';


SELECT TerritoryID
FROM   Sales.SalesTerritory
WHERE  CountryRegionCode IN ( N'AD', N'AE', N'AF', N'AG', N'AI', N'AL', N'AM', N'AN', N'AO', N'AQ', N'AR', N'AS', N'AT', N'AU', N'AW', N'AZ' ); -- Select TerritoryID from the Sales.SalesTerritory table
                                                                                                                                                -- Filter results based on CountryRegionCode
                                                                                                                                            
# config 2
 "whitespace": {
    "wrapLinesLongerThan": 200,
    "whiteSpaceBeforeSemiColon": "spaceBefore", //or newLineBefore
    "newLines": {
      "alignGroupOfSingleLineComments": false,
      "alignMultilineCommentsMatchingPatterns": false,
      "emptyLinesBetweenStatements": 2,
      "emptyLinesAfterBatchSeparator": 2
    }
  },

# result
USE AdventureWorks ;
GO

PRINT 'Test' ;

SELECT TerritoryID
FROM   Sales.SalesTerritory

WHERE  CountryRegionCode IN ( N'AD', N'AE', N'AF', N'AG', N'AI', N'AL', N'AM', N'AN', N'AO', N'AQ', N'AR', N'AS', N'AT', N'AU', N'AW', N'AZ' ) ; -- Select TerritoryID from the Sales.SalesTerritory table
-- Filter results based on CountryRegionCode