SELECT *
FROM   EasyMexs_MAS.dbo.Ordini AS o
JOIN      EasyMexs_Master.dbo.Ordini AS o2 ON o.IdOrdine = o2.Codice