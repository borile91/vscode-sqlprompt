# SQL Prompt for VS Code

SQL Server IntelliSense extension (LSP-based) — schema-aware autocomplete simile a Redgate SQL Prompt.

## Architettura

```
vscode-sqlprompt/
├── package.json              # Extension manifest
├── tsconfig.json             # Root TS project references
├── client/                   # Language Client (VS Code extension)
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       └── extension.ts      # Entry point: avvia il Language Server
├── server/                   # Language Server (processo separato)
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── server.ts         # LSP server: gestisce completion
│       └── schemaLoader.ts   # Connessione SQL Server e caricamento schema
└── .vscode/
    ├── launch.json           # Debug configurations
    └── tasks.json            # Build tasks
```

## Flusso LSP

```
┌─────────────────────┐         LSP/IPC          ┌──────────────────────┐
│   VS Code (Client)  │ ◄──────────────────────► │   Language Server    │
│                     │                           │                      │
│  extension.ts       │   onCompletion request    │  server.ts           │
│  - avvia server     │ ──────────────────────►   │  - analizza contesto │
│  - comandi utente   │                           │  - propone tabelle   │
│                     │   CompletionItem[]        │                      │
│                     │ ◄──────────────────────   │  schemaLoader.ts     │
│                     │                           │  - connessione MSSQL │
└─────────────────────┘                           │  - query sys.tables  │
                                                  └──────────────────────┘
```

## Installazione e Primo Avvio

### Prerequisiti

- Node.js >= 18
- VS Code >= 1.75
- Un'istanza SQL Server raggiungibile

### Setup

```bash
cd ~/Development/vscode-sqlprompt

# Installa dipendenze (root + client + server)
npm install

# Compila
npx tsc -b
```

### Esecuzione in Development Mode

1. Apri la cartella `vscode-sqlprompt` in VS Code
2. Premi **F5** (o Run > Start Debugging)
3. Si apre una nuova finestra VS Code (Extension Development Host)
4. In quella finestra, apri un file `.sql`

### Configurazione Connessione

Aggiungi in `settings.json` (User o Workspace):

```json
{
  "sqlPrompt.connection": {
    "server": "localhost",
    "database": "MioDatabase",
    "user": "sa",
    "password": "LatuaPassword123",
    "port": 1433,
    "trustServerCertificate": true
  }
}
```

Oppure usa il comando **SQL Prompt: Connect to Database** (Ctrl+Shift+P) che ti guida interattivamente.

### Comandi Disponibili

| Comando | Descrizione |
|---------|-------------|
| `SQL Prompt: Connect to Database` | Connetti al database |
| `SQL Prompt: Disconnect` | Disconnetti |
| `SQL Prompt: Reload Schema` | Ricarica lo schema |

## Come Funziona l'IntelliSense

Quando scrivi in un file `.sql`:

```sql
SELECT * FROM |
```

Dopo `FROM` (o `JOIN`), l'estensione propone tutte le tabelle con:
- Schema prefix: `dbo.PRESTITI_DETTAGLIO`
- Alias automatico: `AS od`

**Logica alias:**
- `PRESTITI_DETTAGLIO` → `od` (prima lettera di ogni parola separata da `_`)
- `OrderDetails` → `od` (lettere maiuscole in PascalCase)
- `Orders` → `o` (parola singola → prima lettera)

Il completion inserisce: `dbo.PRESTITI_DETTAGLIO AS od`

## Installazione come VSIX (pacchetto)

Per installare l'estensione permanentemente:

```bash
# Installa vsce (tool di packaging)
npm install -g @vscode/vsce

# Crea il pacchetto
cd ~/Development/vscode-sqlprompt
vsce package

# Installa il .vsix generato
code --install-extension vscode-sqlprompt-0.1.0.vsix
```

## Prossimi Sviluppi

- [ ] Completamento colonne dopo alias (es. `od.` → colonne di PRESTITI_DETTAGLIO)
- [ ] Snippet per INSERT, UPDATE, DELETE
- [ ] Supporto multi-database
- [ ] Stored procedures e views nell'IntelliSense
- [ ] Hover con info colonna
- [ ] Go to Definition su tabelle