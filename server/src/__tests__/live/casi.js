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
 *   EasyStock_Master  dbo.ARTICOLI (103 col, alias atteso "a")
 *                     dbo.ORDINI_TESTATA (82 col, "ot")
 *                     dbo.ORDINI_DETTAGLIO (68 col, "od")
 *                     config.ARTICOLI (11 col) — stesso nome, altro schema
 *   EasyMexs_Master   dbo.OrdiniFasi (53 col, "of")
 *                     config.Aziende (28 col) / dbo.Aziende (5 col)
 */

const ES = 'EasyStock_Master';
const EM = 'EasyMexs_Master';

module.exports = [
  // ══ PR #19 — confini di statement senza `;` / `GO` ═════════════════════════
  {
    pr: 19, db: ES,
    nome: 'due SELECT nude: il secondo non vede la tabella del primo',
    sql: 'SELECT * FROM dbo.ORDINI_TESTATA ot\nSELECT | FROM dbo.ARTICOLI a',
    sorgentiAttese: ['ARTICOLI'],
  },
  {
    pr: 19, db: ES,
    nome: 'INSERT … SELECT poi un altro SELECT (regressione corretta)',
    sql: 'INSERT INTO dbo.ORDINI_DETTAGLIO (STAB)\nSELECT ot.STAB FROM dbo.ORDINI_TESTATA ot\nSELECT | FROM dbo.ARTICOLI a',
    sorgentiAttese: ['ARTICOLI'],
  },
  {
    pr: 19, db: ES,
    nome: 'INSERT … VALUES poi un SELECT (regressione corretta)',
    sql: 'INSERT INTO dbo.ORDINI_DETTAGLIO (STAB)\nVALUES (1)\nSELECT | FROM dbo.ARTICOLI a',
    sorgentiAttese: ['ARTICOLI'],
  },
  {
    pr: 19, db: ES,
    nome: 'CTE, query principale, poi un SELECT indipendente (regressione corretta)',
    sql: 'WITH cte AS (SELECT 1 AS x)\nSELECT * FROM cte\nSELECT | FROM dbo.ARTICOLI a',
    sorgentiAttese: ['ARTICOLI'],
  },
  {
    pr: 19, db: ES,
    nome: 'UNION resta un solo statement',
    sql: 'SELECT ot.STAB FROM dbo.ORDINI_TESTATA ot\nUNION\nSELECT | FROM dbo.ORDINI_TESTATA ot2',
    sorgentiAttese: ['ORDINI_TESTATA', 'ORDINI_TESTATA'],
  },
  {
    pr: 19, db: ES,
    nome: 'sottoquery: entrambe le tabelle restano visibili',
    sql: 'SELECT *\nFROM dbo.ORDINI_TESTATA ot\nWHERE ot.STAB IN (\nSELECT | FROM dbo.ARTICOLI a\n)',
    sorgentiAttese: ['ORDINI_TESTATA', 'ARTICOLI'],
  },
  {
    pr: 19, db: ES,
    nome: 'WITH (NOLOCK) a inizio riga non apre una CTE',
    sql: 'SELECT * FROM dbo.ORDINI_TESTATA ot\nWITH (NOLOCK)\nWHERE ot.|',
    sorgentiAttese: ['ORDINI_TESTATA'],
  },
  {
    pr: 19, db: EM,
    nome: 'corpo di procedura: il secondo SELECT non vede il primo',
    sql: 'CREATE PROCEDURE dbo.spTest AS\nSELECT * FROM dbo.OrdiniFasi f\nSELECT | FROM config.Aziende az',
    sorgentiAttese: ['Aziende'],
  },
  {
    pr: 19, db: ES,
    nome: '`;` e `GO` continuano a fare da confine',
    sql: 'SELECT * FROM dbo.ORDINI_TESTATA ot;\nGO\nSELECT | FROM dbo.ARTICOLI a',
    sorgentiAttese: ['ARTICOLI'],
  },

  // ══ PR #20 — alias non riservati se non scritti nella query ════════════════
  {
    pr: 20, db: ES,
    nome: 'prima tabella della query: alias base, non "a2"',
    sql: 'SELECT * FROM dbo.ARTICOL|',
    inserimentiAttesi: ['ARTICOLI AS a'],
    inserimentiVietati: ['ARTICOLI AS a2'],
  },
  {
    pr: 20, db: ES,
    nome: 'alias esplicito occupato: la seconda tabella ottiene "a2"',
    sql: 'SELECT * FROM dbo.ARTICOLI a JOIN dbo.ARTICOL|',
    inserimentiAttesi: ['ARTICOLI AS a2'],
    inserimentiVietati: ['ARTICOLI AS a'],
  },
  {
    pr: 20, db: ES,
    nome: 'alias da nome con underscore: ORDINI_TESTATA → ot',
    sql: 'SELECT * FROM dbo.ORDINI_TESTAT|',
    inserimentiAttesi: ['ORDINI_TESTATA AS ot'],
    inserimentiVietati: ['ORDINI_TESTATA AS ot2'],
  },
  {
    pr: 20, db: ES,
    nome: 'due tabelle diverse: nessuna collisione, od resta od',
    sql: 'SELECT * FROM dbo.ORDINI_TESTATA ot JOIN dbo.ORDINI_DETTAGL|',
    inserimentiAttesi: ['ORDINI_DETTAGLIO AS od'],
    inserimentiVietati: ['ORDINI_DETTAGLIO AS od2'],
  },
  {
    pr: 20, db: ES,
    nome: 'la prima tabella senza alias scritto non riserva nulla',
    sql: 'SELECT * FROM dbo.ARTICOLI JOIN dbo.ORDINI_TESTAT|',
    inserimentiAttesi: ['ORDINI_TESTATA AS ot'],
  },
  {
    pr: 20, db: ES,
    nome: 'stesso nome in altro schema: config.ARTICOLI → a',
    sql: 'SELECT * FROM config.ARTICOL|',
    inserimentiAttesi: ['ARTICOLI AS a'],
    inserimentiVietati: ['ARTICOLI AS a2'],
  },
  {
    pr: 20, db: EM,
    nome: 'alias CamelCase: OrdiniFasi → of',
    sql: 'SELECT * FROM dbo.OrdiniFas|',
    inserimentiAttesi: ['OrdiniFasi AS of'],
    inserimentiVietati: ['OrdiniFasi AS of2'],
  },
  {
    pr: 20, db: ES,
    nome: 'tre alias espliciti occupati: la quarta ottiene a4',
    sql: 'SELECT * FROM dbo.ARTICOLI a JOIN dbo.ARTICOLI a2 ON 1=1 JOIN dbo.ARTICOLI a3 ON 1=1 JOIN dbo.ARTICOL|',
    inserimentiAttesi: ['ARTICOLI AS a4'],
  },

  // ══ PR #21 — risoluzione per UPDATE e INSERT ═══════════════════════════════
  {
    pr: 21, db: ES,
    nome: 'UPDATE … SET propone le colonne della tabella aggiornata',
    sql: 'UPDATE dbo.ARTICOLI SET |',
    sorgentiAttese: ['ARTICOLI'],
    attesi: ['ARTI', 'DSCR'],
  },
  {
    pr: 21, db: ES,
    nome: 'UPDATE con alias: le colonne restano visibili nella WHERE',
    sql: 'UPDATE a SET a.DSCR = 1 FROM dbo.ARTICOLI a WHERE a.|',
    sorgentiAttese: ['ARTICOLI'],
    attesi: ['ARTI'],
  },
  {
    pr: 21, db: ES,
    nome: 'INSERT INTO … ( propone le colonne della tabella di destinazione',
    sql: 'INSERT INTO dbo.ARTICOLI (|',
    sorgentiAttese: ['ARTICOLI'],
    attesi: ['ARTI', 'DSCR'],
  },
  {
    pr: 21, db: EM,
    nome: 'UPDATE su schema non dbo',
    sql: 'UPDATE config.Aziende SET |',
    sorgentiAttese: ['Aziende'],
    attesi: ['IdAzienda'],
  },
  {
    // Nella WHERE le colonne sono proposte qualificate: con l'alias se scritto,
    // altrimenti col nome della tabella (mai con l'alias auto-generato).
    pr: 21, db: ES,
    nome: 'DELETE … WHERE vede la tabella (colonne qualificate col nome)',
    sql: 'DELETE FROM dbo.ARTICOLI WHERE |',
    sorgentiAttese: ['ARTICOLI'],
    attesi: ['ARTICOLI.ARTI', 'ARTICOLI.DSCR'],
    vietati: ['a.ARTI'],
  },
  {
    pr: 21, db: ES,
    nome: 'INSERT … SELECT: nella SELECT si vede la tabella di origine',
    sql: 'INSERT INTO dbo.ORDINI_DETTAGLIO (STAB)\nSELECT | FROM dbo.ORDINI_TESTATA ot',
    attesi: ['ot.STAB'],
  },

  // ══ PR #22 — ordinamento per rilevanza ════════════════════════════════════
  {
    // Su main l'ordine era alfabetico per alias, quindi "od" precedeva "ot".
    // Con #22 conta la posizione della tabella nello statement: ot è la prima.
    pr: 22, db: ES,
    nome: 'le colonne della prima tabella dello statement vengono prima',
    sql: 'SELECT | FROM dbo.ORDINI_TESTATA ot JOIN dbo.ORDINI_DETTAGLIO od ON od.STAB = ot.STAB',
    ordine: { primo: 'ot.STAB', dopo: ['od.STAB', 'od.ANNO_ORDI'] },
  },
  {
    // Su main l'ordine era alfabetico per nome colonna (ANNO_ORDI prima di id);
    // con #22 segue l'ordine naturale delle colonne della tabella.
    pr: 22, db: ES,
    nome: 'le colonne seguono l ordine della tabella, non l alfabeto',
    sql: 'SELECT | FROM dbo.ORDINI_TESTATA ot',
    ordine: { primo: 'ot.id', dopo: ['ot.ANNO_ORDI', 'ot.D_ORDI', 'ot.PRIO'] },
  },
  {
    pr: 22, db: ES,
    nome: 'nessuna label duplicata fra le colonne proposte',
    sql: 'SELECT | FROM dbo.ORDINI_TESTATA ot JOIN dbo.ORDINI_DETTAGLIO od ON od.STAB = ot.STAB',
    senzaDuplicati: true,
  },
  {
    pr: 22, db: ES,
    nome: 'le colonne in scope precedono le keyword',
    sql: 'SELECT | FROM dbo.ARTICOLI a',
    ordine: { primo: 'a.ARTI', dopo: ['DISTINCT', 'TOP'] },
  },
  {
    pr: 22, db: EM,
    nome: 'ordinamento naturale anche su EasyMexs',
    sql: 'SELECT | FROM dbo.OrdiniFasi f',
    ordine: { primo: 'f.Id', dopo: ['f.Codice', 'f.Descrizione'] },
  },
];
