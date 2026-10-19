
-- =============================================
-- Author:		Mario Rossi
-- Create date: 01/01/2024
-- Description:	Procedura di esempio per i commenti.
--				Seconda riga della descrizione.
-- =============================================

create procedure bib.spCommentiEsempio
    @idSocio int               -- socio da elaborare
  , @dataRif datetime
  , @note nvarchar(200) = null -- note facoltative
  , @Errore varchar(255) output
as
begin
    set nocount on;
    -- primo commento del corpo

    -- secondo commento separato
    set @Errore = '';
    set @dataRif = isnull(@dataRif, getdate());
    /* commento a blocco
       su più righe */
    declare @conta int = 0;

    if @idSocio is null
    begin
        set @Errore = 'Socio mancante';
        return;
    end
    -- commento dopo END

    -- secondo commento dopo END
    select s.ID_SOCIO -- identificativo
         , s.NOME     -- nome del socio
         , s.COGNOME
    from bib.SOCI as s -- anagrafica
    where s.ID_SOCIO = @idSocio
          and s.ATTIVO = 1 -- solo attivi
          and exists
              (
                  select 1 from bib.PRESTITI as p where p.ID_SOCIO = s.ID_SOCIO
              ) -- con almeno un prestito
                -- commento che continua la riga sopra
    order by s.COGNOME;

    --SELECT vecchia
    --FROM   tabella_commentata
    --WHERE  1 = 1
    update bib.SOCI
    set ULTIMO_ACCESSO = @dataRif
    where ID_SOCIO = @idSocio;
end;
go
