create view bib.vwSociAttivi
as
select s.ID_SOCIO
     , s.NOME
     , s.COGNOME
from bib.SOCI as s
where s.ATTIVO = 1;
go
create procedure bib.spPulizia
    @Sede varchar(3)
  , @Errore varchar(255) output
as
begin
    declare @conta int = 0;
    create table #libri
    (
        ID int
      , TITOLO nvarchar(100)
    );
    create table #soci
    (
        ID int
    );
    select *
    into #prestiti
    from bib.PRESTITI
    where SEDE = @Sede;
    while @conta < 10
    begin
        set @conta = @conta + 1;
        if @conta = 5
            goto USCITA;
    end;
    update p
    set p.STATO = 'C'
    from #prestiti as p
    where p.ID_LIBRO in
          (
              select L.ID from #libri as L
          );
    exec bib.spLog @Sede = @Sede
                 , @messaggio = 'pulizia'
                 , @Errore = @Errore output; -- traccia
    USCITA:
    drop table #libri;
    drop table #soci;
    drop table #prestiti;
    if @conta > 0
        raiserror('Elaborati %d libri', 0, 1, @conta) with nowait; -- messaggio informativo
                                                                   -- continua il commento sopra
    return 0;
end;
go
