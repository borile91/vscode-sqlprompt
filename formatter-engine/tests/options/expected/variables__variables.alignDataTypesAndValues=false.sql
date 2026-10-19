declare @sede varchar(3) = 'MI1',
        @dataRif datetime,
        @soglia numeric(12, 3) = 10.5,
        @attivo bit = 1;
set @dataRif = isnull(@dataRif, getdate());
declare @descrizioneCompleta nvarchar(400) =
    concat(@sede, ' - ', convert(varchar(10), @dataRif, 103), ' - soglia ', @soglia, ' - attivi ', @attivo, ' - fine');
