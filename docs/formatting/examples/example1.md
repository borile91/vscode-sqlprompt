# Config
{
  "metadata": {
    "id": "a4c295cf-2b25-42e2-804d-582233ce777f",
    "name": "1 - MadLab Vertical",
    "lastModified": "2020-12-17T13:10:16.476793Z"
  },
  "whitespace": {
    "wrapLinesLongerThan": 200,
    "newLines": {
      "preserveExistingEmptyLinesBetweenStatements": false,
      "preserveExistingEmptyLinesAfterBatchSeparator": false
    }
  },
  "lists": {
    "alignComments": true,
    "placeCommasBeforeItems": true,
    "addSpaceBeforeComma": true
  },
  "parentheses": {
    "collapseParenthesesShorterThan": 78,
    "addSpacesInsideParentheses": true
  },
  "casing": {
    "reservedKeywords": "uppercase",
    "builtInFunctions": "uppercase",
    "builtInDataTypes": "uppercase",
    "useObjectDefinitionCase": true
  },
  "dml": {
    "collapseStatementsShorterThan": 75,
    "collapseSubqueriesShorterThan": 15
  },
  "ddl": {
    "parenthesisStyle": "expandedIndented",
    "indentClauses": true,
    "placeFirstProcedureParameterOnNewLine": "always",
    "collapseStatementsShorterThan": 75
  },
  "controlFlow": {
    "indentBeginAndEndKeywords": true,
    "collapseStatementsShorterThan": 78
  },
  "cte": {
    "asAlignment": "indented"
  },
  "variables": {
    "placeAssignedValueOnNewLineIfLongerThanMaxLineLength": false
  },
  "joinStatements": {
    "join": {
      "keywordAlignment": "toTable",
      "indentJoinTable": false
    },
    "on": {
      "keywordAlignment": "indented",
      "conditionAlignment": "toInner"
    }
  },
  "insertStatements": {
    "columns": {
      "parenthesisStyle": "compactSimple",
      "indentContents": false
    },
    "values": {
      "parenthesisStyle": "compactSimple"
    }
  },
  "functionCalls": {
    "placeArgumentsOnNewLines": "never"
  },
  "caseExpressions": {
    "placeExpressionOnNewLine": false,
    "placeFirstWhenOnNewLine": "ifInputExpression",
    "whenAlignment": "toFirstItem",
    "collapseCaseExpressionsShorterThan": 75
  },
  "operators": {
    "andOr": {
      "alignment": "toFirstListItem"
    },
    "between": {
      "placeOnNewLine": false
    },
    "in": {
      "placeFirstValueOnNewLine": "never",
      "placeSubsequentValuesOnNewLines": "never",
      "addSpaceAroundInContents": true
    }
  }
}

# Result
ALTER PROCEDURE rf.spLoadItem
    (
    @stab VARCHAR(3)
  , @maga VARCHAR(3)
  , @area VARCHAR(3)
  , @cors VARCHAR(3)
  , @posi VARCHAR(3)
  , @cell VARCHAR(3)
  , @arti VARCHAR(40)
  , @prog VARCHAR(25)
  , @idLotto INT
  , @qta NUMERIC(12, 3)
  , @udc VARCHAR(50) = 'XXXXX'
  , @scriviMovimento BIT -- FLAG DI SCRITTURA DEL MOVIMENTO
  , @dtIniz DATETIME
  , @dtFine DATETIME
  , @caus VARCHAR(5)
  , @uten VARCHAR(10)
  , @term AS NUMERIC(3, 0)
  , @peso AS NUMERIC(12, 3) = 0
  , @infoDocumento AS VARCHAR(255) = ''
  , @seriale AS NVARCHAR(100) = ''
  , @loadType VARCHAR(5) = 'STD'
  , @pallet VARCHAR(25) = NULL
  , @udcPallet VARCHAR(50) = NULL
  , @causaleBlocco VARCHAR(10) = NULL
  , @magaHost VARCHAR(50) = NULL
  , @Errore VARCHAR(255) OUTPUT
    )
AS
    SET ANSI_NULLS ON;

    SET QUOTED_IDENTIFIER ON;

    SET NOCOUNT ON;

    SET XACT_ABORT OFF;

    DECLARE @msg VARCHAR(2048);
    DECLARE @transazioneEsterna    BIT = 0
          , @perditaLotto          BIT
          , @unioneLotto           BIT
          , @causaleBloccoPartenza VARCHAR(5)
          , @atmAuto               VARCHAR(10)
          , @atmUdm                INT
          , @atmX1                 INT
          , @atmY1                 INT;

    SET @Errore = '';
    SET @peso = ISNULL(@peso, 0);

    BEGIN TRY

        -- Se c'è una transazione esterna non fa il commit
        -- e tiene traccia che ho una transazione esterna in corso.
        IF @@TRANCOUNT > 0
            SET @transazioneEsterna = 1;
        ELSE
            BEGIN
                SET @transazioneEsterna = 0;

                BEGIN TRANSACTION;
            END;

        -- Gestione del lotto in fase di carico (perdita o unione al lotto in cella destinazione)
        IF @loadType NOT IN ( 'INV', 'ACE' )
            BEGIN
                SELECT   TOP ( 1 ) @perditaLotto = PERDITA_LOTTO
                                 , @unioneLotto = UNIONE_LOTTO
                FROM     rf.fnLoadGetFlagCambioLottoArticoli(@stab, @maga, @prog, @arti, @idLotto, @stab, @maga, @area, @cors, @posi, @cell)
                ORDER BY IdLotto;

                IF ISNULL(@perditaLotto, 0) = 1
                    BEGIN
                        SELECT @idLotto = dbo.fnGetLottoPredefinito();
                    END;
                ELSE IF ISNULL(@unioneLotto, 0) = 1
                    BEGIN
                        DECLARE @idLottoSaldoEsistente INT;

                        -- Se devo unire il lotto, mi prendo un lotto non speciale in destinazione.
                        SELECT   TOP ( 1 ) @idLottoSaldoEsistente = sd.IdLotto
                        FROM     dbo.SALDI_DETTAGLIO AS sd
                        WHERE    sd.STAB = @stab
                                 AND sd.MAGA = @maga
                                 AND sd.PROG = @prog
                                 AND sd.ARTI = @arti
                                 -- escludo sempre i lotti speciali
                                 AND NOT EXISTS ( SELECT 1
                                                  FROM   internal.vwLottiSpeciali AS vls
                                                  WHERE  vls.IdLotto = sd.IdLotto )
                        ORDER BY sd.IdLotto;

                        -- Se non c'è, mantengo quello che ho
                        SET @idLotto = COALESCE(@idLottoSaldoEsistente, @idLotto);
                    END;
            END;

        IF NULLIF(@pallet, '') IS NOT NULL
           AND NULLIF(@udcPallet, '') IS NULL
            BEGIN
                --fallback in caso di mancato passaggio del tipo udc
                SELECT @udcPallet = @udc;
            END;

        EXEC rf.spLoadItem_Check @stab = @stab
                               , @maga = @maga
                               , @area = @area
                               , @cors = @cors
                               , @posi = @posi
                               , @cell = @cell
                               , @arti = @arti
                               , @prog = @prog
                               , @idLotto = @idLotto
                               , @qta = @qta
                               , @udc = @udc
                               , @scriviMovimento = @scriviMovimento
                               , @dtIniz = @dtIniz
                               , @dtFine = @dtFine
                               , @caus = @caus
                               , @uten = @uten
                               , @term = @term
                               , @peso = @peso
                               , @infoDocumento = @infoDocumento
                               , @seriale = @seriale
                               , @loadType = @loadType
                               , @pallet = @pallet
                               , @udcPallet = @udcPallet
                               , @causaleBlocco = @causaleBlocco
                               , @magaHost = @magaHost
                               , @Errore = @Errore OUTPUT;

        IF ISNULL(@Errore, '') <> ''
            BEGIN
                RAISERROR(@Errore, 16, 1);
            END;

        -- Se non l'hanno passato dall'esterno, recupero il MAGA_HOST dalla cella
        -- Lo recupero DOPO la spLoadItem_Check, in questo modo evito che dia errore se la cella è configurata male e ha un default sul magazzino host che non esiste
        -- Il controllo di esistenza deve essere fatto solo se lo passano dall'esterno
        IF ISNULL(@magaHost, '') = ''
            BEGIN
                SELECT @magaHost = vcmh.MAGA_HOST
                FROM   dbo.vwCelleMagazzinoHost AS vcmh
                WHERE  vcmh.STAB = @stab
                       AND vcmh.MAGA = @maga
                       AND vcmh.AREA = @area
                       AND vcmh.CORS = @cors
                       AND vcmh.POSI = @posi
                       AND vcmh.CELL = @cell;
            END;

        -- Inizio
        IF @loadType <> 'INV'
            BEGIN
                UPDATE dbo.ARTICOLI
                SET    QTA_CONF = @qta
                     , FLG_INV_HOST = 1
                WHERE  ARTI = @arti
                       AND ISNULL(QTA_CONF, 0) = 0;

                IF @peso > 0
                    BEGIN
                        UPDATE dbo.ARTICOLI
                        SET    PESO = @peso
                             , FLG_INV_HOST = 1
                        WHERE  ARTI = @arti
                               AND ISNULL(PESO, 0) <> @peso;
                    END;
            END;

        IF NULLIF(@pallet, '') IS NOT NULL
            BEGIN
                EXEC ui.SaldoTestataAggiorna @Stab = @stab
                                           , @Maga = @maga
                                           , @Prog = @pallet
                                           , @Area = @area
                                           , @Cors = @cors
                                           , @Posi = @posi
                                           , @Cell = @cell
                                           , @Udc = @udcPallet
                                           , @Segno = '+'
                                           , @Utente = @uten
                                           , @Pallet = NULL
                                           , @StrErrore = @Errore OUTPUT;

                IF ISNULL(@Errore, '') <> ''
                    BEGIN
                        RAISERROR(@Errore, 16, 1);
                    END;
            END;

        EXEC ui.SaldoTestataAggiorna @Stab = @stab
                                   , @Maga = @maga
                                   , @Prog = @prog
                                   , @Area = @area
                                   , @Cors = @cors
                                   , @Posi = @posi
                                   , @Cell = @cell
                                   , @Udc = @udc
                                   , @Segno = '+'
                                   , @Utente = @uten
                                   , @Pallet = @pallet
                                   , @StrErrore = @Errore OUTPUT;

        IF ISNULL(@Errore, '') <> ''
            BEGIN
                RAISERROR(@Errore, 16, 1);
            END;

        EXEC ui.SaldoDettaglioAggiorna @Stab = @stab
                                     , @Maga = @maga
                                     , @Prog = @prog
                                     , @Arti = @arti
                                     , @idLotto = @idLotto
                                     , @QtPezzi = @qta
                                     , @Segno = '+'
                                     , @Utente = @uten
                                     , @CausaleBlocco = @causaleBlocco
                                     , @StrErrore = @Errore OUTPUT;

        IF ISNULL(@Errore, '') <> ''
            BEGIN
                RAISERROR(@Errore, 16, 1);
            END;

        IF @scriviMovimento = 1
            BEGIN
                SELECT @atmAuto = st.ATM_AUTO
                     , @atmUdm = st.ATM_UDM
                     , @atmX1 = o.X1
                     , @atmY1 = o.Y1
                FROM   dbo.SALDI_TESTATA AS st
                       LEFT JOIN atm.OCCUPAZIONI AS o
                           ON o.AUTO = st.ATM_AUTO
                              AND o.UDM = st.ATM_UDM
                              AND o.UDC = st.ATM_UDC
                WHERE  st.STAB = @stab
                       AND st.MAGA = @maga
                       AND st.PROG = @prog;

                SELECT @causaleBloccoPartenza = dbo.fnGetCausaleBloccoSaldo(@stab, @maga, @prog, @arti, @idLotto, 0);

                SET @causaleBlocco = COALESCE(@causaleBlocco, @causaleBloccoPartenza);

                EXEC ui.MovimentoScrivi @Stab = @stab
                                      , @Maga = @maga
                                      , @Area = @area
                                      , @Cors = @cors
                                      , @Posi = @posi
                                      , @Cell = @cell
                                      , @Arti = @arti
                                      , @Prog = @prog
                                      , @IdLotto = @idLotto
                                      , @Udc = @udc
                                      , @StabTrf = NULL
                                      , @MagaTrf = NULL
                                      , @ProgTrf = NULL
                                      , @AreaTrf = NULL
                                      , @CorsTrf = NULL
                                      , @PosiTrf = NULL
                                      , @CellTrf = NULL
                                      , @IdLottoTrf = NULL
                                      , @Utente = @uten
                                      , @Causale = @caus
                                      , @CausaleTrf = ''
                                      , @CausaleBlocco = @causaleBlocco
                                      , @CausaleBloccoTrf = NULL
                                      , @MagaHost = @magaHost
                                      , @MagaHostTrf = NULL
                                      , @Segno = '+'
                                      , @QtaMovimento = @qta
                                      , @DtInizio = @dtIniz
                                      , @DtFine = @dtFine
                                      , @Term = @term
                                      , @infoDocu = @infoDocumento
                                      , @Seriale = @seriale
                                      , @Pallet = @pallet
                                      , @PalletTrf = NULL
                                      , @AtmAuto = @atmAuto
                                      , @AtmUdm = @atmUdm
                                      , @AtmX1 = @atmX1
                                      , @AtmY1 = @atmY1
                                      , @errore = @Errore OUTPUT;

                IF ISNULL(@Errore, '') <> ''
                    BEGIN
                        RAISERROR(@Errore, 16, 1);
                    END;
            END;

        IF @loadType NOT IN ( 'INV', 'ACE' )
           AND ISNULL(@seriale, '') <> ''
            BEGIN
                EXEC dbo.spMatricolaSetEntrata @arti = @arti
                                             , @matr = @seriale
                                             , @idLottoEntrata = @idLotto
                                             , @uten = @uten
                                             , @dtEntrata = NULL
                                             , @errore = @Errore OUTPUT;

                IF ISNULL(@Errore, '') <> ''
                    BEGIN
                        RAISERROR(@Errore, 16, 1);
                    END;
            END;

        EXEC rf.spCheckSaldiCelleTipoUdc @stab = @stab
                                       , @maga = @maga
                                       , @prog = @prog
                                       , @errore = @Errore OUTPUT;

        IF ISNULL(@Errore, '') <> ''
            BEGIN
                RAISERROR(@Errore, 16, 1);
            END;

        IF ( @transazioneEsterna = 0 )
            COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF ISNULL(@Errore, '') = ''
            BEGIN
                SET @Errore = IIF(ERROR_NUMBER() <> 50000, CONVERT(VARCHAR(10), ERROR_NUMBER()) + ': ', '') + ERROR_MESSAGE() + ' Proc: ' + ISNULL(ERROR_PROCEDURE(), '') + ' L: '
                              + CONVERT(VARCHAR(10), ERROR_LINE());
            END;

        -- Se c'è una transazione
        -- ed è creata qui dentro allora
        -- eseguo il rollback.
        IF @transazioneEsterna = 0
           AND @@TRANCOUNT > 0
            BEGIN
                ROLLBACK TRANSACTION;
            END;

        RAISERROR(@Errore, 16, 1);

        RETURN -1;
    END CATCH;

    RETURN 0;
GO