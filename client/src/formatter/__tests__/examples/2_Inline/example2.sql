SELECT *
FROM   SampleDb_A.dbo.TABLE_A AS a
       INNER JOIN SampleDb_B.dbo.TABLE_B AS b
           ON a.id = b.id_ref;