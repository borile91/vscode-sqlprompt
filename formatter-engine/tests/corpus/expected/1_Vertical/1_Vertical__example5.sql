ALTER FUNCTION rf.fnGetItemsByUnit
    (
    @codeA VARCHAR(3)
  , @codeB VARCHAR(3)
  , @unitCode VARCHAR(25)
    )
RETURNS @tmp TABLE
    (
    COL_ITEM VARCHAR(40)
  , COL_QTY NUMERIC(12, 3)
  , COL_DESC VARCHAR(255)
  , H_COL_ITEM VARCHAR(40)
  , H_COL_DESC VARCHAR(255)
  , H_COL_QTY NUMERIC(12, 3)
  , H_ERROR VARCHAR(255)
    )
AS
    BEGIN
        INSERT @tmp ( COL_ITEM
                    , COL_QTY
                    , COL_DESC
                    , H_COL_ITEM
                    , H_COL_DESC
                    , H_COL_QTY )
        SELECT   d.COL_ITEM
               , SUM(d.COL_QTY_A)
               , i.COL_DESC
               , d.COL_ITEM
               , i.COL_DESC
               , SUM(d.COL_QTY_A)
        FROM     dbo.TABLE_DETAIL AS d
                 INNER JOIN dbo.TABLE_ITEM AS i
                     ON d.COL_ITEM = i.COL_ITEM
        WHERE    d.COL_CODE_A = @codeA
                 AND d.col_code_b = @codeB
                 AND d.COL_NUM = @unitCode
        GROUP BY d.COL_ITEM
               , i.COL_DESC;

        INSERT INTO @tmp ( COL_ITEM
                         , COL_QTY
                         , COL_DESC
                         , H_COL_ITEM
                         , H_COL_DESC
                         , H_COL_QTY
                         , H_ERROR )
        SELECT   x.COL_ITEM
               , SUM(x.COL_QTY)
               , i.COL_DESC
               , x.COL_ITEM
               , i.COL_DESC
               , SUM(x.COL_QTY)
               , x.COL_ERROR
        FROM     rf.fnGetByContainer(@codeA, @codeB, @unitCode) AS x
                 INNER JOIN dbo.TABLE_ITEM AS i
                     ON i.COL_ITEM = x.COL_ITEM
        GROUP BY x.COL_ITEM
               , i.COL_DESC
               , x.COL_ERROR;

        IF NOT EXISTS ( SELECT 1
                        FROM   @tmp )
            BEGIN
                INSERT INTO @tmp ( H_ERROR )
                VALUES ( dbo.fnGetError(50000, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT));
            END;

        RETURN;
    END;
GO