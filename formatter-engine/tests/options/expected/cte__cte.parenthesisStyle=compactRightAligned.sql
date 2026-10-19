with prestitiRecenti (ID_LIBRO, CONTA)
as
 (select   p.ID_LIBRO,
           count(*)
  from     bib.PRESTITI as p
  where    p.DATA_PRESTITO > '20240101'
  group by p.ID_LIBRO)
select     l.TITOLO,
           pr.CONTA
from       bib.LIBRI as l
inner join prestitiRecenti as pr
on pr.ID_LIBRO = l.ID_LIBRO;
