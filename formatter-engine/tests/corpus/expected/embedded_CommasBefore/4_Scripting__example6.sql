create procedure tSample.[test fnListItemsCheckId]
as
begin
    declare @isMode bit = 0;
    declare @codeA    varchar(3)     = 'AAA'
          , @codeB    varchar(3)     = '001'
          , @userCode varchar(10)    = 'user01'
          , @terminal int            = 99
          , @typeCode varchar(1)     = 'X'
          , @nameCode varchar(10)    = 'name01'
          , @docType  varchar(3)     = 'DOC'
          , @docYear  smallint       = year(getdate())
          , @docNum   varchar(20)    = '10001'
          , @docRow   varchar(30)    = '1'
          , @itemCode varchar(40)    = 'ITEM_SAMPLE'
          , @Error    varchar(255)
          , @dtValue  datetime       = getdate()
          , @idValue  int            = 78
          , @qtyValue decimal(12, 3) = 2.152
          , @reasonA  varchar(5)     = iif(@isMode = 1, 'R_A', 'R_B')
          , @reasonB  varchar(5)     = 'R_C'
          , @reasonC  varchar(5)     = 'R_D'
          , @lotCode  nvarchar(20)   = N'LOT001'
          , @dtLot    date           = '20170612'
          , @dtExp    date           = '20180312';

    exec tSQLt.FakeTable @TableName = N'dbo.TABLE_NAME';

    exec tSQLt.FakeTable @TableName = N'dbo.TABLE_TYPE';

    exec tSQLt.FakeTable @TableName = N'dbo.TABLE_LOT';

    exec tSQLt.FakeTable @TableName = N'dbo.TABLE_HEAD';

    exec tSQLt.FakeTable @TableName = N'dbo.TABLE_DETAIL';

    exec tSQLt.FakeTable @TableName = N'dbo.TABLE_ITEM';

    insert dbo.TABLE_TYPE
    (
        COL_TYPE
      , COL_MODE
    )
    values
    (@docType, 2);

    insert into dbo.TABLE_ITEM
    (
        COL_ITEM
      , COL_DESC
    )
    values
    (@itemCode, 'DESC_SAMPLE');

    insert into dbo.TABLE_HEAD
    (
        COL_CODE_A
      , col_code_b
      , COL_TYPE
      , COL_NUM
      , COL_STATE
      , COL_DATE_A
    )
    values
    (@codeA, @codeB, @docType, @docNum, null, getdate());

    insert into dbo.TABLE_DETAIL
    (
        COL_CODE_A
      , col_code_b
      , COL_TYPE
      , COL_NUM
      , COL_ROW
      , COL_ITEM
      , COL_QTY_A
      , ColQtyC
      , col_flag_a
    )
    values
    (@codeA, @codeB, @docType, @docNum, @docRow, @itemCode, 3, 0, @isMode);

    insert into dbo.TABLE_LOT
    (
        id
      , COL_DATE_A
      , col_flag_a
      , COL_TEXT
      , COL_TYPE
      , COL_NUM
      , COL_ROW
      , COL_ITEM
      , COL_DATE_B
      , ColDateC
      , COL_RATIO
    )
    select @idValue
         , getdate()
         , 0
         , @userCode
         , @docType
         , @docNum
         , @docRow
         , @lotCode
         , @dtLot
         , @dtExp
         , 0.0;

    insert into dbo.TABLE_NAME
    (
        COL_TYPE
      , COL_NUM
      , COL_NAME
    )
    values
    (@typeCode, @nameCode, 'name sample');

    if exists
    (
        select 1
        from rf.fnListItems(@codeA, @codeB, @docType, @docNum, null, 1) as src
        where src.H_ID is not null
    )
    begin
        exec tSQLt.Fail @Message0 = N'Id should not be populated';
    end;

    update dbo.TABLE_DETAIL
    set id = @idValue
    where 1 = 1;

    if not exists
    (
        select 1
        from rf.fnListItems(@codeA, @codeB, @docType, @docNum, null, 1) as src
        where src.H_ID = @idValue
    )
    begin
        exec tSQLt.Fail @Message0 = N'Id should be populated';
    end;
end;