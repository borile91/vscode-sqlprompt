DECLARE @Totale Int = 0,
        @Nota   VarChar(20);
SELECT @totale = Count(*)
FROM   bib.LIBRI AS L
WHERE  L.ATTIVO = 1
AND    Getdate() > L.DATA_ARRIVO;
PRINT @@ROWcount;
