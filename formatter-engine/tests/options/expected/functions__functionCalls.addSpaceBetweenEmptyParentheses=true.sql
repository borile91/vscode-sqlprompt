select isnull(l.COLLANA, 'nessuna') as Collana,
       convert(varchar(10), l.DATA_ARRIVO, 103) as Arrivo,
       getdate( ) as Oggi,
       dateadd(day, -30, getdate( )) as Soglia,
       stuff((select ',' + g.NOME
              from   bib.GENERI as g
              where  g.ID_LIBRO = l.ID_LIBRO
             for xml path('')),
             1,
             1,
             '') as Generi
from   bib.LIBRI as l;
