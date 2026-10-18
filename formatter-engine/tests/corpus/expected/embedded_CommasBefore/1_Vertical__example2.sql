select *
from SampleDb_A.dbo.TABLE_A           as a
    inner join SampleDb_B.dbo.TABLE_B as b
        on a.id = b.id_ref;