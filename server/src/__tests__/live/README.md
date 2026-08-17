# Suite `test:live`

Test di completion eseguiti contro lo **schema reale** di un SQL Server, invece
che su tabelle finte. Replicano la stessa catena che il server LSP esegue a ogni
keystroke (`server.ts` → `onCompletion`):

```
extractStatementAtOffset → resolveContext → buildCompletions
```

Sono l'equivalente automatico della prova a mano nell'Extension Development
Host: verificano cosa l'utente vedrebbe davvero nella tendina, su database con
migliaia di tabelle e nomi che i fixture non coprono (schemi multipli, tabelle
omonime in schemi diversi, nomi che collidono con parole chiave T-SQL).

**Non** girano con `npm test`: richiedono un database raggiungibile, quindi
restano una suite separata e opt-in.

## Come si esegue

1. **Una volta**, estrai lo snapshot di schema (serve la password `sa`):

   ```bash
   SA_PW='…' npm run test:live:schema
   ```

   Con SQL Server in un container Docker la password si può passare senza
   scriverla a mano né stamparla a schermo:

   ```bash
   SA_PW="$(docker exec sqlserver printenv SA_PASSWORD)" npm run test:live:schema
   ```

   Lo snapshot finisce in `.live-schema/` nella radice del repo (gitignored:
   contiene nomi di tabelle e colonne di database reali). Per cambiare
   destinazione, imposta `SQLPROMPT_LIVE_SCHEMA`.

   Per usare database diversi da `EasyStock_Master` / `EasyMexs_Master`, passali
   come argomenti a `dump-schema.mjs` e aggiorna i casi.

2. **Esegui i casi**:

   ```bash
   npm run test:live          # tutti
   node src/__tests__/live/live.js 20     # solo i casi della PR #20
   node src/__tests__/live/live.js 20 -v  # con le completion proposte
   ```

   Il rename di alias ha una sonda a parte, che stampa il risultato di ogni
   rinomina invece di limitarsi a passare o fallire:

   ```bash
   npm run test:live:rename
   ```

I test girano sul codice **compilato**: `test:live` esegue `tsc -b` prima di
partire, ma se lanci `live.js` a mano dopo aver cambiato branch ricordati di
ricompilare.

## Come si aggiunge un caso

I casi stanno in [`casi.js`](./casi.js), uno per oggetto. Il cursore si segna
con `|` dentro l'SQL:

```js
{
  pr: 20, db: 'EasyStock_Master',
  nome: 'prima tabella della query: alias base, non "a2"',
  sql: 'SELECT * FROM dbo.ARTICOL|',
  inserimentiAttesi: ['ARTICOLI AS a'],
  inserimentiVietati: ['ARTICOLI AS a2'],
}
```

Asserzioni disponibili:

| campo | verifica |
| --- | --- |
| `attesi` / `vietati` | label che devono / non devono comparire |
| `inserimentiAttesi` / `inserimentiVietati` | testo **realmente inserito** (`textEdit.newText`, non la label) |
| `sorgentiAttese` | le sorgenti visibili sono esattamente queste — è il modo diretto di testare i confini di statement |
| `aliasSorgenti` | alias associato a una sorgente già presente nel testo |
| `ordine` | `{ primo, dopo: [...] }`: `primo` deve precedere ognuno dei `dopo` nell'ordinamento per `sortText` |
| `senzaDuplicati` | nessuna label proposta due volte |
| `check(r)` | controllo libero; riceve `{ items, context, statementRange }` e restituisce una stringa d'errore o niente |

Con più marcatori `|` nello stesso SQL, `cursorIndex` scegle su quale fermarsi.

## Perché la controprova conta

Un caso che passa sia prima sia dopo una modifica non sta testando quella
modifica. Il modo di accorgersene è eseguire i casi **anche sul branch
precedente**: devono fallire là e passare qui.

```bash
git checkout main && (cd server && npm run compile) && node server/src/__tests__/live/live.js 22
```

Durante la revisione delle PR #19–#23 questa controprova ha scartato tre casi
che sembravano verdi ma passavano già su `main`, e ha confermato i restanti.

## Note sulle label

Il testo proposto dipende dal contesto, e gli assert vanno scritti di
conseguenza:

- in `FROM` / `JOIN` la tabella si inserisce via `textEdit.newText`
  (`ARTICOLI AS a`), mentre `label` è solo `ARTICOLI`;
- in `WHERE` e in `SELECT` le colonne sono **qualificate**: `a.ARTI` se l'alias
  è scritto nella query, altrimenti `ARTICOLI.ARTI` (mai con l'alias
  auto-generato);
- in `UPDATE … SET` e in `INSERT INTO … (` le colonne sono **nude** (`ARTI`),
  perché è così che si scrivono in quella posizione.
