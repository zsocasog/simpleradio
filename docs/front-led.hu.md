# Előlapi LED

A **Kijelző → Előlapi RGB LED** részen választható a LED típusa és bekötése.
A firmware és a webcsomag frissítése egyaránt szükséges az új beállításokhoz.

- **Nincs LED:** a kijelölt hagyományos RGB-lábak kikapcsolt szintet kapnak; nincs PWM-vezérlés vagy szalagpuffer-foglalás.
- **Hagyományos RGB LED:** egy háromcsatornás RGB fényforrás, külön piros,
  zöld és kék GPIO-val; közös katód vagy közös anód.
- **WS2812 / WS2812B RGB:** 1–64 címezhető RGB pixel, egy adatvezetéken.
  A gyűrű/szalag minden pixelén ugyanaz a beállított szín jelenik meg.
  Ez a mód nem SK6812 RGBW, APA102 vagy analóg RGB szalagvezérlő.

A **LED hardver mentése** gomb egyben menti a típust, darabszámot, GPIO-kat,
polaritást és színsorrendet. A **Mégse** visszaállítja a mentett értékeket.
Mentés után külön gombbal indítható újra a rádió. Addig a korábbi bekötés
marad aktív; a hardver szerkesztését egy közben végzett fényerőmentés sem
menti el vagy törli.

Csak a firmware profiljában szabad GPIO-k választhatók. A kijelző, hangkimenet,
IR és engedélyezett enkóderek pinjeit, a memória, USB és bootstrappolás
pinjeit a lista kizárja. PWM esetén a három színhez külön GPIO kell.
A GPIO48 a jelenlegi profilban az alaplap saját WS2812 LED-je is lehet;
ezt a konkrét panel bekötésén ellenőrizni kell.

A LED használata, témaszín vagy egyedi szín, normál és készenléti fényerő
újraindítás nélkül változtatható. A fényerőcsúszkák egér/érintés felengedésekor,
billentyűzetnél Enterre vagy a mező elhagyásakor mentenek. Kikapcsolt
kijelzőnél a LED is kialszik. VU, hangerő- és boot-animáció ebben a körben
nem került a LED-re.

A GPIO vezérlőjelet ad: a tápellátást a konkrét LED/modul adatlapja szerint
kell kialakítani, szükség szerinti meghajtóval, ellenállással és
jelszintillesztéssel. Az ESP és a LED-táp földje közös legyen.

A szalag hardveres RMT-adóval, aszinkron módon működik. A kód nem vár a
küldés végére, a még használt puffert nem írja felül, és csak színváltozáskor
küld új képet. A puffer egyszer, induláskor készül el; 64 RGB pixelnél
6148 bájt belső RAM, a meghajtó saját foglalásán felül. Külön LED-feladat
és új hangelemzés nem indul. Inicializálási vagy küldési hiba csak a LED-et
tiltja le, a rádió működését nem.

A régi, hardverprofilból választott LED-típus és bekötés alapértelmezésként
megmarad, ha a mentett konfiguráció még nem tartalmaz LED-hardvermezőket.
Ha egy profilváltás miatt a mentett LED-bekötés érvénytelen lesz, a LED
kikapcsolva indul, a többi beállítás megmarad.

A vezérlési logika, színkódolás, puffer-élettartam és webes folyamat
automatikusan ellenőrizhető. A tényleges bekötés, áramfelvétel, megjelenő
színek és a 64 pixeles összeállítás fizikai próbát igényelnek.
