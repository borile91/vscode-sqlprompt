
--  Commenti del test.
--  Esempi: vedi la guida di tSQLt.
CREATE PROCEDURE [tBiblioteca].[test spRestituzioniElabora_ChiudePrestitiAperti]
AS BEGIN
    --Assemble
    DECLARE @sede VARCHAR(3) ='MI1', @reparto VARCHAR(3) ='ARC', @idTessera INT=42, @errore VARCHAR(255) ='';
    EXEC tSQLt.FakeTable @TableName=N'bib.PRESTITI';
    EXEC tSQLt.FakeTable @TableName=N'bib.LIBRI', @Identity=1;
    INSERT INTO bib.LIBRI(ID_LIBRO, TITOLO, ATTIVO)
    VALUES(1, 'Primo', 1),
        (2, 'Secondo', 1),
        (3, 'Terzo', 0);
    INSERT INTO bib.PRESTITI(ID_PRESTITO, ID_SOCIO, ID_LIBRO, STATO)
    VALUES(10, 42, 1, NULL), --aperto
        (11, 42, 2, 'C'), --chiuso
        (12, 7, 3, NULL); --altro socio
                          --Act
    EXEC bib.spRestituzioniElabora @Sede=@sede, @Reparto=@reparto, @idTessera=@idTessera, @scriviStorico=0, @dtInizio=NULL, -- datetime
        @dtFine=NULL, -- datetime
        @utente='test', @Errore=@errore OUTPUT;
    --Assert
    SELECT ID_PRESTITO, STATO INTO testTools.actual FROM bib.PRESTITI;
    SELECT TOP(0)* INTO testTools.expected FROM testTools.actual;
    INSERT INTO testTools.expected(ID_PRESTITO, STATO)
    VALUES(10, 'C'),
        (11, 'C'),
        (12, NULL);
    EXEC tSQLt.AssertEqualsTable @Expected=N'testTools.expected', @Actual=N'testTools.actual';
    EXEC tSQLt.AssertEquals @Expected='', @Actual=@errore;
END;
GO