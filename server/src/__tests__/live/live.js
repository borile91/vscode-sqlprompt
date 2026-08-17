/**
 * Harness di test "live" per SQL Prompt.
 *
 * Replica esattamente la catena che il server LSP esegue a ogni keystroke
 * (server.ts onCompletion): extractStatementAtOffset → resolveContext →
 * buildCompletions, ma usando lo SCHEMA REALE di localhost invece di tabelle
 * finte. È l'equivalente automatico del test manuale nell'editor.
 *
 * Il cursore si indica con `|` dentro l'SQL del caso.
 *
 * Uso:  node live.js            → esegue tutti i casi
 *       node live.js 20         → solo i casi della PR #20
 *       node live.js 20 -v      → mostra anche le prime completion proposte
 *
 * Gira sul codice COMPILATO del branch attualmente in checkout: ricordarsi di
 * `npm run compile` in server/ dopo ogni cambio di branch.
 */
const path = require('node:path');
const fs = require('node:fs');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
/** Cartella degli snapshot di schema (gitignored, condivisa con dump-schema.mjs). */
const SNAP = process.env.SQLPROMPT_LIVE_SCHEMA || path.join(REPO, '.live-schema');

const { extractStatementAtOffset } = require(path.join(REPO, 'server/out/documentTextService.js'));
const { resolveContext } = require(path.join(REPO, 'server/out/cursorContextResolver.js'));
const { buildCompletions } = require(path.join(REPO, 'server/out/completionEngine.js'));
const { TextDocument } = require(path.join(REPO, 'server/node_modules/vscode-languageserver-textdocument'));

// ── Snapshot di schema ────────────────────────────────────────────────────────

const snapshotCache = new Map();
function loadSnapshot(db) {
  if (!snapshotCache.has(db)) {
    const file = path.join(SNAP, `schema-${db}.json`);
    if (!fs.existsSync(file)) {
      throw new Error(
        `snapshot mancante: ${file} — esegui prima "npm run test:live:schema"`,
      );
    }
    snapshotCache.set(db, JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  return snapshotCache.get(db);
}

// ── Esecuzione di un singolo caso ─────────────────────────────────────────────

/**
 * Esegue le completion nel punto marcato da `|` e restituisce gli item più il
 * contesto risolto (utile per capire *perché* un caso fallisce).
 */
function completaAlCursore(sqlConCursore, db, { cursorIndex = 0 } = {}) {
  const marcatori = [...sqlConCursore].reduce(
    (acc, ch, i) => (ch === '|' ? [...acc, i] : acc), []);
  if (!marcatori.length) throw new Error('il caso non contiene il marcatore |');

  // Rimuove tutti i marcatori e calcola l'offset di quello scelto.
  const offset = marcatori[cursorIndex] - cursorIndex;
  const text = sqlConCursore.split('|').join('');

  const snap = loadSnapshot(db);
  const document = TextDocument.create('file:///live.sql', 'sql', 1, text);
  const position = document.positionAt(offset);
  const statementRange = extractStatementAtOffset(text, offset);
  const context = resolveContext(statementRange.text, statementRange.start, offset, snap.tables);
  const items = buildCompletions(
    context, snap.tables, snap.routines, document, position, statementRange,
    snap.databases, new Set(),
  );

  return { items, context, statementRange, text, offset };
}

// ── Asserzioni ────────────────────────────────────────────────────────────────

const etichette = (items) => items.map((i) => i.label);
/** Testo realmente inserito: gli item tabella usano textEdit, gli altri insertText. */
const inserimenti = (items) => items.map((i) => i.textEdit?.newText ?? i.insertText ?? i.label);

function verifica(caso) {
  const esiti = [];
  const r = completaAlCursore(caso.sql, caso.db, { cursorIndex: caso.cursorIndex ?? 0 });
  const lab = etichette(r.items);
  const ins = inserimenti(r.items);

  for (const atteso of caso.attesi ?? []) {
    if (!lab.includes(atteso)) esiti.push(`manca l'item atteso "${atteso}"`);
  }
  for (const vietato of caso.vietati ?? []) {
    if (lab.includes(vietato)) esiti.push(`presente l'item vietato "${vietato}"`);
  }
  // Scope: le sorgenti visibili devono essere ESATTAMENTE queste (in qualunque
  // ordine). È l'asserzione diretta del confine di statement: se il confine non
  // viene rilevato, qui compaiono le tabelle dello statement precedente.
  if (caso.sorgentiAttese) {
    const trovate = r.context.visibleSources.map((s) => s.objectName).sort();
    const attese = [...caso.sorgentiAttese].sort();
    if (JSON.stringify(trovate) !== JSON.stringify(attese)) {
      esiti.push(`sorgenti visibili [${trovate.join(', ')}] invece di [${attese.join(', ')}]`);
    }
  }
  // Alias associato a una sorgente già presente nel testo.
  for (const [oggetto, aliasAtteso] of Object.entries(caso.aliasSorgenti ?? {})) {
    const s = r.context.visibleSources.find((x) => x.objectName === oggetto);
    if (!s) esiti.push(`sorgente "${oggetto}" non visibile`);
    else if (s.alias !== aliasAtteso) esiti.push(`alias di ${oggetto} = "${s.alias}" invece di "${aliasAtteso}"`);
  }
  // Un inserimento che deve comparire esattamente (es. "dbo.ARTICOLI AS a").
  for (const atteso of caso.inserimentiAttesi ?? []) {
    if (!ins.some((t) => t === atteso)) {
      const simili = ins.filter((t) => typeof t === 'string' && t.includes(atteso.split(' ')[0]));
      esiti.push(`manca l'inserimento "${atteso}"${simili.length ? ` (trovato invece: ${simili.slice(0, 3).join(' / ')})` : ''}`);
    }
  }
  for (const vietato of caso.inserimentiVietati ?? []) {
    if (ins.some((t) => t === vietato)) esiti.push(`presente l'inserimento vietato "${vietato}"`);
  }
  // Ordine: la prima label che matcha `primo` deve precedere quelle di `dopo`.
  if (caso.ordine) {
    const { primo, dopo } = caso.ordine;
    const ordinati = [...r.items].sort((a, b) =>
      String(a.sortText ?? a.label).localeCompare(String(b.sortText ?? b.label)));
    const iPrimo = ordinati.findIndex((i) => i.label === primo);
    if (iPrimo === -1) esiti.push(`"${primo}" assente, impossibile verificare l'ordine`);
    else for (const d of dopo) {
      const iDopo = ordinati.findIndex((i) => i.label === d);
      if (iDopo !== -1 && iDopo < iPrimo) {
        esiti.push(`ordine errato: "${d}" (pos ${iDopo}) precede "${primo}" (pos ${iPrimo})`);
      }
    }
  }
  // Nessun duplicato fra le label proposte.
  if (caso.senzaDuplicati) {
    const visti = new Map();
    for (const l of lab) visti.set(l, (visti.get(l) ?? 0) + 1);
    const dup = [...visti].filter(([, n]) => n > 1);
    if (dup.length) esiti.push(`label duplicate: ${dup.slice(0, 5).map(([l, n]) => `${l}×${n}`).join(', ')}`);
  }
  if (caso.check) {
    const esito = caso.check(r);
    if (esito) esiti.push(esito);
  }

  return { esiti, r };
}

// ── Runner ────────────────────────────────────────────────────────────────────

const casi = require('./casi.js');
const filtroPr = process.argv.slice(2).find((a) => /^\d+$/.test(a));
const verboso = process.argv.includes('-v');
const selezionati = filtroPr ? casi.filter((c) => String(c.pr) === filtroPr) : casi;

let ok = 0;
const falliti = [];

console.log(`\nHarness live — ${selezionati.length} casi${filtroPr ? ` (PR #${filtroPr})` : ''}\n`);

for (const caso of selezionati) {
  let esiti, r;
  try {
    ({ esiti, r } = verifica(caso));
  } catch (e) {
    falliti.push({ caso, esiti: [`ECCEZIONE: ${e.message}`] });
    console.log(`  ✖ [#${caso.pr}] ${caso.nome}\n      ECCEZIONE: ${e.message}`);
    continue;
  }
  if (esiti.length) {
    falliti.push({ caso, esiti, r });
    console.log(`  ✖ [#${caso.pr}] ${caso.nome}`);
    for (const e of esiti) console.log(`      → ${e}`);
    console.log(`      contesto: clause=${r.context.clause} kind=${r.context.statementKind} ` +
                `sorgenti=[${r.context.visibleSources.map((s) => `${s.objectName}→${s.alias}${s.explicitAlias ? '' : '*'}`).join(', ')}] ` +
                `items=${r.items.length}`);
    if (verboso) console.log(`      prime 12: ${etichette(r.items).slice(0, 12).join(', ')}`);
  } else {
    ok++;
    console.log(`  ✔ [#${caso.pr}] ${caso.nome}`);
    if (verboso) {
      console.log(`      contesto: clause=${r.context.clause} sorgenti=[${r.context.visibleSources.map((s) => `${s.objectName}→${s.alias}`).join(', ')}] items=${r.items.length}`);
      console.log(`      prime 12: ${etichette(r.items).slice(0, 12).join(', ')}`);
    }
  }
}

console.log(`\n  ${ok}/${selezionati.length} passati, ${falliti.length} falliti\n`);
process.exit(falliti.length ? 1 : 0);
