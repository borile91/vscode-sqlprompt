declare @Totale Int = 0,
        @Nota   VarChar(20);
select @totale = Count(*)
from   bib.LIBRI as L
where  L.ATTIVO = 1
and    Getdate() > L.DATA_ARRIVO;
print @@ROWcount;
