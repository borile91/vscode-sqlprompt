CREATE VIEW bib.vwSociAttivi
AS
SELECT s.ID_SOCIO,
       s.NOME,
       s.COGNOME
FROM bib.SOCI AS s
WHERE s.ATTIVO = 1;
GO
CREATE PROCEDURE bib.spPulizia
    @Sede VARCHAR(3),
    @Errore VARCHAR(255) OUTPUT
AS
BEGIN
    DECLARE @conta INT = 0;
    CREATE TABLE #libri
    (
        ID INT,
        TITOLO NVARCHAR(100)
    );
    CREATE TABLE #soci
    (
        ID INT
    );
    SELECT *
    INTO #prestiti
    FROM bib.PRESTITI
    WHERE SEDE = @Sede;
    WHILE @conta < 10
    BEGIN
        SET @conta = @conta + 1;
        IF @conta = 5
            GOTO USCITA;
    END;
    UPDATE p
    SET p.STATO = 'C'
    FROM #prestiti AS p
    WHERE p.ID_LIBRO IN
          (
              SELECT L.ID FROM #libri AS L
          );
    EXEC bib.spLog @Sede = @Sede,
                   @messaggio = 'pulizia',
                   @Errore = @Errore OUTPUT; -- traccia
    USCITA:
    DROP TABLE #libri;
    DROP TABLE #soci;
    DROP TABLE #prestiti;
    IF @conta > 0
        RAISERROR('Elaborati %d libri', 0, 1, @conta) WITH NOWAIT; -- messaggio informativo
                                                                   -- continua il commento sopra
    RETURN 0;
END;
GO
