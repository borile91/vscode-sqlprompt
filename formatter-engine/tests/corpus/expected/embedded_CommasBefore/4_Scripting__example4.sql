create view ui.vwSampleSummary
as
select h.COL_BATCH
     , d.COL_SLOT
     , d.ColGroup
     , d.COL_TYPE
     , d.col_year
     , d.COL_NUM
     , d.COL_ROW
     , n.COL_NAME                                                                                  as [Name Internal]
     , isnull(i.COL_ITEM, d.COL_ITEM)                                                              as COL_ITEM
     , i.COL_ITEM_ORIG
     , i.COL_DESC                                                                                  as Description
     , d.COL_RATIO
     , d.COL_QTY_A
     , d.col_qty_b
     , d.COL_QTY_A - d.col_qty_b                                                                   as COL_QTY_REMAIN
     , d.ColQtyC
     , i.COL_UNIT                                                                                  as [Unit Base]
     , d.COL_TEXT                                                                                  as [Unit Row]
     , h.COL_ORDER_ID
     , ui.fnCheckStatus(h.COL_CODE_A, h.col_code_b, h.ColGroup, h.COL_TYPE, h.col_year, h.COL_NUM) as [Status Header]
     , d.id                                                                                        as idD
     , h.id                                                                                        as idH
     , v.id                                                                                        as idV
     , h.COL_DATE_REQ
     , iif(h.COL_DATE_REQ is null, null, cast(h.COL_DATE_REQ as time(0)))                          as [Time Request]
     , case
           when d.col_flag_a = 1 then
               '#FFADD8E6'
           when d.ColFlagB = 1 then
               '#FF90EE90'
           else
               null
       end                                                                                         as H_COLOR_BACK
from dbo.TABLE_DETAIL           as d (nolock)
    left join dbo.TABLE_ITEM    as i (nolock)
        on d.COL_ITEM = i.COL_ITEM
    inner join dbo.TABLE_HEADER as h (nolock)
        on h.COL_CODE_A = d.COL_CODE_A
           and h.col_code_b = d.col_code_b
           and h.ColGroup = d.ColGroup
           and h.COL_TYPE = d.COL_TYPE
           and h.COL_NUM = d.COL_NUM
           and h.col_year = d.col_year
    left join dbo.TABLE_ROUTE   as v (nolock)
        on v.COL_CODE_A = h.COL_CODE_A
           and v.col_code_b = h.col_code_b
    left join dbo.TABLE_NAME    as n (nolock)
        on h.COL_TYPE = n.COL_TYPE
           and h.COL_NUM = n.COL_NUM
    outer apply
(
    select min(m.COL_PRIORITY) as MIN_PRIORITY
    from dbo.TABLE_TASK as m
    where m.COL_CODE_A = d.COL_CODE_A
          and m.col_code_b = d.col_code_b
          and m.ColGroup = d.ColGroup
          and m.COL_TYPE = d.COL_TYPE
          and m.col_year = d.col_year
          and m.COL_NUM = d.COL_NUM
          and m.COL_ROW = d.COL_ROW
          and
          (
              m.COL_STATE is null
              or m.COL_STATE = 'I'
          )
)                               as rowTask;