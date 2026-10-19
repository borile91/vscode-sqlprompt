CREATE PROCEDURE [bib].[spRestituzioniElabora] @Sede VARCHAR(3), @Reparto VARCHAR(3), @idTessera INT, @scriviStorico BIT, -- scrive anche lo storico
    @dtInizio DATETIME, @dtFine DATETIME, @utente AS VARCHAR(10), @quantita NUMERIC(12, 3) =0, @codiceUmis VARCHAR(5) =NULL, -- unità di misura
    @Errore VARCHAR(255) OUTPUT
AS BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT OFF;
    DECLARE @messaggio VARCHAR(2048);
    DECLARE @transazioneEsterna BIT=0, @causaleCarico VARCHAR(5) ='C_LIB', @causaleScarico VARCHAR(5) ='S_LIB', @qtaDaElaborare NUMERIC(12, 3), @qtaResidua NUMERIC(12, 3), --quantità residua da spostare
        @scaffale VARCHAR(3), @ripiano VARCHAR(3), @idPrestito AS INT, @tolleranza BIT=0, @titolo VARCHAR(255), @cursoreRighe CURSOR;
    DECLARE @a INT, @bb NUMERIC(12, 3), @c VARCHAR(10) ='x', @d INT;
    DECLARE @a2 INT, @bb2 NUMERIC(12, 3), @c2 VARCHAR(10), @d2 INT=1;
    DECLARE @a3 INT=1, @bb3 NUMERIC(12, 3), @c3 VARCHAR(10);
    DECLARE @dt DATETIME=GETDATE();
    SET @Errore='';
    SET @quantita=ISNULL(@quantita, 0);
    BEGIN TRY
        IF @@TRANCOUNT>0 SET @transazioneEsterna=1;
        ELSE BEGIN
            SET @transazioneEsterna=0;
            BEGIN TRANSACTION;
        END;
        IF @Reparto NOT IN ('ARC', 'MAG')BEGIN
            SELECT TOP(1)@scaffale=s.SCAFFALE, @ripiano=s.RIPIANO
            FROM bib.fnGetPosizioni(@Sede, @Reparto, @idTessera) AS s
            ORDER BY s.id;
        END
        ELSE IF ISNULL(@tolleranza, 0)=1 BEGIN
SET @messaggio='tolleranza';
        END;
        SET @cursoreRighe=CURSOR LOCAL STATIC READ_ONLY FORWARD_ONLY FOR
        SELECT r.ID_PRESTITO, r.TITOLO
        FROM bib.PRESTITI AS r
             INNER JOIN bib.LIBRI AS l ON l.ID_LIBRO=r.ID_LIBRO
        WHERE r.SEDE=@Sede AND(r.STATO='I' OR r.STATO IS NULL)
        ORDER BY r.DATA_PRESTITO;
        OPEN @cursoreRighe;
        FETCH NEXT FROM @cursoreRighe
        INTO @idPrestito, @titolo;
        WHILE @@FETCH_STATUS=0 BEGIN
            EXEC bib.spPrestitoChiudi @Sede=@Sede, @Reparto=@Reparto, @idPrestito=@idPrestito, @messaggio=@messaggio, @Errore=@Errore OUTPUT;
            IF @Errore<>''
                RAISERROR(@Errore, -- testo del messaggio
                    16, -- gravità
                    1 -- stato
                );
            FETCH NEXT FROM @cursoreRighe
            INTO @idPrestito, @titolo;
        END;
        CLOSE @cursoreRighe;
        DEALLOCATE @cursoreRighe;
        DECLARE CursoreLibri CURSOR LOCAL FAST_FORWARD FOR
        SELECT l.ID_LIBRO, l.TITOLO FROM bib.LIBRI AS l WHERE l.ATTIVO=1;
        IF(@transazioneEsterna=0)COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF ISNULL(@Errore, '')='' BEGIN
            SET @Errore=IIF(ERROR_NUMBER()<>50000, CONVERT(VARCHAR(10), ERROR_NUMBER())+': ', '')+ERROR_MESSAGE()+' Proc: '+ISNULL(ERROR_PROCEDURE(), '')+' L: '+CONVERT(VARCHAR(10), ERROR_LINE());
        END;
        IF @transazioneEsterna=0 AND @@TRANCOUNT>0 ROLLBACK TRANSACTION;
        RAISERROR(@Errore, 16, 1);
    END CATCH;
END;
GO