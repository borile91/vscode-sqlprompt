declare @Totale Int = 0,
        @Nota   VarChar(20);
Select @totale = COUNT(*)
From   bib.LIBRI As L
Where  L.ATTIVO = 1
And    GETDATE() > L.DATA_ARRIVO;
print @@ROWcount;
