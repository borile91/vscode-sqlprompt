select     l.ID_LIBRO,
           l.TITOLO as Titolo,
           a.NOME as Autore,
           count(p.ID_PRESTITO) as Prestiti,
           max(p.DATA_PRESTITO) as Ultimo
from       bib.LIBRI as l
inner join bib.AUTORI as a
on
    a.ID_AUTORE = l.ID_AUTORE
and a.ATTIVO = 1
left join  bib.PRESTITI as p
on
    p.ID_LIBRO = l.ID_LIBRO
where      l.ATTIVO = 1
and        (l.ANNO > 2000
         or l.COLLANA = 'Classici')
and        l.ID_SEDE in (select s.ID_SEDE
                         from   bib.SEDI as s
                         where  s.APERTA = 1)
group by   l.ID_LIBRO,
           l.TITOLO,
           a.NOME
order by   Prestiti desc;
