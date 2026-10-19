select
         top (10) l.TITOLO,
                  l.ANNO
from     bib.LIBRI as l
where    l.ATTIVO = 1
order by l.ANNO desc;
select
     distinct a.NOME
from bib.AUTORI as a;
update p
set    p.STATO = 'C'
from   bib.PRESTITI as p
where  p.DATA_RESTITUZIONE is not null;
delete from bib.PRENOTAZIONI
where SCADENZA < getdate();
select   a.NOME,
         s.NOME
from     bib.AUTORI as a,
         bib.SEDI as s
where    a.ID_SEDE = s.ID_SEDE
and      s.APERTA = 1
order by a.NOME,
         s.NOME;
select l.TITOLO
from   bib.LIBRI as l
where  l.ID_AUTORE in (select a.ID_AUTORE
                       from   bib.AUTORI as a);
insert into bib.REGISTRO
(
    MESSAGGIO
)
values
('pulizia completata');
