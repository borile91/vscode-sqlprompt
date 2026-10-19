SELECT l.TITOLO, a.NOME AS AUTORE, IIF(l.PAGINE > 300 AND l.ANNO > 2000, 'lungo', 'breve') AS TIPO, CASE WHEN l.DISPONIBILE = 1
                                                                                                              AND l.DANNEGGIATO = 0 THEN 'ok'
                                                                                                         WHEN l.DISPONIBILE = 0 THEN 'prestato'
                                                                                                         ELSE NULL
                                                                                                    END AS STATO, STUFF(( SELECT ',' + g.NOME
                                                                                                                          FROM   bib.GENERI AS g
                                                                                                                          WHERE  g.ID_LIBRO = l.ID_LIBRO
                                                                                                                        FOR XML PATH('')), 1, 1, '') AS GENERI
     , ISNULL(( SELECT MAX(p.DATA_PRESTITO)
                FROM   bib.PRESTITI AS p
                WHERE  p.ID_LIBRO = l.ID_LIBRO ), '19000101') AS ULTIMO
FROM   bib.LIBRI AS l
       INNER JOIN bib.AUTORI AS a
           ON a.ID_AUTORE = l.ID_AUTORE
              AND a.ATTIVO = 1
       LEFT JOIN bib.EDITORI AS e
           ON e.ID_EDITORE = l.ID_EDITORE
       OUTER APPLY ( SELECT   TOP ( 1 ) p.ID_SOCIO, p.DATA_PRESTITO
                     FROM     bib.PRESTITI AS p
                     WHERE    p.ID_LIBRO = l.ID_LIBRO
                     ORDER BY p.DATA_PRESTITO DESC ) AS ultimo
WHERE  l.ATTIVO = 1
       AND l.ID_SEDE IN ( SELECT s.ID_SEDE
                          FROM   bib.fnSediAbilitate(1, @utente) AS s )
       AND NOT EXISTS ( SELECT 1
                        FROM   bib.SCARTI AS sc
                        WHERE  sc.ID_LIBRO = l.ID_LIBRO
                               AND EXISTS ( SELECT 1
                                            FROM   bib.MOTIVI AS m
                                            WHERE  m.ID = sc.ID_MOTIVO
                                                   AND EXISTS ( SELECT 1
                                                                FROM   @motiviEsclusi AS me
                                                                WHERE  me.ID = m.ID )))
       AND ( l.NOTE IS NULL
             OR ( l.NOTE = ''
                  AND l.ANNO < 1990 ))
       AND COALESCE(l.COLLANA, ( SELECT c.NOME
                                 FROM   bib.COLLANE AS c
                                 WHERE  c.ID = l.ID_COLLANA )) = 'Classici';

DELETE p
FROM   bib.PRENOTAZIONI AS p
WHERE  EXISTS ( SELECT 1
                FROM   bib.LIBRI AS l
                WHERE  l.ID_LIBRO = p.ID_LIBRO
                       AND l.ATTIVO = 0 );

DELETE FROM @prenotazioniTemp
WHERE ID_LIBRO IS NULL;

UPDATE p
SET    p.STATO = 'C', p.DATA_CHIUSURA = GETDATE(), p.UTENTE = @utente
FROM   bib.PRESTITI AS p
       INNER JOIN bib.SOCI AS s
           ON s.ID_SOCIO = p.ID_SOCIO
WHERE  s.ATTIVO = 0
       AND p.STATO IS NULL;

SELECT l.ID_LIBRO, l.TITOLO
INTO   #libriTemp
FROM   bib.LIBRI AS l
WHERE  l.ATTIVO = 1;

INSERT INTO bib.CAUSALI (
                            CODICE, DESCRIZIONE, SEGNO
                        )
VALUES ( 'C_LIB', 'Carico libro', '+' )
     , ( 'S_LIB', 'Scarico libro', '-' )
     , ( 'T_LIB', 'Trasferimento', '+' );

INSERT INTO bib.SCAFFALI (
                             SEDE, SCAFFALE, RIPIANO, CAPIENZA
                         )
VALUES ( 'MI1', 'A', '01', 40 )  --primo scaffale
     , ( 'MI1', 'A', '02', 40 )  --secondo
     , ( 'MI1', 'B', '01', 25 ); --terzo

INSERT INTO bib.STORICO_PRESTITI (
                                     ID_PRESTITO, ID_SOCIO, ID_LIBRO
                                 )
SELECT p.ID_PRESTITO, p.ID_SOCIO, p.ID_LIBRO
FROM   bib.PRESTITI AS p
WHERE  p.STATO = 'C';
