declare @sede varchar(3) = 'MI1'; -- sede
declare @anno int = 2024;      -- anno di riferimento
if @anno > 2000
begin
/*
 * libri dell'anno
 */
-- prima riga del commento
      -- seconda riga del commento
select l.TITOLO, l.TITOLO + ' - ' + l.SOTTOTITOLO + ' - ' + l.EDITORE + ' - ' + l.COLLANA + ' - ' + l.LINGUA + ' (' + l.FORMATO + ')' as Descrizione from bib.LIBRI as l where l.ANNO = @anno;
end;
go
update bib.LIBRI set ATTIVO = 0 where ANNO < 1950;
