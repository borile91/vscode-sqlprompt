  "controlFlow": {
    "indentBeginAndEndKeywords": true,
    "indentContentsOfStatements": false,
    "collapseStatementsShorterThan": 78
  }

## indentBeginAndEndKeywords
### true
WHILE @@ROWCOUNT > 20
      BEGIN
      IF @BusinessEntityID > 0
      DELETE FROM HumanResources.Employee_Temporal
      WHERE BusinessEntityID = @BusinessEntityID;
      ELSE
      BREAK;


      IF @OldId < 2000
      RETURN @OldId;
      END;

### false (default)
WHILE @@ROWCOUNT > 20
BEGIN
IF @BusinessEntityID > 0
DELETE FROM HumanResources.Employee_Temporal
WHERE BusinessEntityID = @BusinessEntityID;
ELSE
BREAK;


IF @OldId < 2000
RETURN @OldId;
END;

## indentContentsOfStatements
### true (default)
WHILE @@ROWCOUNT > 20
      BEGIN
            IF @BusinessEntityID > 0
                  DELETE FROM HumanResources.Employee_Temporal
                  WHERE BusinessEntityID = @BusinessEntityID;
            ELSE
                  BREAK;


            IF @OldId < 2000
                  RETURN @OldId;
      END;

### false
WHILE @@ROWCOUNT > 20
      BEGIN
      IF @BusinessEntityID > 0
      DELETE FROM HumanResources.Employee_Temporal
      WHERE BusinessEntityID = @BusinessEntityID;
      ELSE
      BREAK;


      IF @OldId < 2000
      RETURN @OldId;
      END;