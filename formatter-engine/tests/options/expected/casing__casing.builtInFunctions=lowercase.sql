declare @Totale Int = 0,
        @Nota   VarChar(20);
Select @totale = count(*)
From   bib.LIBRI As L
Where  L.ATTIVO = 1
And    getdate() > L.DATA_ARRIVO;
print @@ROWcount;
