# Spektrum: mérés és mozgás

## Jelenlegi próba: rhythm v6, nyugodtabb teljes oszlop

Az ERB-felosztás, a nyers mérés, a hangkimeneti óra és a mélykorrekció
megmarad. A teljes látható magasság, tehát a ritmuskiemelés is, egységesen
25 ms-os exponenciális felfutást és 95 ms-os lecsengést kap mind a 24 sávon.
Nincs nagy változásra nyíló kerülőút, új képkockapuffer vagy csúcstartás.
A korábbi v5 20/35 ms-os beállítása túl gyors maradt: 33 ms alatt az esés
61%-a megtörtént; az újban csak kb. 29%-a. A felfutás továbbra is gyors.

Visszakerestük a hibrid próba mozgás v2/v3 megoldását is. Az legfeljebb
60 ms-mal simította a kis emelkedéseket és kerekítési hiszterézist használt,
de a nagy ugrások és az esések nagyrészt átmentek rajta. A mostani, külön
ritmuskiemelést is tartalmazó láncra ez önmagában nem elég; ezért az egész
magasságot kell kezelni. A pufferelt, köztes törlés nélküli oszloprajzolás
megmarad. A háttér közvetlen kitöltése 65 grafikai hívást vált ki oszloponként;
a pixeltesztek azonos képet és színsorrendet igazolnak. Ennek valós időnyereségét
a készüléken kell mérni. A hagyományos VU módok változatlanok.

Az azonos 24 másodperces telefonfelvétel egyszeri csúcsnormalizálással
feldolgozott hangján a szomszédos képkockák abszolút magasságváltozásainak
összege v5-höz képest kb. 29%-kal kisebb (34159 helyett 24207). Mind a
24 sávon kisebb lett ez az érték. Ez offline összevetés a mikrofonhanggal,
nem az LCD eredeti digitális bemenete és nem szubjektív minőségszázalék.

A 44,1/48 kHz-es, 125/250 ms-onkénti erős/halk váltott ütések próbájában
mind a 19 korábban legalább két félmagassági pixeles halkabb ütés látható
maradt. Az öt, korábban csupán egy pixeles határeset viszont összeolvadt.
Az egyenletes alap fölötti halk dob az első oszlopban alig mozdulhat, míg a
második/harmadik oszlopban megmarad a két teljes pixeles kontraszt. Ezek
valós korlátok: a csillapítás csökkenti a nagyon halk, sűrű részleteket is.
A tesztek ezt külön jelentik; nem állítják, hogy minden korábbi csúcs megmarad.

Ismételhető vizsgálat: `node tools/spectrum_rhythm_audit.cjs`. A próbák a
termelési Q31/Hann/FFT/ERB képleteket és LCD-frissítő függvényt futtatják.
A készüléken érzett változás további meghallgatást/megfigyelést igényel.
**Csak firmware szükséges, a data nem változott.**

## Naplózás

A `src/config/diagnostics.h` alapbeállítása:
- `SIMPLE_RADIO_SPECTRUM_DIAGNOSTICS=0`: nincs ötmásodpercenkénti PCM,
  sávonkénti dB-, FFT-, szinkron- és DMA-jelentés. A rövid indulási információk
  és a hibák megmaradnak. A beállítást jelző rhythm v6 sor csak egyszer jelenik
  meg indulás után, nem minden szám-, képernyő- vagy borítóváltáskor.
- `SIMPLE_RADIO_ALBUM_ART_DETAILS=1`: a borító hibakeresése egyelőre részletes.
  Később 0-ra állítva csak a keresés indulása, eredménye és leállási oka marad.
  A szolgáltatói találatok és részidők már most is ebben a kapcsolható ágban vannak.

A naplóíró továbbra is elkülönítve, korlátozott sorral működik. A lezárt soros
monitorra a hang és a kijelző nem vár. Részletes diagnosztika szükség esetén
fordítási kapcsolóval visszakapcsolható; könyvtárfrissítés nem történt.

## ERB: fokozatos mélykorrekció, törés nélkül

A `bass taper v3 -8..0dB over 8 bars` azonosító az induló ERB-sor végén
jelzi ezt a próbát. A korábbi −8/−6/−4/0 dB korrekció a harmadik és negyedik
oszlop között 4 dB-es lépcsőt hozott létre. Az új görbe az ERB-tengely mentén
fokozatosan, négyzetes lefutással közelíti meg a változatlan közép/magas skálát.

| Oszlop | Középfrekvencia | Képi korrekció |
| --- | --- | --- |
| 1 | 67 Hz | −8,00 dB |
| 2 | 122 Hz | −5,88 dB |
| 3 | 188 Hz | −4,08 dB |
| 4 | 266 Hz | −2,61 dB |
| 5 | 358 Hz | −1,47 dB |
| 6 | 469 Hz | −0,65 dB |
| 7 | 599 Hz | −0,16 dB |
| 8–24 | 754 Hz-től | 0 dB |

Az első három oszlop visszafogása 0,13 dB-en belül megmarad. A harmadik és
negyedik között már csak kb. 1,47 dB az eltérés. A görbe nem átlagolja össze
a szomszédos oszlopokat, és nem késlelteti a mozgást. Mindegyik a saját mért
sávenergiáját követi. Nincs új AGC vagy dinamikus erősítés.

A nyers `bands-dB` naplósor ezt a korrekciót nem tartalmazza. Ez kizárólag képi
súlyozás; nem dobütés-felismerés, és a kitartott mély hangokat sem távolítja el.

Ez a statikus görbe önmagában csak a magasságra alakítást változtatja meg.
Az erre épülő ritmuskiemelést a fenti rész írja le. A hosszú LCD-rajzolási
szünetek külön vizsgálandók.

## Belsőmemória-tartalék a borítókereséshez

A valós adókkal végzett próba ismételt `task stack unavailable` üzenetet
adott: mintegy 40 KiB összes szabad belső RAM mellett a legnagyobb szabad
blokk csak 11764 bájt volt. A változatlan borítókereső 12288 bájtos feladatverme
így nem fért el, a hárommásodperces újrapróbálás sem indított keresést.

A spektrum saját, 4096 bájtos FFT-együtthatótáblája ezért az ugyancsak csak
feladatból használt Hann-ablak mellé, 16 bájtra igazított PSRAM-ba került.
Az együtthatók előállítása, a saját tábla használata és az indulási numerikus
önellenőrzés változatlan. Sikertelen külső foglaláskor az elemző nem indul;
nincs belső RAM-os tartalékfoglalás. Az I2S-megszakítás pufferei és az FFT
8192 bájtos gyors munkaterülete belső memóriában maradnak. Sem az ISR, sem
a hangdekóder nem éri el a külső együtthatókat.

Az egyszeri `[spectrum] memory v1:` üzenet a feladatok létrehozása után kiírja
az összes szabad belső memóriát és a legnagyobb szabad blokkot. Ezeket az
albumborító `search start`, illetve `image ready` soraival együtt kell az
eszközön ellenőrizni. A linkerrel igazolt statikus memórianyereség önmagában
nem bizonyítja a lejátszás közbeni foglalások sikerét. A külső táblára váltás
esetleges időzítési hatását a meglévő `timing`, `sync` és `DMA` sorok mutatják.

A 24 sáv, 1024 pontos FFT, 40 Hz-es elemzés, felfutás/lecsengés és a tényleges
hangkimenethez kötött óra változatlan. A logó-/borítókezelés, a webfelület és
a könyvtárverziók nem módosultak. **Csak firmware-feltöltés szükséges.**

## Második módosítás: a tényleges hangkimenet követése

Az új változatot a `[spectrum] sync v2:` indulási sor azonosítja.
A spektrum bemenete az I2S-meghajtó `on_sent` visszajelzéséből származik:
azokat a 32 bites sztereó mintákat másoljuk, amelyeket a DMA ténylegesen
kiküldött. A dekóder első csomagjának érkezése és az MP3/FLAC csomagmérete
így nem határozza meg a megjelenítés óráját. Részleges I2S-írás, indulási
üresjárat és a kimenetre kerülő csend is ugyanazon az útvonalon látszik.

A megszakítás legfeljebb 256 sztereó mintakeretet másol két kis, összesen
4 KiB-os **belső** puffer egyikébe, majd értesít egy átadó feladatot. Nincs
benne FFT, PSRAM-hozzáférés, naplózás vagy várakozás a fogyasztóra. Ez fontos,
mert a használt keretrendszerben az I2S-megszakítás kikapcsolt flash-cache
mellett is lefuthat. A fordított firmware-ben a megszakítás függvényeit és
adatait külön is ellenőrizzük. Az átadó 2 KiB-os veremmel, a hangfeldolgozásnál
alacsonyabb, az FFT-vel azonos prioritással fut. A Hann-ablak változatlan,
4 KiB-os segédtáblája átkerült PSRAM-ba, így ellensúlyozza a belső DMA-másolatok
helyét. Ebben az első szinkronváltozatban az FFT gyors munkaterülete és saját
együtthatói belső memóriában maradtak; a mintasor, sávterv és eredménysor
továbbra is PSRAM-ban voltak. Az együtthatók későbbi áthelyezését lásd fent.
A belső többletigény így főleg az átadó 2 KiB-os verme és a kis vezérlőadatok.

A minták a külön FFT-feladatba kerülnek. Minden ablak időpontja a tényleges
kimeneti blokk végéből és az ablakon belüli mintapozícióból számolódik;
az átadó feladat késése nem tolja el ezt az időpontot. Az ablakok folytonosak,
a kihagyott bemeneti blokk után az elkezdett ablak eldobódik. Az újraindítás,
mintavételi frekvencia és láthatóság váltása érvényteleníti a régi bemenetet.
Tele puffer esetén csak a kijelzéshez szánt minták veszhetnek el; a hangkimenet
nem vár az elemzőre. Hosszú kijelzőakadás után régi ütések nem játszódnak vissza.

A 24 ERB-sáv, 1024 pontos FFT, 40 Hz-es mérés, mélysáv-korrekció,
érzékenységi skála, azonnali felfutás és 45 ms-os lecsengés változatlan.
A könyvtárverziók és a DMA-beállítások nem változtak. A rögzített hangkönyvtárba
egy visszaellenőrzött, csak megfigyelést bekötő build-javítás kerül; ez nem
módosítja a dekódolást, hangerőt, I2S-írásokat vagy kapcsolati javításokat.
A logó- és albumborító-kezelés forrásai, valamint a data fájlok változatlanok.

### Mit nézzünk a következő mérésben?

- Ugyanaz a kétperces FLAC- és MP3-minta, 100% érzékenység, változatlan
  hangerő és 0 dB EQ. **Csak firmware-feltöltés szükséges.**
- A `sync` sorban `source=sent-DMA` jelenik meg. A `new` a friss LCD-mérések
  száma; a `due-late-max` már a megfigyelt kimeneti ablak közepéhez viszonyít.
- A `DMA` sorban `drop=0 expired=0` a cél. A `copy-max` a megszakításban
  végzett rövid másolás legnagyobb ideje, a `handoff-max` az átadó várakozása.
  A `pcm` immár kimeneti blokkokat számol; 44,1 kHz és 256 mintakeretes DMA
  mellett körülbelül 861 blokk érkezik öt másodperc alatt, a kodektől függetlenül.
  Ez a sor ismétlődő elemző-újraindítás mellett is megjelenhet, nem kell hozzá
  egy teljes, megszakítatlan FFT-mérési időszak.
- A determinisztikus ütemezési teszt 44,1/48 kHz-en, 12 ms-os FFT-munkával
  és 36 ms-os LCD-frissítéssel öt másodperc alatt 199 FFT-t, 138 friss
  kijelzést és nulla elavult eredményt adott. Ez modellteszt, az eszközön még
  meg kell ismételni a mérést.

A kimeneti visszajelzéshez igazítás nem szünteti meg az FFT-ablak, számítás
és következő LCD-frissítés idejét. A DAC/erősítő/hangszóró és a hallgatási
távolság késése nincs megmérve: ezért a napló `acoustic-offset=unmeasured`
jelzése továbbra is indokolt. A hang és kép tényleges együttmozgását az
eszközön végzett próba igazolhatja.

## Első módosítás: felfutás és lecsengés

A 2026-11-02-i teszthangok után az LCD-oszlopok a következő frissítéskor
azonnal felveszik a magasabb mért értéket. A csökkenést 45 ms-os időállandójú,
exponenciális görbe simítja. Ez nem 45 ms-os teljes eltűnést jelent: a mért
csúcstól és a frissítési időpontoktól függően nagyjából 0,15 másodperces
látható lecsengés várható a teszthang rövid ütéseinél.

Az induláskori `[spectrum] motion v1:` sor azonosítja ezt a változatot.
A 24 ERB-sáv, az 1024 pontos FFT, a 40 Hz-es mérési gyakoriság, a sávok
szintskálája és a meglévő megjelenítési óra változatlan. A hangkimenethez
kötött szinkron külön következő kör, ennek hatását így külön lehet mérni.

Csak a firmware-t kell feltölteni. A data mappa és a könyvtárverziók nem változtak.
Ugyanazt a kétperces FLAC- és MP3-teszthangot kell megismételni 100%-os
érzékenységgel, változatlan hangerővel és 0 dB-es EQ-val. Az ütések követését
és a köztük lévő lecsengést érdemes figyelni, a teljes naplóval együtt.

## Korábbi mérési kör

Ebben a körben a megjelenés és az időzítési algoritmus változatlan. A cél az,
hogy elkülönüljön a számítás, a rajzolás és a várakozás ideje. Nincs új feladat,
nincs új hangpuffer, és a mérés nem ír flash-be. A hangkönyvtár változatlan.

Az eddigi sorok mellett körülbelül öt másodpercenként két rövid sor érkezik:

- `[spectrum] timing:`: a kész hangablak várakozása és az előkészítés / FFT /
  sávösszegzés legnagyobb ideje. A `work-wall` a feldolgozás közben eltelt idő
  aránya; más feladatok miatti megszakítás is beleszámít, tehát nem pontos CPU-terhelés.
- `[spectrum] sync:`: LCD-frissítések és újonnan megjelenített mérések száma;
  rajzolási idő átlaga / maximuma (`draw-us`); két rajzolás közti leghosszabb
  szünet (`gap-max`); a hangablak elkészülésétől a rajzolás végéig eltelt idő
  átlaga / maximuma (`ready->LCD`); a számítás végétől a rajzolásig eltelt
  leghosszabb idő (`FFT->LCD-max`). Az ismételten megjelenített azonos mérések
  nem növelik ezeket az új-mérés számlálókat és késési értékeket.

A `due-late-max` a jelenlegi becsült mintaórához viszonyít. A `DMA-cap` a
beállított kimeneti hangpuffer időtartama, nem a tényleges késése. Az
`audio-offset=unmeasured` szándékos: a DAC valódi lejátszási pozícióját ez a
kör még nem méri. Ezekből az adatokból önmagukban nem állítható, hány ms az
eltérés a hallható hang és a kép között.

A hosszabb FLAC-csomagból előre kiszámított mérések szándékosan várhatnak
a sorukra. A nagyobb `FFT->LCD` ezért önmagában nem jelent hibát vagy kevés
számítási teljesítményt; a többi adattal és a hallott/látott viselkedéssel
együtt kell értékelni.

A rövid sorok a meglévő, korlátos háttérnaplózóhoz kerülnek. Telített vagy
bezárt soros monitor esetén eldobhatók; a hang és a rajzolás nem vár rájuk.

## Kipróbálás

1. Csak a firmware-t kell feltölteni; a data mappa nem változott.
2. Válaszd a spektrumot, és az első összehasonlításhoz hagyd 100%-on az érzékenységet.
3. Egy MP3/AAC és egy FLAC adón is várj 30–60 másodpercet. Ha közben borító
   töltődik be vagy csatornát váltasz, az a terheléses összehasonlításhoz hasznos.
4. Küldj néhány összetartozó `timing`, `sync` és szokásos `[spectrum]` sort,
   és jelezd, hogy a kép inkább késik, előresiet, vagy csak lomha.

Ezután lehet dönteni a hangkimenethez kötött időzítés következő lépéséről és
az átfedő FFT-ablakokhoz rendelkezésre álló számítási tartalékról.
