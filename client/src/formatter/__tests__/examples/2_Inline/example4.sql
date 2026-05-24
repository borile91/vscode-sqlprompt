CREATE VIEW ui.vwSampleSummary
AS
    SELECT h.COL_BATCH, d.COL_SLOT, d.ColGroup, d.COL_TYPE, d.col_year, d.COL_NUM, d.COL_ROW, n.COL_NAME AS [Name Internal], ISNULL(i.COL_ITEM, d.COL_ITEM) AS COL_ITEM, i.COL_ITEM_ORIG
         , i.COL_DESC AS Description, d.COL_RATIO, d.COL_QTY_A, d.col_qty_b, d.COL_QTY_A - d.col_qty_b AS COL_QTY_REMAIN, d.ColQtyC, i.COL_UNIT AS [Unit Base], d.COL_TEXT AS [Unit Row]
         , h.COL_ORDER_ID, ui.fnCheckStatus(h.COL_CODE_A, h.col_code_b, h.ColGroup, h.COL_TYPE, h.col_year, h.COL_NUM) AS [Status Header], d.id AS idD, h.id AS idH, v.id AS idV, h.COL_DATE_REQ
         , IIF(h.COL_DATE_REQ IS NULL, NULL, CAST(h.COL_DATE_REQ AS TIME(0))) AS [Time Request], CASE WHEN d.col_flag_a = 1 THEN '#FFADD8E6'
                                                                                                      WHEN d.ColFlagB = 1 THEN '#FF90EE90'
                                                                                                      ELSE NULL
                                                                                                 END AS H_COLOR_BACK
    FROM   dbo.TABLE_DETAIL AS d ( NOLOCK )
           LEFT JOIN dbo.TABLE_ITEM AS i ( NOLOCK )
               ON d.COL_ITEM = i.COL_ITEM
           INNER JOIN dbo.TABLE_HEADER AS h ( NOLOCK )
               ON h.COL_CODE_A = d.COL_CODE_A
                  AND h.col_code_b = d.col_code_b
                  AND h.ColGroup = d.ColGroup
                  AND h.COL_TYPE = d.COL_TYPE
                  AND h.COL_NUM = d.COL_NUM
                  AND h.col_year = d.col_year
           LEFT JOIN dbo.TABLE_ROUTE AS v ( NOLOCK )
               ON v.COL_CODE_A = h.COL_CODE_A
                  AND v.col_code_b = h.col_code_b
           LEFT JOIN dbo.TABLE_NAME AS n ( NOLOCK )
               ON h.COL_TYPE = n.COL_TYPE
                  AND h.COL_NUM = n.COL_NUM
           OUTER APPLY ( SELECT MIN(m.COL_PRIORITY) AS MIN_PRIORITY
                         FROM   dbo.TABLE_TASK AS m
                         WHERE  m.COL_CODE_A = d.COL_CODE_A
                                AND m.col_code_b = d.col_code_b
                                AND m.ColGroup = d.ColGroup
                                AND m.COL_TYPE = d.COL_TYPE
                                AND m.col_year = d.col_year
                                AND m.COL_NUM = d.COL_NUM
                                AND m.COL_ROW = d.COL_ROW
                                AND ( m.COL_STATE IS NULL
                                      OR m.COL_STATE = 'I' )) AS rowTask;