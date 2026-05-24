CREATE PROCEDURE tSample.[test fnListItemsCheckId]
AS
    BEGIN
        DECLARE @isMode BIT = 0;
        DECLARE @codeA VARCHAR(3) = 'AAA', @codeB VARCHAR(3) = '001', @userCode VARCHAR(10) = 'user01', @terminal INT = 99, @typeCode VARCHAR(1) = 'X', @nameCode VARCHAR(10) = 'name01'
              , @docType VARCHAR(3) = 'DOC', @docYear SMALLINT = YEAR(GETDATE()), @docNum VARCHAR(20) = '10001', @docRow VARCHAR(30) = '1', @itemCode VARCHAR(40) = 'ITEM_SAMPLE', @Error VARCHAR(255)
              , @dtValue DATETIME = GETDATE(), @idValue INT = 78, @qtyValue DECIMAL(12, 3) = 2.152, @reasonA VARCHAR(5) = IIF(@isMode = 1, 'R_A', 'R_B'), @reasonB VARCHAR(5) = 'R_C'
              , @reasonC VARCHAR(5) = 'R_D', @lotCode NVARCHAR(20) = N'LOT001', @dtLot DATE = '20170612', @dtExp DATE = '20180312';

        EXEC tSQLt.FakeTable @TableName = N'dbo.TABLE_NAME';

        EXEC tSQLt.FakeTable @TableName = N'dbo.TABLE_TYPE';

        EXEC tSQLt.FakeTable @TableName = N'dbo.TABLE_LOT';

        EXEC tSQLt.FakeTable @TableName = N'dbo.TABLE_HEAD';

        EXEC tSQLt.FakeTable @TableName = N'dbo.TABLE_DETAIL';

        EXEC tSQLt.FakeTable @TableName = N'dbo.TABLE_ITEM';

        INSERT dbo.TABLE_TYPE (
                                  COL_TYPE, COL_MODE
                              )
        VALUES ( @docType, 2 );

        INSERT INTO dbo.TABLE_ITEM (
                                       COL_ITEM, COL_DESC
                                   )
        VALUES ( @itemCode, 'DESC_SAMPLE' );

        INSERT INTO dbo.TABLE_HEAD (
                                       COL_CODE_A, col_code_b, COL_TYPE, COL_NUM, COL_STATE, COL_DATE_A
                                   )
        VALUES ( @codeA, @codeB, @docType, @docNum, NULL, GETDATE());

        INSERT INTO dbo.TABLE_DETAIL (
                                         COL_CODE_A, col_code_b, COL_TYPE, COL_NUM, COL_ROW, COL_ITEM, COL_QTY_A, ColQtyC, col_flag_a
                                     )
        VALUES ( @codeA, @codeB, @docType, @docNum, @docRow, @itemCode, 3, 0, @isMode );

        INSERT INTO dbo.TABLE_LOT (
                                      id, COL_DATE_A, col_flag_a, COL_TEXT, COL_TYPE, COL_NUM, COL_ROW, COL_ITEM, COL_DATE_B, ColDateC, COL_RATIO
                                  )
        SELECT @idValue, GETDATE(), 0, @userCode, @docType, @docNum, @docRow, @lotCode, @dtLot, @dtExp, 0.0;

        INSERT INTO dbo.TABLE_NAME (
                                       COL_TYPE, COL_NUM, COL_NAME
                                   )
        VALUES ( @typeCode, @nameCode, 'name sample' );

        IF EXISTS ( SELECT 1
                    FROM   rf.fnListItems(@codeA, @codeB, @docType, @docNum, NULL, 1) AS src
                    WHERE  src.H_ID IS NOT NULL )
            BEGIN
                EXEC tSQLt.Fail @Message0 = N'Id should not be populated';
            END;

        UPDATE dbo.TABLE_DETAIL
        SET    id = @idValue
        WHERE  1 = 1;

        IF NOT EXISTS ( SELECT 1
                        FROM   rf.fnListItems(@codeA, @codeB, @docType, @docNum, NULL, 1) AS src
                        WHERE  src.H_ID = @idValue )
            BEGIN
                EXEC tSQLt.Fail @Message0 = N'Id should be populated';
            END;
    END;