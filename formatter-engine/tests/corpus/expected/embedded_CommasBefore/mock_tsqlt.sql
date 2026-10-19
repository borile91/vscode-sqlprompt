
--  Commenti del test.
--  Esempi: vedi la guida di tSQLt.
create procedure [tBiblioteca].[test spRestituzioniElabora_ChiudePrestitiAperti]
as
begin
    --Assemble
    declare @sede      varchar(3)   = 'MI1'
          , @reparto   varchar(3)   = 'ARC'
          , @idTessera int          = 42
          , @errore    varchar(255) = '';
    exec tSQLt.FakeTable @TableName = N'bib.PRESTITI';
    exec tSQLt.FakeTable @TableName = N'bib.LIBRI', @Identity = 1;
    insert into bib.LIBRI
    (
        ID_LIBRO
      , TITOLO
      , ATTIVO
    )
    values
    (1, 'Primo', 1)
  , (2, 'Secondo', 1)
  , (3, 'Terzo', 0);
    insert into bib.PRESTITI
    (
        ID_PRESTITO
      , ID_SOCIO
      , ID_LIBRO
      , STATO
    )
    values
    (10, 42, 1, null) --aperto
  , (11, 42, 2, 'C')  --chiuso
  , (12, 7, 3, null); --altro socio
                      --Act
    exec bib.spRestituzioniElabora @Sede = @sede
                                 , @Reparto = @reparto
                                 , @idTessera = @idTessera
                                 , @scriviStorico = 0
                                 , @dtInizio = null -- datetime
                                 , @dtFine = null   -- datetime
                                 , @utente = 'test'
                                 , @Errore = @errore output;
    --Assert
    select ID_PRESTITO
         , STATO
    into testTools.actual
    from bib.PRESTITI;
    select top (0)
           *
    into testTools.expected
    from testTools.actual;
    insert into testTools.expected
    (
        ID_PRESTITO
      , STATO
    )
    values
    (10, 'C')
  , (11, 'C')
  , (12, null);
    exec tSQLt.AssertEqualsTable @Expected = N'testTools.expected'
                               , @Actual = N'testTools.actual';
    exec tSQLt.AssertEquals @Expected = '', @Actual = @errore;
end;
go
