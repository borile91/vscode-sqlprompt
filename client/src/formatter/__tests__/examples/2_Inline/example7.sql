CREATE FUNCTION rf.fnAcemaListaArticoli
    (
        @Stab VARCHAR(3)
      , @Maga VARCHAR(3)
      , @TipoNomi VARCHAR(1)
      , @Nomi VARCHAR(10)
      , @TipoDocu VARCHAR(3)
      , @AnnoDocu SMALLINT
      , @NumeDocu VARCHAR(20)
      , @magaHost VARCHAR(50)
      , @intTutti BIT = 0
    )
RETURNS TABLE
AS
    RETURN (
           -- NON CAMBIARE ORDINE E NOMI COLONNE.
           SELECT   ad.ARTI AS H_ARTI, ll.IdLotto AS H_IdLotto, ad.NUM_COMMESSA AS H_NUM_COMMESSA, a.DSCR AS H_DSCR, STUFF(( SELECT CHAR(10) + qry.NOTE AS [text()]
                                                                                                                             FROM   ( SELECT DISTINCT ad2.NOTE
                                                                                                                                      FROM   dbo.ACEMA_DETTAGLIO AS ad2
                                                                                                                                      WHERE  ad2.STAB = act.STAB
                                                                                                                                             AND ad2.MAGA = act.MAGA
                                                                                                                                             AND ad2.TIPO_NOMI = act.TIPO_NOMI
                                                                                                                                             AND ad2.NOMI = act.NOMI
                                                                                                                                             AND ad2.TIPO_DOCU = act.TIPO_DOCU
                                                                                                                                             AND ad2.ANNO_DOCU = act.ANNO_DOCU
                                                                                                                                             AND ad2.NUME_DOCU = act.NUME_DOCU
                                                                                                                                             AND ad2.ARTI = ad.ARTI
                                                                                                                                             AND ISNULL(ad2.NOTE, '') <> '' ) AS qry
                                                                                                                           FOR XML PATH('')), 1, 1, '') AS H_NOTE, ad1.RAGG_RF AS H_RAGG_RF
                  , NULLIF(SUM(ISNULL(ad.QTA_CQ, 0) - ISNULL(ad.QTA_CQ_SPUN, 0)), 0) AS H_QTA_CQ_RESI, ad.ARTI, a.DSCR + ISNULL(( ' (L. ' + CONVERT(VARCHAR(50), ll.IdLotto) + ')' ), '') AS DSCR
                  , IIF(SUM(ad.QTA_PEZZ) > 0, SUM(ad.QTA_PEZZ), 0) AS QTA_PEZZI, SUM(ad.QTA_PZ_SPUN + ad.QTA_SCAR) AS QTA_PZ_SPUN, ISNULL(ad.UMIS, a.UMIS_STD) AS UMIS, ll.LOTTO
                  , REPLACE(CONVERT(VARCHAR(10), ll.DT_LOTTO, 103), '/', '') AS DT_LOTTO --formato ddMMyyyy
                  , REPLACE(CONVERT(VARCHAR(10), ll.DT_SCAD, 103), '/', '') AS DT_SCAD   --formato ddMMyyyy
                  , ad1.RAGG_RF AS RAGGRUPPAMENTO, SUM(ISNULL(ad.QTA_CQ, 0)) AS QTA_CQ, SUM(ISNULL(ad.QTA_CQ_SPUN, 0)) AS QTA_CQ_SPUN
                  , IIF(SUM(ad.QTA_PZ_SPUN + ad.QTA_SCAR) >= SUM(ad.QTA_PEZZ), '#ECBE40', '#FFFFFF') AS H_COLOR_BACK, '#000000' AS H_COLOR_FONT, a.id AS H_ID_ARTI, ad.FLG_FREEPASS AS H_FLG_FREEPASS
                  , ad.CAUS_BLOC AS H_CAUS_BLOC, MAX(ad.MAGA_GEST) AS H_MAGA_GEST
           FROM     dbo.ACEMA_TESTATE AS act
                    INNER JOIN dbo.ACEMA_DETTAGLIO AS ad
                        ON act.STAB = ad.STAB
                           AND act.MAGA = ad.MAGA
                           AND act.TIPO_NOMI = ad.TIPO_NOMI
                           AND act.NOMI = ad.NOMI
                           AND act.TIPO_DOCU = ad.TIPO_DOCU
                           AND act.ANNO_DOCU = ad.ANNO_DOCU
                           AND act.NUME_DOCU = ad.NUME_DOCU
                    LEFT JOIN dbo.ACEMA_DETTAGLIO_1 AS ad1
                        ON ad1.STAB = ad.STAB
                           AND ad1.MAGA = ad.MAGA
                           AND ad1.TIPO_NOMI = ad.TIPO_NOMI
                           AND ad1.NOMI = ad.NOMI
                           AND ad1.TIPO_DOCU = ad.TIPO_DOCU
                           AND ad1.ANNO_DOCU = ad.ANNO_DOCU
                           AND ad1.NUME_DOCU = ad.NUME_DOCU
                           AND ad1.RIGA_DOCU = ad.RIGA_DOCU
                    INNER JOIN dbo.ARTICOLI AS a
                        ON ad.ARTI = a.ARTI
                    INNER JOIN dbo.NOMINATIVI AS N
                        ON act.TIPO_NOMI = N.TIPO_NOMI
                           AND act.NOMI = N.NOMI
                    OUTER APPLY ( SELECT l.IdLotto -- verifico esistenza del lotto impostato in acema_dettaglio
                                       , l.LOTTO, l.DT_LOTTO, l.DT_SCAD
                                  FROM   dbo.Lotto AS l
                                  WHERE  l.IdLotto = ad.idLotto ) AS ll
           WHERE    act.STAB = @Stab
                    AND act.MAGA = @Maga
                    AND act.TIPO_NOMI = @TipoNomi
                    AND act.NOMI = @Nomi
                    AND act.TIPO_DOCU = @TipoDocu
                    AND act.ANNO_DOCU = @AnnoDocu
                    AND act.NUME_DOCU = @NumeDocu
                    AND ( @intTutti = 1
                          OR ( ad.STATO = 'I'
                               OR ad.STATO IS NULL )
                          OR ( ad.REST = 0
                               AND act.REST = 0
                               AND EXISTS ( SELECT 1
                                            FROM   dbo.TIPO_ORDINE_ACEMA AS toa
                                            WHERE  toa.TIPO_ORDINE = act.TIPO_DOCU
                                                   AND toa.QTA_EXTRA = 1 )))
                    AND ( ad.MAGA_GEST = @magaHost
                          OR @magaHost IS NULL
                          OR @magaHost = '' )
                    AND ad.FLG_KANBAN = 0
           GROUP BY act.STAB, act.MAGA, act.TIPO_NOMI, act.NOMI, N.RAG_SOC, act.TIPO_DOCU, act.ANNO_DOCU, act.NUME_DOCU, act.STATO, act.D_DOCU, ad.ARTI, a.id, ll.IdLotto, a.DSCR, ad.UMIS, a.UMIS_STD
                  , ad.NUM_COMMESSA, ll.LOTTO, ll.DT_LOTTO, ll.DT_SCAD, ad1.RAGG_RF, ad.FLG_FREEPASS, ad.CAUS_BLOC );