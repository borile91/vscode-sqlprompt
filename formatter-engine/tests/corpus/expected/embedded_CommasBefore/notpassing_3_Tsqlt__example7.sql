create function bib.fnRichiestaListaLibri
(
    @Sede varchar(3)
  , @Sala varchar(3)
  , @TipoSocio varchar(1)
  , @Socio varchar(10)
  , @TipoRic varchar(3)
  , @AnnoRic smallint
  , @NumRic varchar(20)
  , @salaHost varchar(50)
  , @intTutti bit = 0
)
returns table
as
return
(
    -- NON CAMBIARE ORDINE E NOMI COLONNE.
    select rr.LIBRO                                                                          as H_LIBRO
         , eds.IdEdizione                                                                    as H_IdEdizione
         , rr.NUM_PRATICA                                                                    as H_NUM_PRATICA
         , lb.TITOLO                                                                         as H_TITOLO
         , stuff((
                     select char(10) + qry.NOTE as [text()]
                     from
                     (
                         select distinct
                                rr2.NOTE
                         from dbo.RICHIESTE_RIGHE as rr2
                         where rr2.SEDE = rt.SEDE
                               and rr2.SALA = rt.SALA
                               and rr2.TIPO_SOCIO = rt.TIPO_SOCIO
                               and rr2.SOCIO = rt.SOCIO
                               and rr2.TIPO_RIC = rt.TIPO_RIC
                               and rr2.ANNO_RIC = rt.ANNO_RIC
                               and rr2.NUM_RIC = rt.NUM_RIC
                               and rr2.LIBRO = rr.LIBRO
                               and isnull(rr2.NOTE, '') <> ''
                     ) as qry
                     for xml path('')
                 )
               , 1
               , 1
               , ''
                )                                                                            as H_NOTE
         , rr1.GRUPPO                                                                        as H_GRUPPO
         , nullif(sum(isnull(rr.QTA_CTRL, 0) - isnull(rr.QTA_CTRL_OK, 0)), 0)                as H_QTA_CTRL_RESI
         , rr.LIBRO
         , lb.TITOLO + isnull((' (E. ' + convert(varchar(50), eds.IdEdizione) + ')'), '')    as TITOLO
         , iif(sum(rr.QTA_COPIE) > 0, sum(rr.QTA_COPIE), 0)                                  as QTA_COPIE_TOT
         , sum(rr.QTA_LETTE + rr.QTA_SCARTO)                                                 as QTA_LETTE
         , isnull(rr.FORMATO, lb.FORMATO_STD)                                                as FORMATO
         , eds.EDIZIONE
         , replace(convert(varchar(10), eds.DT_EDIZIONE, 103), '/', '')                      as DT_EDIZIONE --formato ddMMyyyy
         , replace(convert(varchar(10), eds.DT_RISTAMPA, 103), '/', '')                      as DT_RISTAMPA --formato ddMMyyyy
         , rr1.GRUPPO                                                                        as RAGGRUPPAMENTO
         , sum(isnull(rr.QTA_CTRL, 0))                                                       as QTA_CTRL
         , sum(isnull(rr.QTA_CTRL_OK, 0))                                                    as QTA_CTRL_OK
         , iif(sum(rr.QTA_LETTE + rr.QTA_SCARTO) >= sum(rr.QTA_COPIE), '#ECBE40', '#FFFFFF') as H_COLOR_BACK
         , '#000000'                                                                         as H_COLOR_FONT
         , lb.id                                                                             as H_ID_LIBRO
         , rr.FLG_LIBERO                                                                     as H_FLG_LIBERO
         , rr.CAUS_BLOCCO                                                                    as H_CAUS_BLOCCO
         , max(rr.SALA_GEST)                                                                 as H_SALA_GEST
    from dbo.RICHIESTE_TESTATA            as rt
        inner join dbo.RICHIESTE_RIGHE    as rr
            on rt.SEDE = rr.SEDE
               and rt.SALA = rr.SALA
               and rt.TIPO_SOCIO = rr.TIPO_SOCIO
               and rt.SOCIO = rr.SOCIO
               and rt.TIPO_RIC = rr.TIPO_RIC
               and rt.ANNO_RIC = rr.ANNO_RIC
               and rt.NUM_RIC = rr.NUM_RIC
        left join dbo.RICHIESTE_RIGHE_EXT as rr1
            on rr1.SEDE = rr.SEDE
               and rr1.SALA = rr.SALA
               and rr1.TIPO_SOCIO = rr.TIPO_SOCIO
               and rr1.SOCIO = rr.SOCIO
               and rr1.TIPO_RIC = rr.TIPO_RIC
               and rr1.ANNO_RIC = rr.ANNO_RIC
               and rr1.NUM_RIC = rr.NUM_RIC
               and rr1.RIGA_RIC = rr.RIGA_RIC
        inner join dbo.LIBRI              as lb
            on rr.LIBRO = lb.LIBRO
        inner join dbo.SOCI               as s
            on rt.TIPO_SOCIO = s.TIPO_SOCIO
               and rt.SOCIO = s.SOCIO
        outer apply
    (
        select ed.IdEdizione -- verifico esistenza dell'edizione impostata nella riga richiesta
             , ed.EDIZIONE
             , ed.DT_EDIZIONE
             , ed.DT_RISTAMPA
        from dbo.Edizione as ed
        where ed.IdEdizione = rr.idEdizione
    )                                     as eds
    where rt.SEDE = @Sede
          and rt.SALA = @Sala
          and rt.TIPO_SOCIO = @TipoSocio
          and rt.SOCIO = @Socio
          and rt.TIPO_RIC = @TipoRic
          and rt.ANNO_RIC = @AnnoRic
          and rt.NUM_RIC = @NumRic
          and
          (
              @intTutti = 1
              or
              (
                  rr.STATO = 'I'
                  or rr.STATO is null
              )
              or
              (
                  rr.RESO = 0
                  and rt.RESO = 0
                  and exists
                      (
                          select 1
                          from dbo.TIPI_RICHIESTA as tr
                          where tr.TIPO_RICHIESTA = rt.TIPO_RIC
                                and tr.QTA_EXTRA = 1
                      )
              )
          )
          and
          (
              rr.SALA_GEST = @salaHost
              or @salaHost is null
              or @salaHost = ''
          )
          and rr.FLG_RISERVA = 0
    group by rt.SEDE
           , rt.SALA
           , rt.TIPO_SOCIO
           , rt.SOCIO
           , s.NOMINATIVO
           , rt.TIPO_RIC
           , rt.ANNO_RIC
           , rt.NUM_RIC
           , rt.STATO
           , rt.D_RIC
           , rr.LIBRO
           , lb.id
           , eds.IdEdizione
           , lb.TITOLO
           , rr.FORMATO
           , lb.FORMATO_STD
           , rr.NUM_PRATICA
           , eds.EDIZIONE
           , eds.DT_EDIZIONE
           , eds.DT_RISTAMPA
           , rr1.GRUPPO
           , rr.FLG_LIBERO
           , rr.CAUS_BLOCCO
);