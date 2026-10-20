-- MERGE con sorgente da sottoquery, aggiornamento e inserimento
MERGE INTO bib.LIBRI AS l
USING (SELECT v.ID_LIBRO, v.TITOLO, v.ANNO, v.COLLANA, v.ID_AUTORE
       FROM bib.vwAcquisizioneLibri AS v
       WHERE v.STATO = @statoInLavorazione AND (v.ID_RICHIESTA = @richiesta OR @richiesta IS NULL)) AS a
ON a.ID_LIBRO = l.ID_LIBRO AND a.ANNO = l.ANNO
WHEN MATCHED THEN
    UPDATE SET l.TITOLO = ISNULL(a.TITOLO, l.TITOLO), l.COLLANA = IIF(a.COLLANA = '', NULL, COALESCE(a.COLLANA, l.COLLANA)), l.ID_AUTORE = a.ID_AUTORE
WHEN NOT MATCHED THEN INSERT (ID_LIBRO, TITOLO, ANNO, COLLANA, ID_AUTORE)
                      VALUES (a.ID_LIBRO, a.TITOLO, a.ANNO, NULLIF(a.COLLANA, ''), a.ID_AUTORE);

-- MERGE da tabella di valori
MERGE INTO bib.MESSAGGI AS t
USING (VALUES (50001, 1033, N'Nessuna sede indicata nella tabella SEDI'), (50002, 1033, N'Nessuna sala indicata nella tabella SALE'),
           (50003, 1033, N'Valore di @sede non valido')) AS s (ID, LINGUA, TESTO)
ON t.ID = s.ID AND t.LINGUA = s.LINGUA
WHEN MATCHED THEN UPDATE SET t.TESTO = s.TESTO
WHEN NOT MATCHED BY TARGET THEN INSERT (ID, LINGUA, TESTO)
                                VALUES (s.ID, s.LINGUA, s.TESTO)
WHEN NOT MATCHED BY SOURCE THEN DELETE;

-- DELETE con OUTPUT … INTO
DELETE TOP (@top) p
OUTPUT Deleted.ID_PRESTITO, Deleted.ID_LIBRO, Deleted.ID_SOCIO, Deleted.DATA_PRESTITO, Deleted.DATA_RESTITUZIONE, Deleted.NOTE
INTO bib.PRESTITI_STORICO (ID_PRESTITO, ID_LIBRO, ID_SOCIO, DATA_PRESTITO, DATA_RESTITUZIONE, NOTE)
FROM bib.PRESTITI AS p
WHERE p.DATA_RESTITUZIONE < @soglia;

-- UPDATE con OUTPUT
UPDATE bib.LIBRI
SET ATTIVO = 0
OUTPUT Inserted.ID_LIBRO, Deleted.ATTIVO, Inserted.ATTIVO
WHERE ANNO < 1950;

-- tabella di valori in JOIN
SELECT l.TITOLO, s.DESCRIZIONE
FROM bib.LIBRI AS l
     INNER JOIN (VALUES ('C', 'Cartaceo'), ('E', 'Ebook'), ('A', 'Audiolibro')) AS s (CODICE, DESCRIZIONE) ON s.CODICE = l.FORMATO;
