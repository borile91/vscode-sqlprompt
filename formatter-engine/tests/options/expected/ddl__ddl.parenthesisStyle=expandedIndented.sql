create table bib.TAG
    (
    ID_TAG int not null,
    NOME varchar(50) null
    );
create table bib.PRESTITI
    (
    ID_PRESTITO int identity(1, 1) not null,
    ID_LIBRO int not null,
    DATA_PRESTITO datetime constraint DF_PRESTITI_DATA default (getdate()) not null,
    constraint PK_PRESTITI primary key clustered (ID_PRESTITO asc),
    constraint FK_PRESTITI_LIBRI foreign key (ID_LIBRO) references bib.LIBRI (ID_LIBRO)
    );
go
create procedure bib.spPrestitiSocio
    @idSocio int,
    @soloAperti bit = 1
as
begin
    select p.ID_PRESTITO
    from   bib.PRESTITI as p
    where  p.ID_SOCIO = @idSocio;
end;
