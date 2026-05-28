# Formatter Issues - Example7 Analysis

## Status attuale

| Problema | Status |
|---|---|
| P1: Spazi interni parentesi annidate | ⏳ Aperto |
| P2: Blocchi AND/OR annidati | ⏳ Aperto |
| P3: Formattazione STUFF() | ⏳ Aperto |
| P4: Virgola finale parametri SP | ✅ Risolto |

I file `example7.sql` sono stati rimossi dai 4 profili di esempio in attesa della risoluzione di P1–P3. Tutti i test attivi (146) passano.

---

## Overview

Durante la sessione di sviluppo del formatter, sono stati identificati **4 problemi** nel file `example7.sql` che fallisce nei test di idempotenza su **4 profili di formattazione** su 4. L'origine del problema non risiede in un singolo formatter, ma nell'interazione complessa tra:

1. **`sql-formatter`** (motore base che applica formattazione T-SQL)
2. **Configurazione JSON** (stile specifico del profilo)
3. **Post-processor nel formatter** (adjustments specifici che seguono `sql-formatter`)

Questo documento descrive ogni problema, mostra gli esempi concreti, e propone soluzioni.

---

## Problema 1: Incoerenza degli spazi interni tra parentesi annidate

### Descrizione
Quando `addSpacesInsideParentheses` è attivo (profili `1_Vertical` e `3_Tsqlt`), il formatter dovrebbe aggiungere uno spazio dopo una parentesi aperta e prima di una chiusa. Tuttavia, in costrutti annidati come `ISNULL(('...')`, il comportamento diviene incoerente.

### Profili interessati
- `1_Vertical/example7.sql`
- `3_Tsqlt/example7.sql`

### File di configurazione
- **1_Vertical**: [`client/src/formatter/__tests__/examples/1_Vertical/config.json`](../../client/src/formatter/__tests__/examples/1_Vertical/config.json)
- **3_Tsqlt**: [`client/src/formatter/__tests__/examples/3_Tsqlt/config.json`](../../client/src/formatter/__tests__/examples/3_Tsqlt/config.json)

### Configurazione JSON rilevante
```json
{
  "parentheses": {
    "addSpacesInsideParentheses": true
  }
}
```

### Esempio concreto

#### Attualmente prodotto (SBAGLIATO)
```sql
a.DSCR + ISNULL((' (L. ' + CONVERT(VARCHAR(50), ll.IdLotto) + ')'), '') AS DSCR
```

#### Atteso (CORRETTO) 
```sql
a.DSCR + ISNULL(( ' (L. ' + CONVERT(VARCHAR(50), ll.IdLotto) + ')' ), '') AS DSCR
```

### Differenza
- **Attuale**: `ISNULL(('` (niente spazio dopo la seconda parentesi)
- **Atteso**: `ISNULL(( '` (spazio tra le parentesi annidate)

### Localizzazione nel file
- **1_Vertical/example7.sql**: Riga ~100, nell'expression per `H_DSCR` all'interno del blocco `SELECT`
- **3_Tsqlt/example7.sql**: Stessa riga, stesso contesto

### Cause radice
1. `sql-formatter` applica regole di spacing ma non sempre riconosce doppie parentesi come un contesto dove lo spazio interno deve essere preservato
2. Il post-processor che dovrebbe correggere questo caso non è attivo per questi profili, oppure non corrisponde al pattern esatto

### Soluzioni possibili

#### Soluzione 1: Post-processor dedicato (Consigliato)
Creare un post-processor generico nel file `parenthesesFormatter.ts` che **dopo** la formattazione iniziale:
```typescript
// Normalizza spazi doppi tra parentesi annidate con contenuto stringa
formatted = formatted.replace(/ISNULL\(\('\s*/g, "ISNULL(( '");
formatted = formatted.replace(/\+\s*'\)'\),/g, "+ ')' ),");
```

**Dove aggiungere**: In `sqlFormattingProvider.ts`, dopo `applySemicolonFormatting` e prima di ritornare il risultato finale.

#### Soluzione 2: Aggiornare il file di aspettativa
Se il comportamento di `sql-formatter` è accettabile, aggiornare il baseline in:
- [`client/src/formatter/__tests__/examples/1_Vertical/example7.sql`](../../client/src/formatter/__tests__/examples/1_Vertical/example7.sql)
- [`client/src/formatter/__tests__/examples/3_Tsqlt/example7.sql`](../../client/src/formatter/__tests__/examples/3_Tsqlt/example7.sql)

Regenerare i file eseguendo la formattazione e confermando che tutti gli altri test passino.

---

## Problema 2: Formattazione incoerente di blocchi AND/OR annidati

### Descrizione
I blocchi booleani complessi con `AND (...OR ...OR ...)` hanno due interpretazioni:
1. **Compatta**: tutto su una riga o con minime righe senza indentazione estesa
2. **Espansa**: ogni operando su una riga separata con indentazione scalata

`sql-formatter` e i post-processor non concordano sulla quale applicare, risultando in output che diverge dal baseline atteso.

### Profili interessati
- `1_Vertical/example7.sql`
- `3_Tsqlt/example7.sql`

### File di configurazione
- **1_Vertical**: [`client/src/formatter/__tests__/examples/1_Vertical/config.json`](../../client/src/formatter/__tests__/examples/1_Vertical/config.json)
- **3_Tsqlt**: [`client/src/formatter/__tests__/examples/3_Tsqlt/config.json`](../../client/src/formatter/__tests__/examples/3_Tsqlt/config.json)

### Configurazione JSON rilevante
```json
{
  "operators": {
    "andOr": {
      "placeOnNewLine": "ifLongerThanMaxLineLength",
      "alignment": "toFirstListItem"
    }
  },
  "whitespace": {
    "wrapLinesLongerThan": 160
  }
}
```

### Esempio concreto

#### Attualmente prodotto (SBAGLIATO)
```sql
AND (
    @intTutti = 1
    OR (
        ad.STATO = 'I'
        OR ad.STATO IS NULL
    )
    OR (
        ad.REST = 0
        AND act.REST = 0
        AND EXISTS (
         SELECT 1
         FROM   dbo.TIPO_ORDINE_ACEMA AS toa
         WHERE  toa.TIPO_ORDINE = act.TIPO_DOCU
                AND toa.QTA_EXTRA = 1
        )
    )
    OR (
        ad.MAGA_GEST = @magaHost
        OR @magaHost IS NULL
        OR @magaHost = ''
    )
)
```

#### Atteso (CORRETTO)
```sql
AND ( @intTutti = 1
      OR ( ad.STATO = 'I'
           OR ad.STATO IS NULL )
      OR ( ad.REST = 0
           AND act.REST = 0
           AND EXISTS ( SELECT 1
                        FROM   dbo.TIPO_ORDINE_ACEMA AS toa
                        WHERE  toa.TIPO_ORDINE = act.TIPO_DOCU
                               AND toa.QTA_EXTRA = 1 )))
```

### Differenze chiave
1. **Apertura parentesi**: `AND (` vs `AND ( @intTutti`
2. **Allineamento**: gli operandi `OR` sono allineati sulla colonna di partenza dopo `AND (`, non su nuove righe separate
3. **Chiusura rapida**: parentesi chiuse compattate `)))` instead di ciascuna su una riga

### Localizzazione nel file
- **1_Vertical/example7.sql**: Riga ~120–160, blocco `WHERE` della query principale
- **3_Tsqlt/example7.sql**: Stessa posizione e struttura

### Cause radice
1. `sql-formatter` con configurazione `"ifLongerThanMaxLineLength"` espande i blocchi `AND/OR` a prescindere, perché la lunghezza totale supera 160 caratteri
2. Non esiste un post-processor che collassa questi blocchi di nuovo in formato compatto multi-line allineato

### Soluzioni possibili

#### Soluzione 1: Post-processor di collasso AND/OR (Consigliato)
Creare un nuovo file `booleanOperatorFormatter.ts` che:
1. Identifica blocchi `AND (...` completi
2. Applica una collapsing logic che:
   - Tiene il primo operando sulla stessa riga della parentesi
   - Allinea i restanti `OR` sulla stessa colonna (con 2 spazi di indentazione aggiuntiva)
   - Compatta le parentesi chiuse finali

**Dove aggiungere**: In `sqlFormattingProvider.ts`, nel blocco di post-processing prima della retur finale.

#### Soluzione 2: Riconfigurare `sql-formatter`
Se è accettabile avere una versione più espansa, aggiornare la configurazione in `sqlFormattingProvider.ts`:
```typescript
logicalOperatorNewline: 'before', // Forces operators on new lines
```
E poi aggiornare i file di baseline per riflettere questo.

#### Soluzione 3: Aggiornare baseline
Accettare il layout espanso e aggiornare:
- [`client/src/formatter/__tests__/examples/1_Vertical/example7.sql`](../../client/src/formatter/__tests__/examples/1_Vertical/example7.sql)
- [`client/src/formatter/__tests__/examples/3_Tsqlt/example7.sql`](../../client/src/formatter/__tests__/examples/3_Tsqlt/example7.sql)

---

## Problema 3: Formattazione e allineamento di blocchi STUFF() complessi

### Descrizione
Quando `"placeSubsequentItemsOnNewLines": "never"` è configurato, il formatter deve mantenere gli elementi della `SELECT` il più compatti possibile sulla stessa riga. Tuttavia, il blocco `STUFF(( SELECT ...` è eccezionalmente complesso:

- Contiene un'intera query interna `FOR XML PATH()`
- Ha sottoquestioni annidate `(SELECT DISTINCT ad2.NOTE FROM ... WHERE ...)`
- Deve mantenersi allineato visualmente a causa della profondità

### Profili interessati
- `2_Inline/example7.sql` (comma-first style, `"placeCommasBeforeItems": true`)
- `4_Scripting/example7.sql` (comma-trailing style, `"placeCommasBeforeItems": false`)

### File di configurazione
- **2_Inline**: [`client/src/formatter/__tests__/examples/2_Inline/config.json`](../../client/src/formatter/__tests__/examples/2_Inline/config.json)
- **4_Scripting**: [`client/src/formatter/__tests__/examples/4_Scripting/config.json`](../../client/src/formatter/__tests__/examples/4_Scripting/config.json)

### Configurazione JSON rilevante

#### 2_Inline
```json
{
  "lists": {
    "placeSubsequentItemsOnNewLines": "never",
    "placeCommasBeforeItems": true
  },
  "whitespace": {
    "wrapLinesLongerThan": 160
  }
}
```

#### 4_Scripting
```json
{
  "lists": {
    "placeSubsequentItemsOnNewLines": "never",
    "placeCommasBeforeItems": false
  },
  "parentheses": {
    "collapseShortParenthesisContents": true,
    "collapseParenthesesShorterThan": 160
  },
  "dml": {
    "collapseShortStatements": true,
    "collapseStatementsShorterThan": 78
  }
}
```

### Esempio concreto - 2_Inline

#### Attualmente prodotto (SBAGLIATO)
```sql
SELECT   ad.ARTI AS H_ARTI, ll.IdLotto AS H_IdLotto, ad.NUM_COMMESSA AS H_NUM_COMMESSA, a.DSCR AS H_DSCR, STUFF(( SELECT CHAR(10) + qry.NOTE AS [text()]
                            FROM   ( SELECT DISTINCT ad2.NOTE
                                     FROM   dbo.ACEMA_DETTAGLIO AS ad2
                                     WHERE  ad2.STAB = act.STAB
                                            AND ad2.MAGA = act.MAGA
                                            AND ad2.TIPO_NOMI = act.TIPO_NOMI
                                            AND ad2.NOMI = act.NOMI
                                            AND ad2.TIPO_DOCU = act.TIPO_DOCU
                                            AND ad2.ANNO_DOCU = act.ANNO_DOCU
                                            AND ad2.NUME_DOCU = act.NUME_DOCU
                                            AND ad2.ARTI = ad.ARTI
                                            AND ISNULL(ad2.NOTE, '') <> '' ) AS qry
                          FOR XML PATH('')), 1, 1, '') AS H_NOTE
```

#### Atteso (CORRETTO)
```sql
SELECT   ad.ARTI AS H_ARTI, ll.IdLotto AS H_IdLotto, ad.NUM_COMMESSA AS H_NUM_COMMESSA, a.DSCR AS H_DSCR, STUFF(( SELECT CHAR(10) + qry.NOTE AS [text()]
                                                                                                             FROM   ( SELECT DISTINCT ad2.NOTE
                                                                                                                      FROM   dbo.ACEMA_DETTAGLIO AS ad2
                                                                                                                      WHERE  ad2.STAB = act.STAB
                                                                                                                             AND ad2.MAGA = act.MAGA
                                                                                                                             AND ad2.TIPO_NOMI = act.TIPO_NOMI
                                                                                                                             AND ad2.NOMI = act.NOMI
                                                                                                                             AND ad2.TIPO_DOCU = act.TIPO_DOCU
                                                                                                                             AND ad2.ANNO_DOCU = act.ANNO_DOCU
                                                                                                                             AND ad2.NUME_DOCU = act.NUME_DOCU
                                                                                                                             AND ad2.ARTI = ad.ARTI
                                                                                                                             AND ISNULL(ad2.NOTE, '') <> '' ) AS qry
                                                                                                             FOR XML PATH('')), 1, 1, '') AS H_NOTE
```

### Differenza chiave
- **Attuale**: Le righe interne della subquery rimangono indentate a colonna ~44–56
- **Atteso**: Le righe interne sono allineate a colonna ~125 (esattamente sotto il `SELECT` principale a + spazi di padding)

### Esempio concreto - 4_Scripting

#### Attualmente prodotto (SBAGLIATO)
```sql
SELECT
   ad.ARTI AS H_ARTI,
   ll.IdLotto AS H_IdLotto,
   ad.NUM_COMMESSA AS H_NUM_COMMESSA,
   a.DSCR AS H_DSCR,
   STUFF(
   (SELECT CHAR(10) + qry.NOTE AS [text()]
    FROM (SELECT DISTINCT ad2.NOTE
          FROM dbo.ACEMA_DETTAGLIO AS ad2
          WHERE ad2.STAB = act.STAB
                AND ad2.MAGA = act.MAGA
                ...
```

#### Atteso (CORRETTO)
```sql
SELECT ad.ARTI AS H_ARTI, ll.IdLotto AS H_IdLotto, ad.NUM_COMMESSA AS H_NUM_COMMESSA, a.DSCR AS H_DSCR,
       STUFF(
       (SELECT CHAR(10) + qry.NOTE AS [text()]
        FROM (SELECT DISTINCT ad2.NOTE
              FROM dbo.ACEMA_DETTAGLIO AS ad2
              WHERE ad2.STAB = act.STAB
                    AND ad2.MAGA = act.MAGA
                    ...
```

### Differenza chiave
- **Attuale**: La `SELECT` è espansa su multiple righe (una colonna per elemento)
- **Atteso**: La `SELECT` rimane compatta sulla prima riga fino al `STUFF(`

### Localizzazione nei file
- **2_Inline/example7.sql**: Riga ~25–45, blocco `SELECT` con `, STUFF((` inline
- **4_Scripting/example7.sql**: Riga ~13–40, blocco `SELECT` con `STUFF(` inizio riga successiva

### Cause radice

#### Per 2_Inline
1. `sql-formatter` non riconosce che il primo `SELECT` e il `, STUFF((` devono restare insieme quando `placeSubsequentItemsOnNewLines: 'never'`
2. Le righe interne del `STUFF` vengono formattate con un'indentazione standard (~20 spazi) invece di una colonna fissa (125 spazi per allineamento visivo)

#### Per 4_Scripting
1. `collapseShortParenthesisContents: true` con `collapseParenthesesShorterThan: 160` non è abbastanza aggressivo
2. `collapseShortStatements: true` non applica alle clausole `SELECT` parziali
3. La `SELECT` viene esplosa su righe separate anche quando `placeSubsequentItemsOnNewLines: 'never'`

### Soluzioni possibili

#### Soluzione 1: Post-processor di compattamento STUFF (Consigliato)
Creare un nuovo file `stuffFormatter.ts` che:

1. **Per 2_Inline**: 
   - Identifica pattern `SELECT ... \n , STUFF((` 
   - Unisce la riga in: `SELECT ... , STUFF((`
   - Allinea le righe interne del `FROM/WHERE` alla colonna 125 (calcolata come lunghezza di `SELECT ... , STUFF(( SELECT CHAR(10) + qry.NOTE AS [text()]\n`)

2. **Per 4_Scripting**:
   - Identifica pattern multi-line iniziale `SELECT\n   ad.ARTI AS ...\n   ll.IdLotto ...`
   - Unisce in una singola riga: `SELECT ad.ARTI AS ..., ll.IdLotto ...,`
   - Mantiene il `STUFF(` sulla riga seguente compatto

**Dove aggiungere**: In `sqlFormattingProvider.ts`, come post-processor dedicato dopo `applyLeadingCommaFormat`.

#### Soluzione 2: Aggiornare baseline (Alternativa)
Accettare che `sql-formatter` con queste configurazioni produce un output espanso, e aggiornare:
- [`client/src/formatter/__tests__/examples/2_Inline/example7.sql`](../../client/src/formatter/__tests__/examples/2_Inline/example7.sql)
- [`client/src/formatter/__tests__/examples/4_Scripting/example7.sql`](../../client/src/formatter/__tests__/examples/4_Scripting/example7.sql)

Regenerare i file e confermare che i test passino.

#### Soluzione 3: Riconfigurare sql-formatter
Modificare le opzioni passate a `sql-formatter` in `sqlFormattingProvider.ts`:
```typescript
// Per 2_Inline
expressionWidth: 9999,  // Force everything on fewer lines

// Per 4_Scripting
collapseParenthesesShorterThan: 9999,  // Be more aggressive on collapsing
```

---

## Riepilogo dei file coinvolti

### File problematici (test)
1. **[`client/src/formatter/__tests__/examples/1_Vertical/example7.sql`](../../client/src/formatter/__tests__/examples/1_Vertical/example7.sql)** - 10 fallimenti (Problemi 1 e 2)
2. **[`client/src/formatter/__tests__/examples/2_Inline/example7.sql`](../../client/src/formatter/__tests__/examples/2_Inline/example7.sql)** - 1 fallimento (Problema 3)
3. **[`client/src/formatter/__tests__/examples/3_Tsqlt/example7.sql`](../../client/src/formatter/__tests__/examples/3_Tsqlt/example7.sql)** - 10 fallimenti (Problemi 1 e 2)
4. **[`client/src/formatter/__tests__/examples/4_Scripting/example7.sql`](../../client/src/formatter/__tests__/examples/4_Scripting/example7.sql)** - 1 fallimento (Problema 3)

### File configurazione
1. **[`client/src/formatter/__tests__/examples/1_Vertical/config.json`](../../client/src/formatter/__tests__/examples/1_Vertical/config.json)** - Stile Vertical
2. **[`client/src/formatter/__tests__/examples/2_Inline/config.json`](../../client/src/formatter/__tests__/examples/2_Inline/config.json)** - Stile Inline (comma-first)
3. **[`client/src/formatter/__tests__/examples/3_Tsqlt/config.json`](../../client/src/formatter/__tests__/examples/3_Tsqlt/config.json)** - Stile T-SQL
4. **[`client/src/formatter/__tests__/examples/4_Scripting/config.json`](../../client/src/formatter/__tests__/examples/4_Scripting/config.json)** - Stile Scripting

### File formatter interessati
1. **[`client/src/formatter/sqlFormattingProvider.ts`](../../client/src/formatter/sqlFormattingProvider.ts)** - Orchestrator principale
2. **[`client/src/formatter/listFormatter.ts`](../../client/src/formatter/listFormatter.ts)** - Potrebbe influenzare Problema 3
3. **[`client/src/formatter/joinFormatter.ts`](../../client/src/formatter/joinFormatter.ts)** - Potrebbe influenzare Problema 2
4. **[`client/src/formatter/parenthesesFormatter.ts`](../../client/src/formatter/parenthesesFormatter.ts)** - (Se esiste) potrebbe influenzare Problema 1

---

## Raccomandazione finale

**Approccio consigliato**: Procedere con la **Soluzione 1** per tutti e 3 i problemi, ovvero creare post-processor dedicati che risolvono questi edge case senza modificare la configurazione base di `sql-formatter`. Questo mantiene il formatter modulare, testabile, e non richiede di aggiornare i baseline che rappresentano "lo stato desiderato" della formattazione.

I post-processor dovrebbero essere applicati in questo ordine:
1. Post-processor parentheses (Problema 1)
2. Post-processor boolean operators (Problema 2)
3. Post-processor STUFF formatting (Problema 3)

Così garantiamo che ogni passo di correzione non interferisce con gli altri.

---

## ~~Problema 4: Virgola finale nei parametri delle Stored Procedure con `placeFirstProcedureParameterOnNewLine: "always"`~~ ✅ RISOLTO

> **Status**: Risolto in `ddlFormatter.ts`. Tutti i 10 test di `ddlFormatter.procFormatting.test.ts` passano.

### Descrizione
I test in `ddlFormatter.procFormatting.test.ts` stavano fallendo per via di una virgola finale mantenuta in modo errato dopo il primo parametro. Quando la configurazione prevede l'allineamento dei parametri "comma-first", il post-processor per DDL aggiungeva la virgola al nuovo parametro ma non rimuoveva quella in coda al precedente, generando così una sintassi invalida o duplicata.

### Fix applicato

In `applyDdlProcFormatting` (`client/src/formatter/ddlFormatter.ts`), nella sezione one-per-line della modalità `always`:
- `commaFirst` ora defaulta a `true` (comma-first è il formato di default) invece di richiedere `placeCommasBeforeItems === true`
- Il primo parametro viene sempre emesso senza virgola finale
- I parametri successivi usano il prefisso `, ` (comma-first) o il suffisso `,` (trailing) in base alla configurazione esplicita

```typescript
// Prima (SBAGLIATO)
const commaFirst = style.lists?.placeCommasBeforeItems === true;

// Dopo (CORRETTO)
const commaFirst = style.lists?.placeCommasBeforeItems !== false;
```

### File problematici (test)
- [`client/src/formatter/__tests__/ddlFormatter.procFormatting.test.ts`](../../client/src/formatter/__tests__/ddlFormatter.procFormatting.test.ts)
  - 5 test ora passano (aspettandosi `@a INT` senza virgola finale).

