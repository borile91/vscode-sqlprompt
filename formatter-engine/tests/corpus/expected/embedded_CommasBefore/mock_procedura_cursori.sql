create procedure [bib].[spRestituzioniElabora]
    @Sede varchar(3)
  , @Reparto varchar(3)
  , @idTessera int
  , @scriviStorico bit            -- scrive anche lo storico
  , @dtInizio datetime
  , @dtFine datetime
  , @utente as varchar(10)
  , @quantita numeric(12, 3) = 0
  , @codiceUmis varchar(5) = null -- unità di misura
  , @Errore varchar(255) output
as
begin
    set nocount on;
    set xact_abort off;
    declare @messaggio varchar(2048);
    declare @transazioneEsterna bit           = 0
          , @causaleCarico      varchar(5)    = 'C_LIB'
          , @causaleScarico     varchar(5)    = 'S_LIB'
          , @qtaDaElaborare     numeric(12, 3)
          , @qtaResidua         numeric(12, 3) --quantità residua da spostare
          , @scaffale           varchar(3)
          , @ripiano            varchar(3)
          , @idPrestito         as int
          , @tolleranza         bit           = 0
          , @titolo             varchar(255)
          , @cursoreRighe       cursor;
    declare @a  int
          , @bb numeric(12, 3)
          , @c  varchar(10)   = 'x'
          , @d  int;
    declare @a2  int
          , @bb2 numeric(12, 3)
          , @c2  varchar(10)
          , @d2  int = 1;
    declare @a3  int = 1
          , @bb3 numeric(12, 3)
          , @c3  varchar(10);
    declare @dt datetime = getdate();
    set @Errore = '';
    set @quantita = isnull(@quantita, 0);
    begin try
        if @@trancount > 0
            set @transazioneEsterna = 1;
        else
        begin
            set @transazioneEsterna = 0;
            begin transaction;
        end;
        if @Reparto not in ( 'ARC', 'MAG' )
        begin
            select top (1)
                   @scaffale = s.SCAFFALE
                 , @ripiano  = s.RIPIANO
            from bib.fnGetPosizioni(@Sede, @Reparto, @idTessera) as s
            order by s.id;
        end
        else if isnull(@tolleranza, 0) = 1
        begin
            set @messaggio = 'tolleranza';
        end;
        set @cursoreRighe = cursor local static read_only forward_only for
        select r.ID_PRESTITO
             , r.TITOLO
        from bib.PRESTITI        as r
            inner join bib.LIBRI as l
                on l.ID_LIBRO = r.ID_LIBRO
        where r.SEDE = @Sede
              and
              (
                  r.STATO = 'I'
                  or r.STATO is null
              )
        order by r.DATA_PRESTITO;
        open @cursoreRighe;
        fetch next from @cursoreRighe
        into @idPrestito
           , @titolo;
        while @@fetch_status = 0
        begin
            exec bib.spPrestitoChiudi @Sede = @Sede
                                    , @Reparto = @Reparto
                                    , @idPrestito = @idPrestito
                                    , @messaggio = @messaggio
                                    , @Errore = @Errore output;
            if @Errore <> ''
                raiserror(   @Errore -- testo del messaggio
                           , 16      -- gravità
                           , 1       -- stato
                         );
            fetch next from @cursoreRighe
            into @idPrestito
               , @titolo;
        end;
        close @cursoreRighe;
        deallocate @cursoreRighe;
        declare CursoreLibri cursor local fast_forward for
        select l.ID_LIBRO
             , l.TITOLO
        from bib.LIBRI as l
        where l.ATTIVO = 1;
        if (@transazioneEsterna = 0)
            commit transaction;
    end try
    begin catch
        if isnull(@Errore, '') = ''
        begin
            set @Errore
                = iif(error_number() <> 50000, convert(varchar(10), error_number()) + ': ', '') + error_message()
                  + ' Proc: ' + isnull(error_procedure(), '') + ' L: ' + convert(varchar(10), error_line());
        end;
        if @transazioneEsterna = 0
           and @@trancount > 0
            rollback transaction;
        raiserror(@Errore, 16, 1);
    end catch;
end;
go
