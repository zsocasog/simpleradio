# LCD-logók és lejátszás közbeni mentés

## Mit mérünk?

A `5942c05` GitHub-mentés megőrzi a korábbi, böngészős képterhet csökkentő változtatásokat. Az új kör az új állomások/logók mentése mellett megmaradt digitális hangutánpótlási késést vizsgálja. A verzió 1.2.09; a könyvtárverziókat és az audio-pufferek méretét nem változtatjuk.

Az összehasonlítások ugyanazt a helyi, 44,1 kHz-es sztereó FLAC-ot tartalmazó Ogg-mintát használják. A készülék némítva fut. A normál spektrum hangerőnullán kikapcsol, ezért a mérés nem bizonyítja a hallható hangerővel, élő spektrummal vagy fizikai encoderrel végzett használat teljes stabilitását. Az öt másodperces váltási türelmi idő nem az első hangminta indulási idejének mérése.

## Megtartott megoldás

Lejátszás közben az újonnan előkészített LCD-logók egy korlátos PSRAM-tárba kerülhetnek, a nagy, nyers LCD-másolat flashre írása helyett. Az eredeti feltöltött PNG továbbra is tartósan elmentődik. A távoli képek eredeti gyorsítótári fájlját a RAM-változat elkészültekor nem tömörítjük el/töröljük: újraindulás vagy RAM-evikció után abból újra elkészülhet az LCD-kép. A távoli forrásokra továbbra is érvényes a normál lemezes gyorsítótár tárhelykerete.

- Legfeljebb nyolc tárolt kép, a még olvasott, már lecserélt változatokat is beleszámítva. A helyek fokozatosan telnek; nincs induláskori nyolcképes foglalás.
- Egy 176×176 képkocka az SR56 fejléccel és saját metaadataival 62 072 B PSRAM. Nyolc ilyen kép 496 576 B; előkészítéskor legfeljebb egy új, még nem publikált példány is létrejöhet. A dekóder meglévő ideiglenes sprite-ja külön munkapuffer.
- A kép-adatokhoz kizárólag PSRAM-foglalás használható, belső RAM-tartalékfoglalás nincs. A foglalás legalább további 512 KiB PSRAM-ot szabadon hagy. Helyhiány vagy minden helyet lekötő olvasók mellett a korábbi lemezes útvonal marad a tartalék.
- RAM-ban csak akkor tarthatjuk a nyers LCD-másolatot, ha megvan a böngészőnek külön is kiszolgálható, legfeljebb 32 KiB-os PNG/JPEG eredeti. Nagyobb vagy más formátumú forrásnál a lemezes LCD/BMP-másolat megmarad, így egy RAM-evikció nem tünteti el az egyetlen webes képet.
- A ritkábban használt, éppen nem olvasott képek helyét újabbak vehetik át. Az olvasó változatlan képet kap a befejezésig; nincs felszabadított képre mutató hivatkozás vagy korlátlanul kint maradó régi képpéldány.
- Az LCD, a csatornaválasztó kis képeinek háttérbetöltője és a régi BMP-végpont közös, olvasásra szolgáló RAM/fájl felületet használ. A böngésző elsődleges PNG/JPEG-kiszolgálása és az albumborítók saját képtára megmarad.
- A RAM-kép cseréje külön generációt kap az LCD újrarajzolásához és a kis logók frissítéséhez. A webes képellenőrző azonosítók a publikálási védelemmel együtt változnak.
- Új háttérfeladat nincs. A webes feladat prioritása és magbeállítása az eredeti marad.

## Elvetett kísérletek

Az eredeti, hat képes, egymásra engedett távoli előkészítést/feltöltést végző kontrollban 23 hangutánpótlási figyelmeztetés és 2841,3 ms összegzett konzervatív hiánybecslés volt. A 512 bájtos flash-írási adag önmagában nem hozott elég biztos javulást, és egy feltöltés 7546 ms-ig tartott. Ezt visszavontuk.

A webes feladat prioritásának 10-ről 1-re csökkentése webes időtúllépéseket okozott, a sorozat megszakadt. A kizárólag 1-es processzormagra kötésnél a hanghiánybecslés 4382,5 ms lett. Egyik ütemezési kísérlet sincs a megtartott kódban.

Új képmunka nélküli gyors csatornaváltáskor az eredeti változat háromszor hat váltással, 386 HTTP-kéréssel, 67 stabil hangmintával és nulla észlelt hibával végigment. Ez az új képek előkészítésével együtt fellépő terhelésre szűkítette a vizsgálatot; nem minden csatornaváltási körülményre érvényes garancia.

## Első készülékes összevetés

Az egy teljes képkéréssel és a böngésző `prepareLogo=0` → PNG-feltöltés → hozzárendelés sorrendjével végzett hatlogós próbában:

| Mutató | Előtte | RAM-tárral |
|---|---:|---:|
| Hangutánpótlási figyelmeztetés | 13 | 1 |
| Konzervatív hanghiánybecslés | 376,3 ms | 0 ms |
| Hat PNG-feltöltés ideje | 1219–3671 ms | 1016–1671 ms |
| Rendszerállapot-kérés mediánja | 47 ms | 47 ms |
| HTTP-hiba / újraindulás | 0 / 0 | 0 / 0 |

A RAM-tárban egyszerre legfeljebb **egy kép**, 62 072 B volt; hat képet publikáltunk egymás után. A nyolcas érték kapacitáskorlát, nem szükséges egyidejű képszám. Mindkét futás visszaállította az eredeti állomáslistát, konfigurációt és lejátszóállapotot. A RAM-változat mérési azonosítója `d559b5ce8`.

A pozitív, konzervatív hiánybecslés és a nyers határidő-figyelmeztetés külön mérőszám. A nulla becsült hiány mellett megmaradt egy figyelmeztetés, ezért ez sem teljes akadásmentességi állítás. A futások közt a gyorsítótár és a flash elrendezése változhatott; az eredményekhez ismétlés és erősebb terhelés is szükséges.

## Erősebb terhelés és képélettartam

A hat párhuzamos képkéréssel, távoli logó-előkészítéssel és PNG-feltöltéssel együtt futó kontrollban az eredeti változat 334, a RAM-változat 330 HTTP-kérést végzett. Mindkét körben nulla HTTP-hiba és nulla újraindulás volt. A konzervatív hiánybecslés **2841,3 ms → 0 ms**, a nyers hangutánpótlási figyelmeztetések száma **23 → 13** lett. A RAM-képek száma legfeljebb öt, foglalásuk 310 360 B volt. Az állapotlekérdezés mediánja mindkét futásban 47 ms.

Az erős körben a PNG-feltöltések leglassabb válasza **3469 ms → 5000 ms** lett. Ez nem általános webes gyorsulás: a hang becsült hiánya csökkent, de szélsőséges mentési torlódás továbbra is előfordulhat. A mintavételezett belső szabad RAM minimuma 7568 B-ról 11 680 B-ra nőtt; eltérő pillanatban vett mintákból nem következik pontos állandó memóriamegtakarítás.

Lejátszás közbeni azonos fájlnév-cserénél a két különböző PNG bájtra pontosan visszaolvasható volt. A két 62 018 B-os BMP eltérő pixel-lenyomatot és ETag-et kapott; mindkét változat feltételes újrakérése üres 304-et adott. A mérési statisztika igazolta a RAM-publikálást is.

Egy külön készülékes próbában kilenc saját, eltérő színű logót mentettünk és játszottunk egymás után. A tár nyolc helyen, 496 576 B-nál tetőzött. Az első, már kiszorított logóra visszaváltás új RAM-publikálást indított, és az újraépült LCD-kép lenyomata megegyezett az eredetivel. Az eredeti PNG-k külön is ellenőrizve lettek. A próba az összes saját állomást eltávolította és visszaállította a kiinduló állapotot.

## Teljes vegyes használat

A `d559b5ce8` mérési változat 330,6 másodperces teljes köre 1322 HTTP-kéréssel és 245 stabil hangmintával végigment. Élő FLAC, hat párhuzamos kép, beállításmentések, új állomás és logó, gyors váltások, helyi WAV, MP3/online kereső és leállítás/újraindítás is szerepelt benne. Nem volt HTTP-hiba vagy váratlan újraindulás; a kiinduló állapot visszaállt.

A konzervatív hanghiánybecslés minden szakaszban nulla lett. Három nyers időzítési figyelmeztetés maradt, mind az új állomás/logó szakaszban. A rendszerállapot-kérés mediánja 47 ms, a mintavételezett belső szabad RAM minimuma 16 904 B, a legnagyobb szabad blokk minimuma 6132 B volt. Ez előrelépés a korábbi, új logó/gyors váltás szakaszban pozitív hiánybecslést adó vegyes körhöz képest, de a rádióadások és a fájlrendszer állapota nem volt bitre azonos. A helyi hangmintás kontroll az erősebb összehasonlítás.

A végső kódban a RAM/disk döntés közvetlenül a dekódolás után a lejátszás friss állapotát is ellenőrzi: egy állva elkezdett képmunka közben is elindulhat a zene. A közös lemezes tartalék és az előkészítési memóriakapu megmarad.

## Megszakított, állva indult logó-előkészítés

A külön indulásközi próbában egy érvényes 1024×1024-es PNG előkészítése alatt indítottuk el a zenét. Az LCD-kép sem a régi `f7e2ab753`, sem a RAM-táras `c7e044bf5` változatban nem készült el a 25 másodperces megfigyelési határidőn belül. A készülék végig elérhető maradt, a tesztek visszaállították a kiinduló állapotot. Ugyanez a nagy PNG már futó lejátszás mellett a RAM-változatban rendben elkészült, tehát nem általános képméret-hibát mértünk.

A megszakított thumbnail-feladat visszakerült a sorba, de megmaradt a `lastThumbnailAttemptSource` / `lastThumbnailAttemptMs` jelölése is. A következő előkészítési kérés emiatt a normál, **60 másodperces** újrapróbálási tilalom alá eshetett. A várakozási sort kezelő kód a kérést addigra már kivette a sorból. A végső javítás kizárólag megszakított `Thumbnail` munkánál, azonos forrás és fill-változat esetén törli ezt a jelölést, majd a meglévő sorba teszi vissza a munkát. A hibás képek és más források normál várakozása megmarad. Ezt a megszakítási ágat külön regressziós ellenőrzés is futtatja.

A célzott készülékes ismétlés a javított `928cb0418` változattal sikeres volt. A lejátszást egy 1031 ms óta aktív thumbnail-munka alatt indítottuk; a nagy PNG LCD-képe a 25 másodperces határidőn belül, az első diagnosztikai leolvasásig (9,7 s futási idő) RAM-ban elkészült. A normál PNG-kiszolgálás eredeti bájtjai is egyeztek, a próba végén a kiinduló állapot visszaállt.

Ezzel a megszakítási javítással a teljes vegyes kört is megismételtük: **1343 HTTP-kérés, 253 stabil hangminta, nulla HTTP-hiba, nulla újraindulás és nulla összegzett konzervatív hanghiánybecslés**. Három nyers hangutánpótlási figyelmeztetés itt is maradt. Az állapotvégpont mediánja 46 ms; a mintavételezett belső szabad RAM minimuma 11 916 B, a legnagyobb blokk minimuma 3316 B. A helyreállítás sikeres volt. Az utólagos, nagy eredeti képekre vonatkozó webes tartalékvédelem külön célzott normál-firmware próbát kap.

## Normál kiadás ellenőrzése és megmaradt korlátok

A normál, részletes futásidejű mérés nélküli változat azonosítója **`5a9615d07`**. A firmware és LittleFS build sikeres; a webes adatcsomag tartalma változatlan, új data OTA nem kellett. A normál build teljes statikus RAM-igénye 104 548 B, a korábbi kontrollé 104 412 B: a különbség **136 B belső statikus RAM**. Ez nem a futás közbeni összes memóriahasználat különbsége; a képkockák külön, szükség szerint foglalódnak PSRAM-ban.

A készüléken ellenőrizve az eredeti hat állomás, a teljes konfiguráció, mindkét eredeti feltöltött logó és a kibontott webes fájlok megmaradtak. A normál firmware nem szolgálja ki a `/api/diagnostics` útvonalat.

A célzott, lejátszás közbeni normál próba ugyanazon feltöltési fájlnéven ellenőrzött két eltérő méretű eredetit:

| Eredeti PNG | Webes kép | Nyers LCD-fájl a flashen | Eredeti megmaradt / feltételes 304 |
|---|---|---|---|
| 427 B | változatlan PNG, 427 B | nincs; a BMP-t a RAM-kép adta | igen / igen |
| 67 738 B | tartalék BMP, 62 018 B | van, érvényes SR56, 61 960 B | igen / igen |

Az első sor a normál firmware-ben is bizonyítja a RAM-kiszolgálást. A második a nagy eredeti képek tartós webes tartalékát és a korábbi, lemezes útvonal megőrzését ellenőrzi. A képek bájtjai és a képellenőrző azonosítók is ellenőrizve lettek; a végén a kiinduló állapot visszaállt.

**Megmaradt lassú eset:** a 67 738 B-os, véletlenszerű képpontokból álló szintetikus PNG első feltöltése kifutott a kliens 8 másodperces határidejéből. A külön funkcionális ismétlés 20 másodperces megfigyelési határidővel sikerült, de maga a nagy feltöltés **16 328 ms**-ig tartott. Ezt nem számoljuk gyorsulásnak vagy hibamentes rövid határidejű eredménynek. A készülék elérhető maradt, újraindulás nem történt, mindkét próba visszaállt. A nagy PNG-k mentési idejének ingadozása és a megmaradt hangutánpótlási figyelmeztetések további vizsgálati területet jelentenek.

A regressziós ellenőrzésekből 566 Node-teszt és 58 Python/audio/natív ellenőrzés sikeres. Mind a tíz webes JavaScript-fájl szintaktikailag érvényes. A némított vizsgálatok mellett hallható hangerővel, élő spektrummal és fizikai kezelőszervekkel végzett használati próba továbbra is szükséges.

A normál firmware külön, üres Chrome-profilos próbájában a lejátszó és az állomások nézete összesen 12 logóhelyéből mind a 12 képet mutatott. Nem volt JavaScript-kivétel, sikertelen vagy félbemaradt logókérés. Hat tényleges logókérés történt; a két helyi képkéréses csúcs a nézetváltások együttfutását is tartalmazza. A próba végén a rádió megállítva, 0%-os hangerőn állt vissza.
