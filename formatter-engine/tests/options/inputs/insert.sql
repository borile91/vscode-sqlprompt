insert into bib.LIBRI (TITOLO, ANNO, ID_AUTORE, ATTIVO) values ('Il nome della rosa', 1980, 12, 1), ('Il pendolo di Foucault', 1988, 12, 1), ('La misteriosa fiamma della regina Loana', 2004, 12, 1);
insert into bib.STORICO (ID_LIBRO, DATA) select l.ID_LIBRO, getdate() from bib.LIBRI as l where l.ATTIVO = 0;
