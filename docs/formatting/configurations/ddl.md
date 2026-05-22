"ddl": {
  "parenthesisStyle": "expandedIndented",
  "indentClauses": true,
  "placeFirstProcedureParameterOnNewLine": "always",
  "collapseStatementsShorterThan": 75
}

# parenthesisStyle
## expandedIndented (default)
CREATE TABLE Production.BillOfMaterials
      (
      BillOfMaterialsID INT IDENTITY(1, 1) NOT NULL PRIMARY KEY NONCLUSTERED ( BillOfMaterialsID ASC )
    , ProductAssemblyID INT NULL
    , ComponentID INT NOT NULL
    , UnitMeasureCode NCHAR(3) NOT NULL FOREIGN KEY REFERENCES UnitMeasures ( ID, Code )
      ) ON [PRIMARY]


GRANT EXECUTE
      ON LogEvent
      TO ts_webapplication;


ALTER AUTHORIZATION
      ON OBJECT::Production.ProductionView006
      TO SCHEMA OWNER;

## indentClauses
### true
CREATE TABLE Production.BillOfMaterials
      (
      BillOfMaterialsID INT IDENTITY(1, 1) NOT NULL PRIMARY KEY NONCLUSTERED ( BillOfMaterialsID ASC )
    , ProductAssemblyID INT NULL
    , ComponentID INT NOT NULL
    , UnitMeasureCode NCHAR(3) NOT NULL FOREIGN KEY REFERENCES UnitMeasures ( ID, Code )
      ) ON [PRIMARY]


GRANT EXECUTE
      ON LogEvent
      TO ts_webapplication;


ALTER AUTHORIZATION
      ON OBJECT::Production.ProductionView006
      TO SCHEMA OWNER;

### false (true)
CREATE TABLE Production.BillOfMaterials
      (
      BillOfMaterialsID INT IDENTITY(1, 1) NOT NULL PRIMARY KEY NONCLUSTERED ( BillOfMaterialsID ASC )
    , ProductAssemblyID INT NULL
    , ComponentID INT NOT NULL
    , UnitMeasureCode NCHAR(3) NOT NULL FOREIGN KEY REFERENCES UnitMeasures ( ID, Code )
      ) ON [PRIMARY]


GRANT EXECUTE
ON LogEvent
TO    ts_webapplication;


ALTER AUTHORIZATION
ON OBJECT::Production.ProductionView006
TO SCHEMA OWNER;