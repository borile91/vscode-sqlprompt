
-- =============================================
-- Author:		Mario Rossi
-- Create date: 01/01/2024
-- Description:	Procedura di esempio per i commenti.
--				Seconda riga della descrizione.
-- =============================================

CREATE PROCEDURE bib.spCommentiEsempio @idSocio INT, -- socio da elaborare
    @dataRif DATETIME, @note NVARCHAR(200) =NULL, -- note facoltative
    @Errore VARCHAR(255) OUTPUT
AS BEGIN
    SET NOCOUNT ON;
    -- primo commento del corpo

    -- secondo commento separato
    SET @Errore='';
    SET @dataRif=ISNULL(@dataRif, GETDATE());
    /* commento a blocco
       su più righe */
    DECLARE @conta INT=0;
    IF @idSocio IS NULL BEGIN
        SET @Errore='Socio mancante';
        RETURN;
    END
    -- commento dopo END

    -- secondo commento dopo END
    SELECT s.ID_SOCIO, -- identificativo
        s.NOME, -- nome del socio
        s.COGNOME
    FROM bib.SOCI AS s -- anagrafica
    WHERE s.ID_SOCIO=@idSocio AND s.ATTIVO=1 -- solo attivi
          AND EXISTS (SELECT 1 FROM bib.PRESTITI AS p WHERE p.ID_SOCIO=s.ID_SOCIO) -- con almeno un prestito
                                                                                   -- commento che continua la riga sopra
    ORDER BY s.COGNOME;

    --SELECT vecchia
    --FROM   tabella_commentata
    --WHERE  1 = 1
    UPDATE bib.SOCI SET ULTIMO_ACCESSO=@dataRif WHERE ID_SOCIO=@idSocio;
END;
GO