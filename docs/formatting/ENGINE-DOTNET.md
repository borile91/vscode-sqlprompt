# Motore di formattazione .NET

Motore di formattazione **predefinito** (`sqlPrompt.formatting.engine = "dotnet"`); il formatter TypeScript resta disponibile con `legacy` e come ripiego. L'obiettivo è la **compatibilità con i file di stile di SQL Prompt**, verificata con la CLI di SQL Prompt usata come riferimento.

## Perché un motore separato

- **Il formatter di SQL Prompt** (`SQLPrompt.Format.exe`) lavora sull'AST di **Microsoft ScriptDom** (`TSql170Parser`).
  - Non riscrive mai il testo: decide solo **lo spazio tra i token originali** (a capo, rientro, allineamento).
  - Uno script con errori di sintassi **non viene formattato**.
- **Il formatter TypeScript attuale** è `sql-formatter` più circa 25 passaggi regex, senza AST.
  - Le correzioni restano locali e i costrutti annidati sono fragili.
- **ScriptDom** è open source (MIT) e disponibile su NuGet. Usandolo si ottengono gli stessi nodi e gli stessi confini di token di SQL Prompt.
- **Costo**: serve il runtime **.NET 10**. L'estensione è già limitata al desktop per la dipendenza da `ms-mssql.mssql`, quindi .NET non riduce la compatibilità.

## Architettura (`formatter-engine/`)

| Parte | Percorso | Ruolo |
|---|---|---|
| **Stile** | `src/SqlFormatter.Engine/Style/` | Modello del JSON di SQL Prompt con i **default reali** di Redgate; chiavi assenti = default |
| **Modello di layout** | `Layout/LayoutModel.cs` | Uno slot per token significativo; regole: **a capo**, **ancora + offset**, **gruppi di a capo**, **compattazione**, **allineamento verticale** |
| **Regole** | `Rules/RuleBuilder*.cs` | Visitor ScriptDom: per ogni nodo traduce le opzioni di stile in regole sui token |
| **Spaziatura** | `Layout/Spacing.cs` | Spazi tra coppie di token; correzioni per chiamate, IN, parentesi |
| **Maiuscole** | `Casing/` | Parole chiave, funzioni di sistema, tipi di dato, variabili globali |
| **Risolutore** | `Layout/LayoutSolver.cs` | Calcola colonne e a capo, poi stampa |
| **Sidecar** | `src/SqlFormatter.Sidecar/` | Processo stdin/stdout, un JSON per riga |

### Gruppi di a capo

| Modalità | Comportamento | Opzioni Redgate |
|---|---|---|
| `Always` | a capo su ogni punto | `always` |
| `IfLong` | tutti i punti se l'intervallo supera la larghezza | `ifLongerThanMaxLineLength` |
| `IfLongOrMultiple` | sempre se più elementi, altrimenti come `IfLong` | `ifMultiple`, `ifSubsequentItems`… |
| `Wrap` | **riempimento**: a capo solo quando il pezzo non sta più | `never` (con `wrapLongLines`) |

### Ordine di risoluzione

1. **Commenti di riga**: dopo un commento di riga si va sempre a capo.
2. **Compattazione**: dall'esterno verso l'interno, gli intervalli più corti della soglia finiscono su una riga.
3. **Gruppi `Always`**: si applicano tutti.
4. **Correzioni dall'esterno verso l'interno**, una alla volta finché tutto sta nella larghezza:
   - un intervallo compattato che finisce oltre la soglia si riapre, e i suoi interni si rivalutano;
   - un gruppo `IfLong` che sfora (o contiene un commento di riga) si spezza;
   - un pezzo di riempimento che, su più righe, sfora va a capo.
5. **Colonne**: l'ancora dà il rientro, i gruppi verticali danno l'incolonnamento (alias, tipi, elementi tra clausole, commenti in coda).

## Protocollo del sidecar

- **Richiesta**: `{"id":1,"sql":"...","style":{...stile SQL Prompt...}}`
- **Risposta**: `{"id":1,"ok":true,"text":"..."}` oppure `{"id":1,"ok":false,"errors":[{"line":1,"column":8,"message":"..."}]}`
- **Prova manuale**: `dotnet SqlFormatter.Sidecar.dll format stile.json file.sql`

## Integrazione nell'estensione

- **Impostazioni**:
  - `sqlPrompt.formatting.engine`: `dotnet` (default) oppure `legacy`;
  - `sqlPrompt.formatting.dotnetPath`: eseguibile `dotnet` (facoltativo).
- **Runtime .NET**, nell'ordine:
  1. percorso configurato;
  2. estensione **.NET Install Tool** (`dotnet.acquire`, versione 10.0): è una dipendenza dell'estensione, quindi il runtime si scarica da solo al primo uso;
  3. `dotnet` dal `PATH`.
- **Ripiego**: se il motore non parte si usa il formatter TypeScript, con un avviso una sola volta.
- **Errore di sintassi**: il documento resta invariato e l'avviso indica riga e colonna.
- **Rete di sicurezza**: `formatGuard` vale anche per il motore .NET.
- **Build**: `npm run build:engine` pubblica in `client/dist/formatter-engine/`, ed è incluso in `vscode:prepublish`.
- **Test**: `npm run test:engine`.

## Oracolo e corpus

- **Oracolo**: `tools/redgate-oracle/redgate-format.sh` lancia `SqlPrompt.Format.CommandLine.exe` nella VM Parallels (`prlctl exec`, percorsi UNC `\\Mac\...`).
  - Richiede l'accettazione della **EULA Redgate** (`--i-agree-to-the-eula`).
  - Lavora **a blocchi** (`ORACLE_CHUNK`, default 150) con **3 tentativi** per blocco e **riprende la VM** se Parallels l'ha sospesa.
  - La CLI scrive sempre **CRLF**: i test confrontano il testo con fine riga normalizzati.
- **Corpus**: `tools/redgate-oracle/build-corpus.sh` rigenera `formatter-engine/tests/corpus/`:
  - `inputs/`: fixture del formatter TS, esempi non passanti e **casi mock** (`mocks/`);
  - `styles/`: i 4 profili utente, esportati da SQL Prompt dagli utenti (gli stili incorporati nel prodotto non vengono ridistribuiti);
  - `expected/<stile>/`: output Redgate, **136 casi** (34 input × 4 stili).
- **Casi mock** (`tests/corpus/mocks/`): SQL **inventato** (dominio biblioteca, nessun nome reale), scritto per riprodurre le combinazioni particolari trovate negli script del DB:
  - `mock_commenti`: intestazioni, commenti attaccati allo statement precedente o al successivo, commenti in coda incolonnati, commenti a blocco su più righe, prosecuzione di un commento in coda;
  - `mock_procedura_cursori`: parametri con commenti, DECLARE con `=` incolonnati, `SET … = CURSOR … FOR` e `DECLARE … CURSOR FOR`, `FETCH … INTO`, EXEC con parametri, RAISERROR con commenti, TRY/CATCH, `ELSE IF`;
  - `mock_query_annidate`: EXISTS annidati, IN con funzione tabellare, IIF e CASE con AND, STUFF/FOR XML, OUTER APPLY TOP, DELETE/UPDATE con alias, SELECT INTO, VALUES su più righe con commenti;
  - `mock_ddl`: CREATE TABLE con `WITH(FILLFACTOR)`, CREATE/ALTER INDEX, ALTER TABLE, `sp_addextendedproperty`, trigger, viste, funzioni inline e multi-istruzione, `DECLARE @t TABLE`;
  - `mock_tsqlt`: un test tSQLt con FakeTable, VALUES multi-riga e AssertEqualsTable;
  - `mock_varie`: etichette e GOTO, DROP consecutivi, alias con maiuscole diverse, vista con riga vuota dopo AS.
- **Ratchet**: `passing.txt` elenca i casi identici, che devono restarlo (**96**, di cui 15 mock).
- **Punteggio**: `dotnet test --filter Punteggio --logger "console;verbosity=detailed"`.

## Casi una opzione per volta

- **Scopo**: ogni impostazione dell'editor degli stili ha un caso di test con l'**output della CLI**.
- **Generatore**: `tools/redgate-oracle/options-cases.mjs` legge lo schema dell'editor (`client/src/formatter/styleSchema.ts`, client compilato) e scrive `formatter-engine/tests/options/`:
  - `inputs/<sezione>.sql`: l'**SQL di anteprima** della sezione;
  - `styles/<sezione>__<chiave>=<valore>.json`: stile predefinito + **una sola opzione** + le sue condizioni (`enabledWhen`, `appliesWhen`);
  - `cases.txt`: `caso sezione caso-di-confronto` (il confronto è lo stile predefinito, o le sole condizioni dell'opzione).
- **Oracolo**: `tools/redgate-oracle/build-options.sh [sezione…]` genera `expected/`.
  - Più casi per sessione della VM; i casi rimasti **identici all'input** (sessione caduta) vengono **rifatti**.
  - Con delle sezioni rigenera solo quelle.
- **Test**:
  - motore (`OptionTests`): ratchet `tests/options/passing.txt`, punteggio con `--filter "FullyQualifiedName~OptionTests.Punteggio"`;
  - client (`styleSchema.test.ts`): i casi coprono **tutte le opzioni** dello schema, e ogni opzione **cambia l'anteprima** della sua sezione (le eccezioni note sono elencate nel test).

## Validazione sugli script reali del DB

- **Script**: `tools/redgate-oracle/validate-scripts.sh <stile> <cartella-script> <cartella-lavoro> [--oracle]`.
  - Copia gli script, li formatta con la CLI Redgate (`--oracle`) e con il motore, e confronta.
  - **Tutto resta nella cartella di lavoro, fuori dal repo**: nel repo finiscono solo i casi mock.
  - `tools/redgate-oracle/cluster.py` raggruppa le differenze per tipo (rientro, a capo, spazi, maiuscole, righe vuote).
- **Risultati su un database reale** (progetto SSDT non pubblicato, 3.882 script, 2026-10-19):
  - **profilo Vertical** (2.732 script): **2.023 identici all'output di riferimento**, **95,4%** delle righe uguali.
  - **profilo Tsqlt** (1.150 test tSQLt): **1.053 identici**, **98,9%** delle righe uguali.
  - Script analizzabili: tutti tranne 1, che ha un errore di sintassi anche per ScriptDom.

## Stato attuale

- **Corpus**: **96/136** casi identici, **95,5%** di righe in comune con l'output di riferimento.
- **Profili utente**: Vertical 99%, Inline 96%, Tsqlt 97%, Scripting 87%.
- **Una opzione per volta**: **231/238** casi identici (ratchet `tests/options/passing.txt`).
  - Tutte le sezioni complete tranne Operators 21/25, DDL 19/20, Insert 23/24, Joins 18/19.
  - I 7 casi rimasti sono output anomali della CLI (riempimenti irregolari, JOIN in linea con colonna comune enorme, `comparison.align`).
- **Example7** (`docs/formatting/example-not-passing/`, irrisolti con il formatter TS): **anonimizzati** (nomi di tabelle, colonne, parametri e commenti sostituiti) e riformattati con la CLI; tutti e 4 **identici** a Redgate con il proprio profilo, nel ratchet.

### Coperti

- **Statement**: statement e batch (GO, righe vuote, gruppi DECLARE/SET/PRINT/DROP/CLOSE-DEALLOCATE, etichette).
- **Commenti**: in testa al file, prima degli statement (di primo livello o nei blocchi), in coda nelle liste, prosecuzioni, a blocco su più righe.
- **Query**: SELECT con TOP/DISTINCT/INTO; FROM/JOIN/ON in tutte le varianti di allineamento; WHERE/HAVING con AND/OR; GROUP BY e ORDER BY; FOR XML; CTE (`cte.*`).
- **Colonna comune delle clausole** (`alignItemsAcrossClauses`): parola chiave più lunga, tabelle dei JOIN comprese; un elemento a capo prende la colonna comune; disattivata con clausole allineate a destra o senza `alignSubsequentItemsWithFirstItem`.
- **Liste**: virgole prima/dopo, allineamento al primo elemento, incolonnamento tra clausole e degli alias.
- **Espressioni**: sottoquery e parentesi espanse/compatte; EXISTS; CASE; chiamate a funzione (AND/OR in linea negli argomenti); IN; espressioni lunghe con riempimento.
- **DML**: INSERT (VALUES su più righe), UPDATE, DELETE, EXEC, RAISERROR, RESTORE … MOVE … TO.
- **Controllo di flusso**: BEGIN/END, IF/ELSE, WHILE, TRY/CATCH, cursori (SET/DECLARE … CURSOR FOR, FETCH INTO).
- **DDL**: procedure, funzioni (anche inline), viste, trigger; CREATE TABLE, ALTER TABLE ADD, vincoli, CREATE/ALTER INDEX, `DECLARE @t TABLE`.
- **Maiuscole**: parole chiave, funzioni, tipi; variabili come nella dichiarazione; nomi dei parametri di EXEC come i parametri della procedura; alias di tabella come nella definizione (per query).

### Da fare, in ordine di impatto

- **Casi per opzione ancora diversi**: elenco con `dotnet test --filter "FullyQualifiedName~OptionTests.Punteggio" --logger "console;verbosity=detailed"`.
- **Stili Indented e Collapsed**: `clauseAlignment = toFirstListItem`, compattazione di statement e sottoquery.
- **Colonne dei vincoli** negli stili con virgola iniziale (anche negli indici dello stile Test).
- **Virgola seguita da commento** nelle liste con virgola iniziale: Redgate sposta il commento prima della virgola.
- **Operatori**: `operators.between.*`, `operators.comparison.align`, `insertStatements.*` di tipo `expandedSplit`.
- **Selezione**: formattazione di una selezione.

## Regole osservate con l'oracolo

- **Righe vuote**:
  - con `preserveExisting…` a false si usa sempre il numero configurato;
  - DECLARE, SET, PRINT, DROP e CLOSE/DEALLOCATE consecutivi restano senza righe vuote.
- **Commenti prima di uno statement**:
  - i commenti attaccati al precedente e separati da una riga vuota restano col precedente;
  - le righe vuote previste vanno prima del gruppo che apre lo statement;
  - tra commento e codice non ci sono righe vuote, tranne davanti agli statement di primo livello.
- **`=` delle DECLARE**: si incolonnano sulla fine del tipo più lungo solo se un valore sta su una dichiarazione intermedia.
- **Parentesi**:
  - `))` sempre attaccate, tranne dopo una funzione tabellare in FROM: `dbo.f(1, @x) );`.
- **`WITH(opzione)`**: nei vincoli con una sola opzione è tutto attaccato; con più opzioni è spaziato.
- **Fine file**: l'a capo finale resta, tranne dopo un GO.
- **Dopo GO**: le righe vuote originali restano, qualunque sia `emptyLinesAfterBatchSeparator`; senza `preserveExistingEmptyLinesBetweenStatements` ce n'è almeno una.
- **Opzioni senza effetto a false**: `lists.addSpaceAfterComma` e `operators.arithmetic.addSpacesAround` a false lasciano gli spazi (SQL Prompt rinuncia solo alla propria regola).
- **Virgola iniziale e commento in coda**: il commento va prima della virgola (`a -- nota` / `, b`).
- **Colonna comune delle clausole**: è quella della parola chiave più lunga; con le tabulazioni (`spacesOrTabs = tabs`) va alla tabulazione successiva e i riempimenti diventano tabulazioni.
- **IN**: con più valori il primo va a capo, rientrato dalla parola chiave della condizione; gli altri seguono sulla stessa riga finché c'è spazio.
- **Parentesi delle condizioni**: AND/OR finiscono prima della colonna "(" + 1, anche con contenuto rientrato.
- **Limite di riga**: il `;` finale non conta.

## Note sullo schema degli stili

- I default reali di SQL Prompt differiscono da `docs/formatting/Defaults.json`. Ad esempio `whitespace.wrapLinesLongerThan` vale 120 e `lists.placeSubsequentItemsOnNewLines` vale `always`.
- Alcune chiavi di `Defaults.json` non esistono nel formato Redgate:
  - `operators.comparisonOperators`, che in Redgate è `operators.comparison`;
  - `joinStatements.join.breakType`;
  - `lists.placeFirstItemOnNewLines`, che in Redgate è al singolare.
- `lists.addSpaceBeforeComma` vale solo con le virgole dopo gli elementi (con la virgola iniziale non si vede).
