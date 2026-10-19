select l.TITOLO
from   bib.LIBRI as l
where  (l.ANNO > 2000
    and (l.COLLANA = 'Classici'
      or l.COLLANA is null))
and    exists (select 1
               from   bib.PRESTITI as p
               where  p.ID_LIBRO = l.ID_LIBRO
               and    p.STATO is null)
and    l.PREZZO * (1 + l.IVA) > 20;
