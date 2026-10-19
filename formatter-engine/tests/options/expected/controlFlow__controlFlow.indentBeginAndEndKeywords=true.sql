if @conta > 0
    begin
        set @messaggio = 'presenti';
        print @messaggio;
    end
else
    set @messaggio = 'nessuno';
while @i < 10
    begin
        set @i = @i + 1;
    end;
begin try
    exec bib.spPulizia;
end try
begin catch
    print error_message();
end catch;
