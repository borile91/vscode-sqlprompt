# Motore di formattazione .NET (anteprima)

Motore alternativo al formatter TypeScript, attivabile con `sqlPrompt.formatting.engine = "dotnet"`. L'obiettivo è la **parità con Redgate SQL Prompt**, misurata con la CLI di Redgate usata come oracolo.

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
  - `sqlPrompt.formatting.engine`: `legacy` (default) oppure `dotnet`;
  - `sqlPrompt.formatting.dotnetPath`: eseguibile `dotnet` (facoltativo).
- **Runtime .NET**, nell'ordine:
  1. percorso configurato;
  2. estensione **.NET Install Tool** (`dotnet.acquire`, versione 10.0), se installata;
  3. `dotnet` dal `PATH`.
- **Ripiego**: se il motore non parte si usa il formatter TypeScript, con un avviso una sola volta.
- **Errore di sintassi**: il documento resta invariato e l'avviso indica riga e colonna.
- **Rete di sicurezza**: `formatGuard` vale anche per il motore .NET.
- **Build**: `npm run build:engine` pubblica in `client/dist/formatter-engine/`, ed è incluso in `vscode:prepublish`.
- **Test**: `npm run test:engine`.

## Oracolo e corpus

- **Oracolo**: `tools/redgate-oracle/redgate-format.sh` lancia `SqlPrompt.Format.CommandLine.exe` nella VM Parallels (`prlctl exec`, percorsi UNC `\\Mac\...`).
  - Richiede l'accettazione della **EULA Redgate** (`--i-agree-to-the-eula`).
- **Corpus**: `tools/redgate-oracle/build-corpus.sh` rigenera `formatter-engine/tests/corpus/`:
  - `inputs/`: fixture del formatter TS ed esempi non passanti;
  - `styles/`: i 4 profili utente e i 5 stili incorporati di SQL Prompt (Default, Collapsed, CommasBefore, Indented, RightAligned);
  - `expected/<stile>/`: output Redgate, **252 casi**.
- **Verifica**: le 24 fixture del formatter TS sono **identiche** all'output Redgate del proprio profilo.
- **Ratchet**: `passing.txt` elenca i casi identici, che devono restarlo.
- **Punteggio**: `dotnet test --filter Punteggio --logger "console;verbosity=detailed"`.

## Stato attuale

- **78/252** casi identici, **77,9%** di righe in comune con Redgate.
- **Profili utente**: Vertical 99%, Inline 92%, Tsqlt 91%, Scripting 89%.
- **Example7** (`docs/formatting/example-not-passing/`, irrisolti con il formatter TS): tutti e 4 **identici** a Redgate con il proprio profilo, ora nel ratchet.
- **Stili incorporati**: Collapsed e Indented sotto il 45%; mancano `toFirstListItem` e la compattazione completa.

### Coperti

- **Statement**: statement e batch (GO, righe vuote, gruppi DECLARE/SET/PRINT).
- **Query**: SELECT con TOP/DISTINCT; FROM/JOIN/ON in tutte le varianti di allineamento; WHERE/HAVING con AND/OR; GROUP BY e ORDER BY.
- **Liste**: virgole prima/dopo, allineamento al primo elemento, incolonnamento tra clausole e degli alias.
- **Espressioni**: sottoquery e parentesi espanse/compatte; CASE; chiamate a funzione; IN; espressioni lunghe con riempimento.
- **DML**: INSERT, UPDATE, DELETE, EXEC.
- **Controllo di flusso**: BEGIN/END, IF/ELSE, WHILE, TRY/CATCH.
- **DDL**: procedure, funzioni, viste; CREATE TABLE, ALTER TABLE ADD, vincoli, opzioni degli indici.
- **Maiuscole**.

### Da fare, in ordine di impatto

- **Stili Indented e Collapsed**: `clauseAlignment = toFirstListItem`, compattazione di statement e sottoquery.
- **Variabili**: `placeEqualsSignOnNewLine`, `placeAssignedValueOnNewLineIfLongerThanMaxLineLength`, `addSpaceBetweenDataTypeAndPrecision`.
- **CTE** e la sezione `cte.*`.
- **Colonne dei vincoli** negli stili con virgola iniziale.
- **Operatori**: `operators.between.*`, `operators.comparison.align`, `insertStatements.*` di tipo `expandedSplit`.
- **Commenti**: allineamento dei commenti di riga (`alignGroupOfSingleLineComments`, `lists.alignComments`).
- **Selezione**: formattazione di una selezione.

## Note sullo schema degli stili

- I default reali di SQL Prompt differiscono da `docs/formatting/Defaults.json`. Ad esempio `whitespace.wrapLinesLongerThan` vale 120 e `lists.placeSubsequentItemsOnNewLines` vale `always`.
- Alcune chiavi di `Defaults.json` non esistono nel formato Redgate:
  - `operators.comparisonOperators`, che in Redgate è `operators.comparison`;
  - `joinStatements.join.breakType`;
  - `lists.placeFirstItemOnNewLines`, che in Redgate è al singolare.
- `lists.addSpaceBeforeComma` non ha effetti visibili nell'output della CLI. È verificato con l'oracolo.
