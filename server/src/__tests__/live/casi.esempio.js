/**
 * Casi di test live d'ESEMPIO, con nomi inventati: mostrano il formato.
 * I casi veri citano tabelle di database reali e stanno fuori dal repo, in
 * `.live-schema/casi.js` (gitignored) o nel file indicato da SQLPROMPT_LIVE_CASES.
 *
 * Ogni caso è taggato con la PR che lo riguarda: `node live.js 20` esegue solo
 * quelli della PR #20. Il codice testato è quello COMPILATO nel branch in
 * checkout, quindi i casi di una PR vanno eseguiti sul suo branch.
 *
 * `|` marca il cursore. Con più marcatori, `cursorIndex` scegle quale usare.
 *
 * Tabelle usate (inventate):
 *   Biblioteca_Master  dbo.LIBRI (103 col, alias atteso "l")
 *                     dbo.PRESTITI_TESTATA (82 col, "pt")
 *                     dbo.PRESTITI_DETTAGLIO (68 col, "pd")
 *                     config.LIBRI (11 col) — stesso nome, altro schema
 *   Archivio_Master   dbo.OrariFestivi (53 col, "of")
 *                     config.Editori (28 col) / dbo.Editori (5 col)
 */

const ES = 'Biblioteca_Master';
const EM = 'Archivio_Master';

module.exports = [
  // ══ PR #19 — confini di statement senza `;` / `GO` ═════════════════════════
  {
    pr: 19, db: ES,
    nome: 'due SELECT nude: il secondo non vede la tabella del primo',
    sql: 'SELECT * FROM dbo.PRESTITI_TESTATA pt\nSELECT | FROM dbo.LIBRI l',
    sorgentiAttese: ['LIBRI'],
  },
  {
    pr: 19, db: ES,
    nome: 'INSERT … SELECT poi un altro SELECT (regressione corretta)',
    sql: 'INSERT INTO dbo.PRESTITI_DETTAGLIO (SEDE)\nSELECT pt.SEDE FROM dbo.PRESTITI_TESTATA pt\nSELECT | FROM dbo.LIBRI l',
    sorgentiAttese: ['LIBRI'],
  },
  {
    pr: 19, db: ES,
    nome: 'INSERT … VALUES poi un SELECT (regressione corretta)',
    sql: 'INSERT INTO dbo.PRESTITI_DETTAGLIO (SEDE)\nVALUES (1)\nSELECT | FROM dbo.LIBRI l',
    sorgentiAttese: ['LIBRI'],
  },
  {
    pr: 19, db: ES,
    nome: 'CTE, query principale, poi un SELECT indipendente (regressione corretta)',
    sql: 'WITH cte AS (SELECT 1 AS x)\nSELECT * FROM cte\nSELECT | FROM dbo.LIBRI l',
    sorgentiAttese: ['LIBRI'],
  },
  {
    pr: 19, db: ES,
    nome: 'UNION resta un solo statement',
    sql: 'SELECT pt.SEDE FROM dbo.PRESTITI_TESTATA pt\nUNION\nSELECT | FROM dbo.PRESTITI_TESTATA pt2',
    sorgentiAttese: ['PRESTITI_TESTATA', 'PRESTITI_TESTATA'],
  },
  {
    pr: 19, db: ES,
    nome: 'sottoquery: entrambe le tabelle restano visibili',
    sql: 'SELECT *\nFROM dbo.PRESTITI_TESTATA pt\nWHERE pt.SEDE IN (\nSELECT | FROM dbo.LIBRI l\n)',
    sorgentiAttese: ['PRESTITI_TESTATA', 'LIBRI'],
  },
  {
    pr: 19, db: ES,
    nome: 'WITH (NOLOCK) a inizio riga non apre una CTE',
    sql: 'SELECT * FROM dbo.PRESTITI_TESTATA pt\nWITH (NOLOCK)\nWHERE pt.|',
    sorgentiAttese: ['PRESTITI_TESTATA'],
  },
  {
    pr: 19, db: EM,
    nome: 'corpo di procedura: il secondo SELECT non vede il primo',
    sql: 'CREATE PROCEDURE dbo.spTest AS\nSELECT * FROM dbo.OrariFestivi f\nSELECT | FROM config.Editori az',
    sorgentiAttese: ['Editori'],
  },
  {
    pr: 19, db: ES,
    nome: '`;` e `GO` continuano a fare da confine',
    sql: 'SELECT * FROM dbo.PRESTITI_TESTATA pt;\nGO\nSELECT | FROM dbo.LIBRI l',
    sorgentiAttese: ['LIBRI'],
  },

  // ══ PR #20 — alias non riservati se non scritti nella query ════════════════
  {
    pr: 20, db: ES,
    nome: 'prima tabella della query: alias base, non "l2"',
    sql: 'SELECT * FROM dbo.LIBR|',
    inserimentiAttesi: ['LIBRI AS l'],
    inserimentiVietati: ['LIBRI AS l2'],
  },
  {
    pr: 20, db: ES,
    nome: 'alias esplicito occupato: la seconda tabella ottiene "l2"',
    sql: 'SELECT * FROM dbo.LIBRI l JOIN dbo.LIBR|',
    inserimentiAttesi: ['LIBRI AS l2'],
    inserimentiVietati: ['LIBRI AS l'],
  },
  {
    pr: 20, db: ES,
    nome: 'alias da nome con underscore: PRESTITI_TESTATA → pt',
    sql: 'SELECT * FROM dbo.PRESTITI_TESTAT|',
    inserimentiAttesi: ['PRESTITI_TESTATA AS pt'],
    inserimentiVietati: ['PRESTITI_TESTATA AS pt2'],
  },
  {
    pr: 20, db: ES,
    nome: 'due tabelle diverse: nessuna collisione, pd resta pd',
    sql: 'SELECT * FROM dbo.PRESTITI_TESTATA pt JOIN dbo.PRESTITI_DETTAGL|',
    inserimentiAttesi: ['PRESTITI_DETTAGLIO AS pd'],
    inserimentiVietati: ['PRESTITI_DETTAGLIO AS pd2'],
  },
  {
    pr: 20, db: ES,
    nome: 'la prima tabella senza alias scritto non riserva nulla',
    sql: 'SELECT * FROM dbo.LIBRI JOIN dbo.PRESTITI_TESTAT|',
    inserimentiAttesi: ['PRESTITI_TESTATA AS pt'],
  },
  {
    pr: 20, db: ES,
    nome: 'stesso nome in altro schema: config.LIBRI → l',
    sql: 'SELECT * FROM config.LIBR|',
    inserimentiAttesi: ['LIBRI AS l'],
    inserimentiVietati: ['LIBRI AS l2'],
  },
  {
    // "of" è una parola riservata T-SQL: l'alias viene esteso a "ofe", come fa
    // SQL Prompt. Prima il caso attendeva "of", cioè consolidava il difetto.
    pr: 20, db: EM,
    nome: 'alias CamelCase riservato: OrariFestivi → ofe',
    sql: 'SELECT * FROM dbo.OrariFest|',
    inserimentiAttesi: ['OrariFestivi AS ofe'],
    inserimentiVietati: ['OrariFestivi AS of', 'OrariFestivi AS ofe2'],
  },
  {
    pr: 20, db: ES,
    nome: 'tre alias espliciti occupati: la quarta ottiene l4',
    sql: 'SELECT * FROM dbo.LIBRI l JOIN dbo.LIBRI l2 ON 1=1 JOIN dbo.LIBRI l3 ON 1=1 JOIN dbo.LIBR|',
    inserimentiAttesi: ['LIBRI AS l4'],
  },

  // ══ PR #21 — risoluzione per UPDATE e INSERT ═══════════════════════════════
  {
    pr: 21, db: ES,
    nome: 'UPDATE … SET propone le colonne della tabella aggiornata',
    sql: 'UPDATE dbo.LIBRI SET |',
    sorgentiAttese: ['LIBRI'],
    attesi: ['LIBRO', 'TITOLO'],
  },
  {
    pr: 21, db: ES,
    nome: 'UPDATE con alias: le colonne restano visibili nella WHERE',
    sql: 'UPDATE l SET l.TITOLO = 1 FROM dbo.LIBRI l WHERE l.|',
    sorgentiAttese: ['LIBRI'],
    attesi: ['LIBRO'],
  },
  {
    pr: 21, db: ES,
    nome: 'INSERT INTO … ( propone le colonne della tabella di destinazione',
    sql: 'INSERT INTO dbo.LIBRI (|',
    sorgentiAttese: ['LIBRI'],
    attesi: ['LIBRO', 'TITOLO'],
  },
  {
    pr: 21, db: EM,
    nome: 'UPDATE su schema non dbo',
    sql: 'UPDATE config.Editori SET |',
    sorgentiAttese: ['Editori'],
    attesi: ['IdAzienda'],
  },
  {
    // Nella WHERE le colonne sono proposte qualificate: con l'alias se scritto,
    // altrimenti col nome della tabella (mai con l'alias auto-generato).
    pr: 21, db: ES,
    nome: 'DELETE … WHERE vede la tabella (colonne qualificate col nome)',
    sql: 'DELETE FROM dbo.LIBRI WHERE |',
    sorgentiAttese: ['LIBRI'],
    attesi: ['LIBRI.LIBRO', 'LIBRI.TITOLO'],
    vietati: ['l.LIBRO'],
  },
  {
    pr: 21, db: ES,
    nome: 'INSERT … SELECT: nella SELECT si vede la tabella di origine',
    sql: 'INSERT INTO dbo.PRESTITI_DETTAGLIO (SEDE)\nSELECT | FROM dbo.PRESTITI_TESTATA pt',
    attesi: ['pt.SEDE'],
  },

  // ══ PR #22 — ordinamento per rilevanza ════════════════════════════════════
  {
    // Su main l'ordine era alfabetico per alias, quindi "pd" precedeva "pt".
    // Con #22 conta la posizione della tabella nello statement: pt è la prima.
    pr: 22, db: ES,
    nome: 'le colonne della prima tabella dello statement vengono prima',
    sql: 'SELECT | FROM dbo.PRESTITI_TESTATA pt JOIN dbo.PRESTITI_DETTAGLIO pd ON pd.SEDE = pt.SEDE',
    ordine: { primo: 'pt.SEDE', dopo: ['pd.SEDE', 'pd.ANNO_PREST'] },
  },
  {
    // Su main l'ordine era alfabetico per nome colonna (ANNO_PREST prima di id);
    // con #22 segue l'ordine naturale delle colonne della tabella.
    pr: 22, db: ES,
    nome: 'le colonne seguono l ordine della tabella, non l alfabeto',
    sql: 'SELECT | FROM dbo.PRESTITI_TESTATA pt',
    ordine: { primo: 'pt.id', dopo: ['pt.ANNO_PREST', 'pt.D_ORDI', 'pt.PRIO'] },
  },
  {
    pr: 22, db: ES,
    nome: 'nessuna label duplicata fra le colonne proposte',
    sql: 'SELECT | FROM dbo.PRESTITI_TESTATA pt JOIN dbo.PRESTITI_DETTAGLIO pd ON pd.SEDE = pt.SEDE',
    senzaDuplicati: true,
  },
  {
    pr: 22, db: ES,
    nome: 'le colonne in scope precedono le keyword',
    sql: 'SELECT | FROM dbo.LIBRI l',
    ordine: { primo: 'l.LIBRO', dopo: ['DISTINCT', 'TOP'] },
  },
  {
    pr: 22, db: EM,
    nome: 'ordinamento naturale anche su Archivio',
    sql: 'SELECT | FROM dbo.OrariFestivi f',
    ordine: { primo: 'f.Id', dopo: ['f.Codice', 'f.Descrizione'] },
  },
];
