create procedure rf.spLoadEntity
(
    @codeA varchar(3)
  , @codeB varchar(3)
  , @idRow int
  , @qty numeric(12, 3)
  , @unitCode varchar(50) = 'UNITX'
  , @writeAction bit
  , @dtStart datetime
  , @dtEnd datetime
  , @reasonCode varchar(5)
  , @userCode varchar(10)
  , @terminal as numeric(3, 0)
  , @weight as numeric(12, 3) = 0
  , @docInfo as varchar(255) = ''
  , @serial as nvarchar(100) = ''
  , @mode varchar(5) = 'STD'
  , @slot varchar(25) = null
  , @slotUnit varchar(50) = null
  , @blockCode varchar(10) = null
  , @hostCode varchar(50) = null
  , @Error varchar(255) output
)
as
set ansi_nulls on;

set quoted_identifier on;

set nocount on;

set xact_abort off;

declare @msg varchar(2048);
declare @hasOuterTran   bit = 0
      , @flagA          bit
      , @flagB          bit
      , @blockCodeStart varchar(5)
      , @refA           varchar(10)
      , @refB           int
      , @refX           int
      , @refY           int;

set @Error = '';
set @weight = isnull(@weight, 0);

begin try
    if @@trancount > 0
        set @hasOuterTran = 1;
    else
    begin
        set @hasOuterTran = 0;

        begin transaction;
    end;

    if @mode not in ( 'INV', 'ALT' )
    begin
        select top (1)
               @flagA = src.COL_FLAG_A
             , @flagB = src.COL_FLAG_B
        from rf.fnGetModeFlags(@codeA, @codeB, @idRow) as src
        order by src.id;

        if isnull(@flagA, 0) = 1
        begin
            select @idRow = dbo.fnGetDefaultId();
        end;
        else if isnull(@flagB, 0) = 1
        begin
            declare @idFallback int;

            select top (1)
                   @idFallback = d.id
            from dbo.TABLE_DETAIL as d
            where d.COL_CODE_A = @codeA
                  and d.col_code_b = @codeB
                  and d.id = @idRow
            order by d.id;

            set @idRow = coalesce(@idFallback, @idRow);
        end;
    end;

    if nullif(@slot, '') is not null
       and nullif(@slotUnit, '') is null
    begin
        select @slotUnit = @unitCode;
    end;

    exec rf.spLoadEntity_Check @codeA = @codeA
                             , @codeB = @codeB
                             , @hostCode = @hostCode
                             , @Error = @Error output;

    if isnull(@Error, '') <> ''
    begin
        raiserror(@Error, 16, 1);
    end;

    if isnull(@hostCode, '') = ''
    begin
        select @hostCode = vh.COL_HOST
        from dbo.vwHostMap as vh
        where vh.COL_CODE_A = @codeA
              and vh.col_code_b = @codeB;
    end;

    if @mode <> 'INV'
    begin
        update dbo.TABLE_ITEM
        set COL_QTY = @qty
          , COL_SYNC = 1
        where COL_ITEM = @docInfo
              and isnull(COL_QTY, 0) = 0;

        if @weight > 0
        begin
            update dbo.TABLE_ITEM
            set COL_WEIGHT = @weight
              , COL_SYNC = 1
            where COL_ITEM = @docInfo
                  and isnull(COL_WEIGHT, 0) <> @weight;
        end;
    end;

    exec ui.HeaderUpdate @codeA = @codeA
                       , @codeB = @codeB
                       , @Unit = @unitCode
                       , @Sign = '+'
                       , @userCode = @userCode
                       , @slot = @slot
                       , @ErrText = @Error output;

    if isnull(@Error, '') <> ''
    begin
        raiserror(@Error, 16, 1);
    end;

    if @writeAction = 1
    begin
        select @refA = h.COL_REF_A
             , @refB = h.COL_REF_B
             , @refX = o.COL_X
             , @refY = o.COL_Y
        from dbo.TABLE_HEADER            as h
            left join aux.TABLE_POSITION as o
                on o.COL_REF_A = h.COL_REF_A
                   and o.COL_REF_B = h.COL_REF_B
        where h.COL_CODE_A = @codeA
              and h.col_code_b = @codeB;

        select @blockCodeStart = dbo.fnGetBlockCode(@codeA, @codeB, @idRow, 0);

        set @blockCode = coalesce(@blockCode, @blockCodeStart);

        exec ui.ActionWrite @codeA = @codeA
                          , @codeB = @codeB
                          , @Error = @Error output;

        if isnull(@Error, '') <> ''
        begin
            raiserror(@Error, 16, 1);
        end;
    end;

    if @mode not in ( 'INV', 'ALT' )
       and isnull(@serial, '') <> ''
    begin
        exec dbo.spSerialSet @serial = @serial
                           , @idTarget = @idRow
                           , @userCode = @userCode
                           , @dtValue = null
                           , @Error = @Error output;

        if isnull(@Error, '') <> ''
        begin
            raiserror(@Error, 16, 1);
        end;
    end;

    exec rf.spCheckRows @codeA = @codeA
                      , @codeB = @codeB
                      , @Error = @Error output;

    if isnull(@Error, '') <> ''
    begin
        raiserror(@Error, 16, 1);
    end;

    if (@hasOuterTran = 0)
        commit transaction;
end try
begin catch
    if isnull(@Error, '') = ''
    begin
        set @Error
            = iif(error_number() <> 50000, convert(varchar(10), error_number()) + ': ', '') + error_message()
              + ' Proc: ' + isnull(error_procedure(), '') + ' L: ' + convert(varchar(10), error_line());
    end;

    if @hasOuterTran = 0
       and @@trancount > 0
    begin
        rollback transaction;
    end;

    raiserror(@Error, 16, 1);

    return -1;
end catch;

return 0;
go