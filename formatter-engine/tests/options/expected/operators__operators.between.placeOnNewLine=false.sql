select l.TITOLO
from   bib.LIBRI as l
where  l.ATTIVO = 1
and    l.ANNO between 1990 and 2010
and    (l.COLLANA = 'Classici'
     or l.COLLANA is null)
and    l.ID_SEDE in (
    1, 2, 3, 4)
and    l.LINGUA in (
    'italiano',
    'inglese',
    'francese',
    'tedesco',
    'spagnolo',
    'portoghese',
    'olandese',
    'svedese',
    'norvegese',
    'danese')
and    l.PREZZO * 1.22 > 20;
