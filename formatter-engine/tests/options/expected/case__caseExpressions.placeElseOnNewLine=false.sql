select l.TITOLO,
       case
           when l.DISPONIBILE = 1
           and  l.DANNEGGIATO = 0 then
               'disponibile'
           when l.DISPONIBILE = 0 then
               'in prestito' else null
       end as Stato,
       case l.FORMATO
           when 'C' then
               'cartaceo'
           when 'E' then
               'ebook'
       end as Formato
from   bib.LIBRI as l;
