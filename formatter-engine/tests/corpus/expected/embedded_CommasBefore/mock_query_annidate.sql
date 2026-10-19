select l.TITOLO
     , a.NOME                                                  as AUTORE
     , iif(l.PAGINE > 300 and l.ANNO > 2000, 'lungo', 'breve') as TIPO
     , case
           when l.DISPONIBILE = 1
                and l.DANNEGGIATO = 0 then
               'ok'
           when l.DISPONIBILE = 0 then
               'prestato'
           else
               null
       end                                                     as STATO
     , stuff((
                 select ',' + g.NOME
                 from bib.GENERI as g
                 where g.ID_LIBRO = l.ID_LIBRO
                 for xml path('')
             )
           , 1
           , 1
           , ''
            )                                                  as GENERI
     , isnull((
                  select max(p.DATA_PRESTITO)
                  from bib.PRESTITI as p
                  where p.ID_LIBRO = l.ID_LIBRO
              )
            , '19000101'
             )                                                 as ULTIMO
from bib.LIBRI            as l
    inner join bib.AUTORI as a
        on a.ID_AUTORE = l.ID_AUTORE
           and a.ATTIVO = 1
    left join bib.EDITORI as e
        on e.ID_EDITORE = l.ID_EDITORE
    outer apply
(
    select top (1)
           p.ID_SOCIO
         , p.DATA_PRESTITO
    from bib.PRESTITI as p
    where p.ID_LIBRO = l.ID_LIBRO
    order by p.DATA_PRESTITO desc
)                         as ultimo
where l.ATTIVO = 1
      and l.ID_SEDE in
          (
              select s.ID_SEDE from bib.fnSediAbilitate(1, @utente) as s
          )
      and not exists
              (
                  select 1
                  from bib.SCARTI as sc
                  where sc.ID_LIBRO = l.ID_LIBRO
                        and exists
                            (
                                select 1
                                from bib.MOTIVI as m
                                where m.ID = sc.ID_MOTIVO
                                      and exists
                                          (
                                              select 1 from @motiviEsclusi as me where me.ID = m.ID
                                          )
                            )
              )
      and
      (
          l.NOTE is null
          or
          (
              l.NOTE = ''
              and l.ANNO < 1990
          )
      )
      and coalesce(l.COLLANA
                 , (
                       select c.NOME from bib.COLLANE as c where c.ID = l.ID_COLLANA
                   )
                  ) = 'Classici';

delete p
from bib.PRENOTAZIONI as p
where exists
(
    select 1
    from bib.LIBRI as l
    where l.ID_LIBRO = p.ID_LIBRO
          and l.ATTIVO = 0
);

delete from @prenotazioniTemp
where ID_LIBRO is null;

update p
set p.STATO = 'C'
  , p.DATA_CHIUSURA = getdate()
  , p.UTENTE = @utente
from bib.PRESTITI       as p
    inner join bib.SOCI as s
        on s.ID_SOCIO = p.ID_SOCIO
where s.ATTIVO = 0
      and p.STATO is null;

select l.ID_LIBRO
     , l.TITOLO
into #libriTemp
from bib.LIBRI as l
where l.ATTIVO = 1;

insert into bib.CAUSALI
(
    CODICE
  , DESCRIZIONE
  , SEGNO
)
values
('C_LIB', 'Carico libro', '+')
, ('S_LIB', 'Scarico libro', '-')
, ('T_LIB', 'Trasferimento', '+');

insert into bib.SCAFFALI
(
    SEDE
  , SCAFFALE
  , RIPIANO
  , CAPIENZA
)
values
('MI1', 'A', '01', 40)    --primo scaffale
, ('MI1', 'A', '02', 40)  --secondo
, ('MI1', 'B', '01', 25); --terzo

insert into bib.STORICO_PRESTITI
(
    ID_PRESTITO
  , ID_SOCIO
  , ID_LIBRO
)
select p.ID_PRESTITO
     , p.ID_SOCIO
     , p.ID_LIBRO
from bib.PRESTITI as p
where p.STATO = 'C';
