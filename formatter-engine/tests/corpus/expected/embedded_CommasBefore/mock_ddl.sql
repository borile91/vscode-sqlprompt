create table [bib].[PRESTITI]
(
    [ID_PRESTITO] int identity(1, 1) not null
  , [ID_SOCIO] int not null
  , [ID_LIBRO] int not null
  , [DATA_PRESTITO] datetime
        constraint [DF_PRESTITI_DATA]
            default (getdate()) not null
  , [STATO] char(1) null
  , [NOTE] nvarchar(255) null
  , constraint [PK_PRESTITI]
        primary key clustered ([ID_PRESTITO] asc)
        with(fillfactor = 80)
  , constraint [FK_PRESTITI_SOCI]
        foreign key ([ID_SOCIO])
        references [bib].[SOCI] ([ID_SOCIO])
);
go
;
go
create nonclustered index [IX_PRESTITI_SOCIO]
on [bib].[PRESTITI] (
                        [ID_SOCIO] asc
                      , [STATO] asc
                    )
include ([ID_LIBRO])
where ([STATO] is null)
with (fillfactor = 90);
go
create unique nonclustered index [IX_PRESTITI_LIBRO]
on [bib].[PRESTITI] ([ID_LIBRO] asc);
go
alter index [IX_PRESTITI_SOCIO] on [bib].[PRESTITI] disable;
go
alter table [bib].[PRESTITI]
add constraint [DF_PRESTITI_STATO]
    default ('I') for [STATO];
go
alter table [bib].[PRESTITI] with check
add constraint [FK_PRESTITI_LIBRI]
    foreign key ([ID_LIBRO])
    references [bib].[LIBRI] ([ID_LIBRO]);
go
execute sp_addextendedproperty @name = N'MS_Description'
                             , @value = N'Prestiti dei libri'
                             , @level0type = N'SCHEMA'
                             , @level0name = N'bib'
                             , @level1type = N'TABLE'
                             , @level1name = N'PRESTITI';
go

/*
   Trigger di esempio per lo storico
*/
create trigger bib.PRESTITI_Storico
on bib.PRESTITI
after insert, delete
as
begin
    set nocount on;
    insert into bib.PRESTITI_AUDIT
    (
        ID_PRESTITO
      , OPERAZIONE
      , DATA
    )
    select i.ID_PRESTITO
         , 'I'
         , getdate()
    from Inserted as i;
end;
go
create view bib.vwPrestitiAperti
as
select p.ID_PRESTITO
     , p.ID_SOCIO
     , s.COGNOME
from bib.PRESTITI       as p
    inner join bib.SOCI as s
        on s.ID_SOCIO = p.ID_SOCIO
where p.STATO is null;
go
create function bib.fnPrestitiSocio
(
    @idSocio int
  , @soloAperti bit = 1
)
returns table
as
return
(
    -- elenco dei prestiti del socio
    select p.ID_PRESTITO
         , p.ID_LIBRO
    from bib.PRESTITI as p
    where p.ID_SOCIO = @idSocio
          and
          (
              @soloAperti = 0
              or p.STATO is null
          )
);
go
create function bib.fnRiepilogoSocio
(
    @idSocio int
)
returns @riepilogo table
(
    ID_LIBRO int
  , TITOLO nvarchar(255)
  , GIORNI int
)
as
begin
    declare @t table
    (
        ID int
      , CONTA bigint
    );
    insert @riepilogo
    (
        ID_LIBRO
      , TITOLO
      , GIORNI
    )
    select l.ID_LIBRO
         , l.TITOLO
         , datediff(day, p.DATA_PRESTITO, getdate())
    from bib.PRESTITI        as p
        inner join bib.LIBRI as l
            on l.ID_LIBRO = p.ID_LIBRO
    where p.ID_SOCIO = @idSocio;
    return;
end;
go
