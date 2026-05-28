CREATE FUNCTION bib.fnRichiestaListaLibri
    (
        @Sede VARCHAR(3)
      , @Sala VARCHAR(3)
      , @TipoSocio VARCHAR(1)
      , @Socio VARCHAR(10)
      , @TipoRic VARCHAR(3)
      , @AnnoRic SMALLINT
      , @NumRic VARCHAR(20)
      , @salaHost VARCHAR(50)
      , @intTutti BIT = 0
    )
RETURNS TABLE
AS
    RETURN (
           -- NON CAMBIARE ORDINE E NOMI COLONNE.
           SELECT   rr.LIBRO AS H_LIBRO
                  , eds.IdEdizione AS H_IdEdizione
                  , rr.NUM_PRATICA AS H_NUM_PRATICA
                  , lb.TITOLO AS H_TITOLO
                  , STUFF(( SELECT CHAR(10) + qry.NOTE AS [text()]
                            FROM   ( SELECT DISTINCT rr2.NOTE
                                     FROM   dbo.RICHIESTE_RIGHE AS rr2
                                     WHERE  rr2.SEDE = rt.SEDE
                                            AND rr2.SALA = rt.SALA
                                            AND rr2.TIPO_SOCIO = rt.TIPO_SOCIO
                                            AND rr2.SOCIO = rt.SOCIO
                                            AND rr2.TIPO_RIC = rt.TIPO_RIC
                                            AND rr2.ANNO_RIC = rt.ANNO_RIC
                                            AND rr2.NUM_RIC = rt.NUM_RIC
                                            AND rr2.LIBRO = rr.LIBRO
                                            AND ISNULL(rr2.NOTE, '') <> '' ) AS qry
                          FOR XML PATH('')), 1, 1, '') AS H_NOTE
                  , rr1.GRUPPO AS H_GRUPPO
                  , NULLIF(SUM(ISNULL(rr.QTA_CTRL, 0) - ISNULL(rr.QTA_CTRL_OK, 0)), 0) AS H_QTA_CTRL_RESI
                  , rr.LIBRO
                  , lb.TITOLO + ISNULL(( ' (E. ' + CONVERT(VARCHAR(50), eds.IdEdizione) + ')' ), '') AS TITOLO
                  , IIF(SUM(rr.QTA_COPIE) > 0, SUM(rr.QTA_COPIE), 0) AS QTA_COPIE_TOT
                  , SUM(rr.QTA_LETTE + rr.QTA_SCARTO) AS QTA_LETTE
                  , ISNULL(rr.FORMATO, lb.FORMATO_STD) AS FORMATO
                  , eds.EDIZIONE
                  , REPLACE(CONVERT(VARCHAR(10), eds.DT_EDIZIONE, 103), '/', '') AS DT_EDIZIONE --formato ddMMyyyy
                  , REPLACE(CONVERT(VARCHAR(10), eds.DT_RISTAMPA, 103), '/', '') AS DT_RISTAMPA --formato ddMMyyyy
                  , rr1.GRUPPO AS RAGGRUPPAMENTO
                  , SUM(ISNULL(rr.QTA_CTRL, 0)) AS QTA_CTRL
                  , SUM(ISNULL(rr.QTA_CTRL_OK, 0)) AS QTA_CTRL_OK
                  , IIF(SUM(rr.QTA_LETTE + rr.QTA_SCARTO) >= SUM(rr.QTA_COPIE), '#ECBE40', '#FFFFFF') AS H_COLOR_BACK
                  , '#000000' AS H_COLOR_FONT
                  , lb.id AS H_ID_LIBRO
                  , rr.FLG_LIBERO AS H_FLG_LIBERO
                  , rr.CAUS_BLOCCO AS H_CAUS_BLOCCO
                  , MAX(rr.SALA_GEST) AS H_SALA_GEST
           FROM     dbo.RICHIESTE_TESTATA AS rt
                    INNER JOIN dbo.RICHIESTE_RIGHE AS rr
                        ON rt.SEDE = rr.SEDE
                           AND rt.SALA = rr.SALA
                           AND rt.TIPO_SOCIO = rr.TIPO_SOCIO
                           AND rt.SOCIO = rr.SOCIO
                           AND rt.TIPO_RIC = rr.TIPO_RIC
                           AND rt.ANNO_RIC = rr.ANNO_RIC
                           AND rt.NUM_RIC = rr.NUM_RIC
                    LEFT JOIN dbo.RICHIESTE_RIGHE_EXT AS rr1
                        ON rr1.SEDE = rr.SEDE
                           AND rr1.SALA = rr.SALA
                           AND rr1.TIPO_SOCIO = rr.TIPO_SOCIO
                           AND rr1.SOCIO = rr.SOCIO
                           AND rr1.TIPO_RIC = rr.TIPO_RIC
                           AND rr1.ANNO_RIC = rr.ANNO_RIC
                           AND rr1.NUM_RIC = rr.NUM_RIC
                           AND rr1.RIGA_RIC = rr.RIGA_RIC
                    INNER JOIN dbo.LIBRI AS lb
                        ON rr.LIBRO = lb.LIBRO
                    INNER JOIN dbo.SOCI AS s
                        ON rt.TIPO_SOCIO = s.TIPO_SOCIO
                           AND rt.SOCIO = s.SOCIO
                    OUTER APPLY ( SELECT ed.IdEdizione -- verifico esistenza dell'edizione impostata nella riga richiesta
                                       , ed.EDIZIONE
                                       , ed.DT_EDIZIONE
                                       , ed.DT_RISTAMPA
                                  FROM   dbo.Edizione AS ed
                                  WHERE  ed.IdEdizione = rr.idEdizione ) AS eds
           WHERE    rt.SEDE = @Sede
                    AND rt.SALA = @Sala
                    AND rt.TIPO_SOCIO = @TipoSocio
                    AND rt.SOCIO = @Socio
                    AND rt.TIPO_RIC = @TipoRic
                    AND rt.ANNO_RIC = @AnnoRic
                    AND rt.NUM_RIC = @NumRic
                    AND ( @intTutti = 1
                          OR ( rr.STATO = 'I'
                               OR rr.STATO IS NULL )
                          OR ( rr.RESO = 0
                               AND rt.RESO = 0
                               AND EXISTS ( SELECT 1
                                            FROM   dbo.TIPI_RICHIESTA AS tr
                                            WHERE  tr.TIPO_RICHIESTA = rt.TIPO_RIC
                                                   AND tr.QTA_EXTRA = 1 )))
                    AND ( rr.SALA_GEST = @salaHost
                          OR @salaHost IS NULL
                          OR @salaHost = '' )
                    AND rr.FLG_RISERVA = 0
           GROUP BY rt.SEDE, rt.SALA, rt.TIPO_SOCIO, rt.SOCIO, s.NOMINATIVO, rt.TIPO_RIC, rt.ANNO_RIC, rt.NUM_RIC, rt.STATO, rt.D_RIC, rr.LIBRO, lb.id, eds.IdEdizione, lb.TITOLO, rr.FORMATO, lb.FORMATO_STD, rr.NUM_PRATICA, eds.EDIZIONE, eds.DT_EDIZIONE, eds.DT_RISTAMPA, rr1.GRUPPO, rr.FLG_LIBERO, rr.CAUS_BLOCCO );