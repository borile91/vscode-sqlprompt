declare @Totale Int = 0,
        @Nota   Varchar(20);
Select @totale = Count(*)
From   bib.LIBRI As L
Where  L.ATTIVO = 1
And    Getdate() > L.DATA_ARRIVO;
print @@ROWcount;
