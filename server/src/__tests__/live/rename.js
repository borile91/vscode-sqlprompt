/** Sonda del rename di alias (PR #23) su query reali. `|` marca il cursore. */
const path = require('node:path');
const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const { findAliasRenameTarget, formatAliasName } = require(REPO + '/server/out/aliasRename.js');
const { extractStatementAtOffset } = require(REPO + '/server/out/documentTextService.js');

function rinomina(sqlConCursore, nuovo) {
  const off = sqlConCursore.indexOf('|');
  const text = sqlConCursore.split('|').join('');
  const sr = extractStatementAtOffset(text, off);
  const target = findAliasRenameTarget(sr.text, sr.cursorOffset);
  if (!target) return { esito: 'nessun alias sotto il cursore' };
  const nome = formatAliasName(nuovo);
  if (!nome) return { esito: `nome non valido: "${nuovo}"` };
  // Applica le sostituzioni dalla fine, come farebbe il client con i TextEdit.
  let out = sr.text;
  for (const o of [...target.occurrences].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, o.start) + nome + out.slice(o.end);
  }
  return { alias: target.alias, occorrenze: target.occurrences.length, risultato: out };
}

const casi = [
  ['alias nella FROM',      'SELECT o.SEDE FROM dbo.PRESTITI_TESTATA |o WHERE o.ANNO_PREST = 2026', 'ot'],
  ['alias in una colonna',  'SELECT |o.SEDE, o.SALA FROM dbo.PRESTITI_TESTATA o', 'ot'],
  ['join a due tabelle',    'SELECT ot.SEDE FROM dbo.PRESTITI_TESTATA ot JOIN dbo.PRESTITI_DETTAGLIO |od ON od.SEDE = ot.SEDE', 'det'],
  ['non tocca l altro alias', 'SELECT ot.SEDE, od.RIGA_PREST FROM dbo.PRESTITI_TESTATA |ot JOIN dbo.PRESTITI_DETTAGLIO od ON od.SEDE = ot.SEDE', 'test'],
  ['dentro una stringa non rinomina', "SELECT |o.SEDE, 'o.SEDE' AS lett FROM dbo.PRESTITI_TESTATA o", 'ot'],
  ['non confonde il nome tabella', 'SELECT a.LIBRO FROM dbo.LIBRI |a WHERE a.LIBRO LIKE \'%a%\'', 'art'],
  ['cursore su una keyword',   'SELECT * |FROM dbo.LIBRI a', 'x'],
  ['cursore sul nome tabella', 'SELECT * FROM dbo.|LIBRI a', 'x'],
  ['nome nuovo non valido',    'SELECT * FROM dbo.LIBRI |a', '1 2 3'],
  ['solo lo statement corrente', 'SELECT * FROM dbo.LIBRI a;\nSELECT * FROM dbo.LIBRI |a', 'z'],
];

for (const [nome, sql, nuovo] of casi) {
  const r = rinomina(sql, nuovo);
  console.log(`\n• ${nome}  (→ "${nuovo}")`);
  if (r.esito) { console.log(`    ${r.esito}`); continue; }
  console.log(`    alias "${r.alias}", ${r.occorrenze} occorrenze`);
  console.log(`    ${JSON.stringify(r.risultato)}`);
}
