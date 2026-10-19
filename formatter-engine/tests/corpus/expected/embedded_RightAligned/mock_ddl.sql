CREATE TABLE [bib].[PRESTITI] ([ID_PRESTITO] INT IDENTITY(1, 1) NOT NULL,
                               [ID_SOCIO] INT NOT NULL,
                               [ID_LIBRO] INT NOT NULL,
                               [DATA_PRESTITO] DATETIME
                                   CONSTRAINT [DF_PRESTITI_DATA]
                                       DEFAULT (GETDATE()) NOT NULL,
                               [STATO] CHAR(1) NULL,
                               [NOTE] NVARCHAR(255) NULL,
                               CONSTRAINT [PK_PRESTITI]
                                   PRIMARY KEY CLUSTERED ([ID_PRESTITO] ASC)
                                   WITH(FILLFACTOR = 80),
                               CONSTRAINT [FK_PRESTITI_SOCI]
                                   FOREIGN KEY ([ID_SOCIO])
                                   REFERENCES [bib].[SOCI] ([ID_SOCIO]));
GO
;
GO
CREATE NONCLUSTERED INDEX [IX_PRESTITI_SOCIO]
ON [bib].[PRESTITI] ([ID_SOCIO] ASC, [STATO] ASC)
INCLUDE ([ID_LIBRO])
WHERE ([STATO] IS NULL)
WITH (FILLFACTOR = 90);
GO
CREATE UNIQUE NONCLUSTERED INDEX [IX_PRESTITI_LIBRO]
ON [bib].[PRESTITI] ([ID_LIBRO] ASC);
GO
ALTER INDEX [IX_PRESTITI_SOCIO] ON [bib].[PRESTITI] DISABLE;
GO
ALTER TABLE [bib].[PRESTITI]
ADD CONSTRAINT [DF_PRESTITI_STATO]
    DEFAULT ('I') FOR [STATO];
GO
ALTER TABLE [bib].[PRESTITI] WITH CHECK
ADD CONSTRAINT [FK_PRESTITI_LIBRI]
    FOREIGN KEY ([ID_LIBRO])
    REFERENCES [bib].[LIBRI] ([ID_LIBRO]);
GO
EXECUTE sp_addextendedproperty @name = N'MS_Description',
                               @value = N'Prestiti dei libri',
                               @level0type = N'SCHEMA',
                               @level0name = N'bib',
                               @level1type = N'TABLE',
                               @level1name = N'PRESTITI';
GO

/*
   Trigger di esempio per lo storico
*/
CREATE TRIGGER bib.PRESTITI_Storico
ON bib.PRESTITI
AFTER INSERT, DELETE
AS
BEGIN
    SET NOCOUNT ON;
    INSERT INTO bib.PRESTITI_AUDIT (ID_PRESTITO,
                                    OPERAZIONE,
                                    DATA)
    SELECT i.ID_PRESTITO,
           'I',
           GETDATE()
      FROM Inserted AS i;
END;
GO
CREATE VIEW bib.vwPrestitiAperti
AS
SELECT      p.ID_PRESTITO,
            p.ID_SOCIO,
            s.COGNOME
  FROM      bib.PRESTITI AS p
 INNER JOIN bib.SOCI AS s
    ON s.ID_SOCIO = p.ID_SOCIO
 WHERE      p.STATO IS NULL;
GO
CREATE FUNCTION bib.fnPrestitiSocio (@idSocio INT,
                                     @soloAperti BIT = 1)
RETURNS TABLE
AS
RETURN (
           -- elenco dei prestiti del socio
           SELECT p.ID_PRESTITO,
                  p.ID_LIBRO
             FROM bib.PRESTITI AS p
            WHERE p.ID_SOCIO      = @idSocio
              AND (   @soloAperti = 0
                 OR   p.STATO IS NULL));
GO
CREATE FUNCTION bib.fnRiepilogoSocio (@idSocio INT)
RETURNS @riepilogo TABLE (ID_LIBRO INT,
                          TITOLO NVARCHAR(255),
                          GIORNI INT)
AS
BEGIN
    DECLARE @t TABLE (ID INT,
                      CONTA BIGINT);
    INSERT @riepilogo (ID_LIBRO,
                       TITOLO,
                       GIORNI)
    SELECT      l.ID_LIBRO,
                l.TITOLO,
                DATEDIFF(DAY, p.DATA_PRESTITO, GETDATE())
      FROM      bib.PRESTITI AS p
     INNER JOIN bib.LIBRI AS l
        ON l.ID_LIBRO = p.ID_LIBRO
     WHERE      p.ID_SOCIO = @idSocio;
    RETURN;
END;
GO
