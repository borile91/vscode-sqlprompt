CREATE PROCEDURE rf.spLoadEntity (@codeA VARCHAR(3), @codeB VARCHAR(3), @idRow INT, @qty NUMERIC(12, 3), @unitCode VARCHAR(50) = 'UNITX', @writeAction BIT,
@dtStart DATETIME, @dtEnd DATETIME, @reasonCode VARCHAR(5), @userCode VARCHAR(10), @terminal AS NUMERIC(3, 0), @weight AS NUMERIC(12, 3) = 0,
@docInfo AS VARCHAR(255) = '', @serial AS NVARCHAR(100) = '', @mode VARCHAR(5) = 'STD', @slot VARCHAR(25) = NULL, @slotUnit VARCHAR(50) = NULL,
@blockCode VARCHAR(10) = NULL, @hostCode VARCHAR(50) = NULL, @Error VARCHAR(255) OUTPUT)
AS
SET ANSI_NULLS ON;

SET QUOTED_IDENTIFIER ON;

SET NOCOUNT ON;

SET XACT_ABORT OFF;

DECLARE @msg VARCHAR(2048);
DECLARE @hasOuterTran BIT = 0, @flagA BIT, @flagB BIT, @blockCodeStart VARCHAR(5), @refA VARCHAR(10), @refB INT, @refX INT, @refY INT;

SET @Error = '';
SET @weight = ISNULL(@weight, 0);

    BEGIN TRY
        IF @@TRANCOUNT > 0 SET @hasOuterTran = 1;
        ELSE
            BEGIN
                SET @hasOuterTran = 0;

                BEGIN TRANSACTION;
            END;

        IF @mode NOT IN ('INV', 'ALT')
            BEGIN
                SELECT TOP (1) @flagA = src.COL_FLAG_A, @flagB = src.COL_FLAG_B
                FROM rf.fnGetModeFlags(@codeA, @codeB, @idRow) AS src
                ORDER BY src.id;

                IF ISNULL(@flagA, 0) = 1
                    BEGIN
                        SELECT @idRow = dbo.fnGetDefaultId();
                    END;
                ELSE IF ISNULL(@flagB, 0) = 1
                    BEGIN
                        DECLARE @idFallback INT;

                        SELECT TOP (1) @idFallback = d.id
                        FROM dbo.TABLE_DETAIL AS d
                        WHERE d.COL_CODE_A = @codeA AND d.col_code_b = @codeB AND d.id = @idRow
                        ORDER BY d.id;

                        SET @idRow = COALESCE(@idFallback, @idRow);
                    END;
            END;

        IF NULLIF(@slot, '') IS NOT NULL AND NULLIF(@slotUnit, '') IS NULL
            BEGIN
                SELECT @slotUnit = @unitCode;
            END;

        EXEC rf.spLoadEntity_Check @codeA = @codeA, @codeB = @codeB, @hostCode = @hostCode, @Error = @Error OUTPUT;

        IF ISNULL(@Error, '') <> ''
            BEGIN
                RAISERROR(@Error, 16, 1);
            END;

        IF ISNULL(@hostCode, '') = ''
            BEGIN
                SELECT @hostCode = vh.COL_HOST
                FROM dbo.vwHostMap AS vh
                WHERE vh.COL_CODE_A = @codeA AND vh.col_code_b = @codeB;
            END;

        IF @mode <> 'INV'
            BEGIN
                UPDATE dbo.TABLE_ITEM
                SET COL_QTY = @qty, COL_SYNC = 1
                WHERE COL_ITEM = @docInfo AND ISNULL(COL_QTY, 0) = 0;

                IF @weight > 0
                    BEGIN
                        UPDATE dbo.TABLE_ITEM
                        SET COL_WEIGHT = @weight, COL_SYNC = 1
                        WHERE COL_ITEM = @docInfo AND ISNULL(COL_WEIGHT, 0) <> @weight;
                    END;
            END;

        EXEC ui.HeaderUpdate @codeA = @codeA, @codeB = @codeB, @Unit = @unitCode, @Sign = '+', @userCode = @userCode, @slot = @slot, @ErrText = @Error OUTPUT;

        IF ISNULL(@Error, '') <> ''
            BEGIN
                RAISERROR(@Error, 16, 1);
            END;

        IF @writeAction = 1
            BEGIN
                SELECT @refA = h.COL_REF_A, @refB = h.COL_REF_B, @refX = o.COL_X, @refY = o.COL_Y
                FROM dbo.TABLE_HEADER AS h
                     LEFT JOIN aux.TABLE_POSITION AS o ON o.COL_REF_A = h.COL_REF_A AND o.COL_REF_B = h.COL_REF_B
                WHERE h.COL_CODE_A = @codeA AND h.col_code_b = @codeB;

                SELECT @blockCodeStart = dbo.fnGetBlockCode(@codeA, @codeB, @idRow, 0);

                SET @blockCode = COALESCE(@blockCode, @blockCodeStart);

                EXEC ui.ActionWrite @codeA = @codeA, @codeB = @codeB, @Error = @Error OUTPUT;

                IF ISNULL(@Error, '') <> ''
                    BEGIN
                        RAISERROR(@Error, 16, 1);
                    END;
            END;

        IF @mode NOT IN ('INV', 'ALT') AND ISNULL(@serial, '') <> ''
            BEGIN
                EXEC dbo.spSerialSet @serial = @serial, @idTarget = @idRow, @userCode = @userCode, @dtValue = NULL, @Error = @Error OUTPUT;

                IF ISNULL(@Error, '') <> ''
                    BEGIN
                        RAISERROR(@Error, 16, 1);
                    END;
            END;

        EXEC rf.spCheckRows @codeA = @codeA, @codeB = @codeB, @Error = @Error OUTPUT;

        IF ISNULL(@Error, '') <> ''
            BEGIN
                RAISERROR(@Error, 16, 1);
            END;

        IF (@hasOuterTran = 0) COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF ISNULL(@Error, '') = ''
            BEGIN
                SET @Error = IIF(ERROR_NUMBER() <> 50000, CONVERT(VARCHAR(10), ERROR_NUMBER()) + ': ', '') + ERROR_MESSAGE() + ' Proc: '
                             + ISNULL(ERROR_PROCEDURE(), '') + ' L: ' + CONVERT(VARCHAR(10), ERROR_LINE());
            END;

        IF @hasOuterTran = 0 AND @@TRANCOUNT > 0
            BEGIN
                ROLLBACK TRANSACTION;
            END;

        RAISERROR(@Error, 16, 1);

        RETURN -1;
    END CATCH;

RETURN 0;
GO