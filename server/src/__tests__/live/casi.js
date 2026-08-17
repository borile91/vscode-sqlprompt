/**
 * Casi di test live, su schema reale di localhost.
 *
 * Ogni caso è taggato con la PR che lo riguarda: `node live.js 20` esegue solo
 * quelli della PR #20. Il codice testato è quello COMPILATO nel branch in
 * checkout, quindi i casi di una PR vanno eseguiti sul suo branch.
 *
 * `|` marca il cursore. Con più marcatori, `cursorIndex` scegle quale usare.
 *
 * Tabelle usate (reali):
 *   Biblioteca_Master  dbo.LIBRI (103 col, alias atteso "a")
 *                     dbo.PRESTITI_TESTATA (82 col, "ot")
 *                     dbo.PRESTITI_DETTAGLIO (68 col, "od")
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
    sql: 'SELECT * FROM dbo.PRESTITI_TESTATA ot\nSELECT | FROM dbo.LIBRI a',
    sorgentiAttese: ['LIBRI'],
  },
  {
    pr: 19, db: ES,
    nome: 'INSERT … SELECT poi un altro SELECT (regressione corretta)',
    sql: 'INSERT INTO dbo.PRESTITI_DETTAGLIO (SEDE)\nSELECT ot.SEDE FROM dbo.PRESTITI_TESTATA ot\nSELECT | FROM dbo.LIBRI a',
    sorgentiAttese: ['LIBRI'],
  },
  {
    pr: 19, db: ES,
    nome: 'INSERT … VALUES poi un SELECT (regressione corretta)',
    sql: 'INSERT INTO dbo.PRESTITI_DETTAGLIO (SEDE)\nVALUES (1)\nSELECT | FROM dbo.LIBRI a',
    sorgentiAttese: ['LIBRI'],
  },
  {
    pr: 19, db: ES,
    nome: 'CTE, query principale, poi un SELECT indipendente (regressione corretta)',
    sql: 'WITH cte AS (SELECT 1 AS x)\nSELECT * FROM cte\nSELECT | FROM dbo.LIBRI a',
    sorgentiAttese: ['LIBRI'],
  },
  {
    pr: 19, db: ES,
    nome: 'UNION resta un solo statement',
    sql: 'SELECT ot.SEDE FROM dbo.PRESTITI_TESTATA ot\nUNION\nSELECT | FROM dbo.PRESTITI_TESTATA ot2',
    sorgentiAttese: ['PRESTITI_TESTATA', 'PRESTITI_TESTATA'],
  },
  {
    pr: 19, db: ES,
    nome: 'sottoquery: entrambe le tabelle restano visibili',
    sql: 'SELECT *\nFROM dbo.PRESTITI_TESTATA ot\nWHERE ot.SEDE IN (\nSELECT | FROM dbo.LIBRI a\n)',
    sorgentiAttese: ['PRESTITI_TESTATA', 'LIBRI'],
  },
  {
    pr: 19, db: ES,
    nome: 'WITH (NOLOCK) a inizio riga non apre una CTE',
    sql: 'SELECT * FROM dbo.PRESTITI_TESTATA ot\nWITH (NOLOCK)\nWHERE ot.|',
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
    sql: 'SELECT * FROM dbo.PRESTITI_TESTATA ot;\nGO\nSELECT | FROM dbo.LIBRI a',
    sorgentiAttese: ['LIBRI'],
  },

  // ══ PR #20 — alias non riservati se non scritti nella query ════════════════
  {
    pr: 20, db: ES,
    nome: 'prima tabella della query: alias base, non "a2"',
    sql: 'SELECT * FROM dbo.LIBR|',
    inserimentiAttesi: ['LIBRI AS a'],
    inserimentiVietati: ['LIBRI AS a2'],
  },
  {
    pr: 20, db: ES,
    nome: 'alias esplicito occupato: la seconda tabella ottiene "a2"',
    sql: 'SELECT * FROM dbo.LIBRI a JOIN dbo.LIBR|',
    inserimentiAttesi: ['LIBRI AS a2'],
    inserimentiVietati: ['LIBRI AS a'],
  },
  {
    pr: 20, db: ES,
    nome: 'alias da nome con underscore: PRESTITI_TESTATA → ot',
    sql: 'SELECT * FROM dbo.ORDINI_TESTAT|',
    inserimentiAttesi: ['PRESTITI_TESTATA AS ot'],
    inserimentiVietati: ['PRESTITI_TESTATA AS ot2'],
  },
  {
    pr: 20, db: ES,
    nome: 'due tabelle diverse: nessuna collisione, od resta od',
    sql: 'SELECT * FROM dbo.PRESTITI_TESTATA ot JOIN dbo.ORDINI_DETTAGL|',
    inserimentiAttesi: ['PRESTITI_DETTAGLIO AS od'],
    inserimentiVietati: ['PRESTITI_DETTAGLIO AS od2'],
  },
  {
    pr: 20, db: ES,
    nome: 'la prima tabella senza alias scritto non riserva nulla',
    sql: 'SELECT * FROM dbo.LIBRI JOIN dbo.ORDINI_TESTAT|',
    inserimentiAttesi: ['PRESTITI_TESTATA AS ot'],
  },
  {
    pr: 20, db: ES,
    nome: 'stesso nome in altro schema: config.LIBRI → a',
    sql: 'SELECT * FROM config.LIBR|',
    inserimentiAttesi: ['LIBRI AS a'],
    inserimentiVietati: ['LIBRI AS a2'],
  },
  {
    // "of" è una parola riservata T-SQL: l'alias viene esteso a "ofa", come fa
    // SQL Prompt. Prima il caso attendeva "of", cioè consolidava il difetto.
    pr: 20, db: EM,
    nome: 'alias CamelCase riservato: OrariFestivi → ofa',
    sql: 'SELECT * FROM dbo.OrdiniFas|',
    inserimentiAttesi: ['OrariFestivi AS ofa'],
    inserimentiVietati: ['OrariFestivi AS of', 'OrariFestivi AS ofa2'],
  },
  {
    pr: 20, db: ES,
    nome: 'tre alias espliciti occupati: la quarta ottiene a4',
    sql: 'SELECT * FROM dbo.LIBRI a JOIN dbo.LIBRI a2 ON 1=1 JOIN dbo.LIBRI a3 ON 1=1 JOIN dbo.LIBR|',
    inserimentiAttesi: ['LIBRI AS a4'],
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
    sql: 'UPDATE a SET a.TITOLO = 1 FROM dbo.LIBRI a WHERE a.|',
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
    vietati: ['a.LIBRO'],
  },
  {
    pr: 21, db: ES,
    nome: 'INSERT … SELECT: nella SELECT si vede la tabella di origine',
    sql: 'INSERT INTO dbo.PRESTITI_DETTAGLIO (SEDE)\nSELECT | FROM dbo.PRESTITI_TESTATA ot',
    attesi: ['ot.SEDE'],
  },

  // ══ PR #22 — ordinamento per rilevanza ════════════════════════════════════
  {
    // Su main l'ordine era alfabetico per alias, quindi "od" precedeva "ot".
    // Con #22 conta la posizione della tabella nello statement: ot è la prima.
    pr: 22, db: ES,
    nome: 'le colonne della prima tabella dello statement vengono prima',
    sql: 'SELECT | FROM dbo.PRESTITI_TESTATA ot JOIN dbo.PRESTITI_DETTAGLIO od ON od.SEDE = ot.SEDE',
    ordine: { primo: 'ot.SEDE', dopo: ['od.SEDE', 'od.ANNO_PREST'] },
  },
  {
    // Su main l'ordine era alfabetico per nome colonna (ANNO_PREST prima di id);
    // con #22 segue l'ordine naturale delle colonne della tabella.
    pr: 22, db: ES,
    nome: 'le colonne seguono l ordine della tabella, non l alfabeto',
    sql: 'SELECT | FROM dbo.PRESTITI_TESTATA ot',
    ordine: { primo: 'ot.id', dopo: ['ot.ANNO_PREST', 'ot.D_ORDI', 'ot.PRIO'] },
  },
  {
    pr: 22, db: ES,
    nome: 'nessuna label duplicata fra le colonne proposte',
    sql: 'SELECT | FROM dbo.PRESTITI_TESTATA ot JOIN dbo.PRESTITI_DETTAGLIO od ON od.SEDE = ot.SEDE',
    senzaDuplicati: true,
  },
  {
    pr: 22, db: ES,
    nome: 'le colonne in scope precedono le keyword',
    sql: 'SELECT | FROM dbo.LIBRI a',
    ordine: { primo: 'a.LIBRO', dopo: ['DISTINCT', 'TOP'] },
  },
  {
    pr: 22, db: EM,
    nome: 'ordinamento naturale anche su Archivio',
    sql: 'SELECT | FROM dbo.OrariFestivi f',
    ordine: { primo: 'f.Id', dopo: ['f.Codice', 'f.Descrizione'] },
  },
];
