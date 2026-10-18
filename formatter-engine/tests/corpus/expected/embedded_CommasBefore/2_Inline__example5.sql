alter function rf.fnGetItemsByUnit
(
    @codeA varchar(3)
  , @codeB varchar(3)
  , @unitCode varchar(25)
)
returns @tmp table
(
    COL_ITEM varchar(40)
  , COL_QTY numeric(12, 3)
  , COL_DESC varchar(255)
  , H_COL_ITEM varchar(40)
  , H_COL_DESC varchar(255)
  , H_COL_QTY numeric(12, 3)
  , H_ERROR varchar(255)
)
as
begin
    insert @tmp
    (
        COL_ITEM
      , COL_QTY
      , COL_DESC
      , H_COL_ITEM
      , H_COL_DESC
      , H_COL_QTY
    )
    select d.COL_ITEM
         , sum(d.COL_QTY_A)
         , i.COL_DESC
         , d.COL_ITEM
         , i.COL_DESC
         , sum(d.COL_QTY_A)
    from dbo.TABLE_DETAIL         as d
        inner join dbo.TABLE_ITEM as i
            on d.COL_ITEM = i.COL_ITEM
    where d.COL_CODE_A = @codeA
          and d.col_code_b = @codeB
          and d.COL_NUM = @unitCode
    group by d.COL_ITEM
           , i.COL_DESC;

    insert into @tmp
    (
        COL_ITEM
      , COL_QTY
      , COL_DESC
      , H_COL_ITEM
      , H_COL_DESC
      , H_COL_QTY
      , H_ERROR
    )
    select x.COL_ITEM
         , sum(x.COL_QTY)
         , i.COL_DESC
         , x.COL_ITEM
         , i.COL_DESC
         , sum(x.COL_QTY)
         , x.COL_ERROR
    from rf.fnGetByContainer(@codeA, @codeB, @unitCode) as x
        inner join dbo.TABLE_ITEM                       as i
            on i.COL_ITEM = x.COL_ITEM
    group by x.COL_ITEM
           , i.COL_DESC
           , x.COL_ERROR;

    if not exists (select 1 from @tmp)
    begin
        insert into @tmp
        (
            H_ERROR
        )
        values
        (dbo.fnGetError(50000, default, default, default, default, default, default, default, default, default));
    end;

    return;
end;
go