# A két nyitott teljesítménykérdés javítása és mérése

Kiinduló mentés: `513378606ae4afa9bf5f4e8f8ed6a4eccf979dd2`, `logo_test` ág.
Verzió: **1.2.09**, a könyvtárverziók változatlanok.
A mért firmware azonosítója: `8fd92aafc`.

**Lezárt ellenőrzés: a fizikai próbák, a normál firmware és LittleFS-csomag
buildje, a firmware OTA-feltöltése és a böngészős végellenőrzés sikeres.**

A rádión a normál `83a575f32` firmware fut. A mérőváltozat és a normál
összeállítás mind a 124 rögzített forrásfájl-ellenőrzőösszege egyezik;
a részletes mérés bekapcsolása buildbeállítás.

## 1. A mentés ne várja meg az elakadt borítókérést

Korábban egy élő HTTP/TLS-kérés a teljes hálózati várakozás idejére feltarthatta
a beállításmentést. Most a kapcsolatot birtokló képfeldolgozó megszakítja a
saját kérését, átengedi a mentést, majd ugyanazt a GET/range kérést próbálja
újra, az eredeti határidőn belül. Másik feladat nem nyúl az élő TLS-klienshez.

A natív TLS-kézfogás legfeljebb 100 ms-os várakozási szeletekben folytatódik.
A build ellenőrzi a rögzített keretrendszer érintett forrását, eltérésnél
megáll. A tanúsítványkezelés és a MusicBrainz kérései közötti várakozás
megmarad. A mentés miatti megszakítás nem kerül sikertelen találatként a
negatív gyorsítótárba. Szám- vagy hálózatváltás megszünteti az újrapróbálást.

Kontrollált helyi szolgáltató, az első válaszban öt másodperc várakozással:

| Mentés és tényleges fájlvisszaolvasás | Korábbi alapmérés `70e5d803a` | Végső mérőváltozat `8fd92aafc` |
|---|---:|---:|
| HTTP-fejlécre várva | 7,453 s | 1,421 s |
| HTTP-képtörzsre várva | 7,953 s | 2,781 s |
| TLS-kézfogás közben | nem készült összehasonlítható alapmérés | 1,344 s |

Mindhárom esetben az újrapróbált, 19 053 bájtos kép is befejeződött.
A keresés előkészítési idejét külön mérjük. A mentés négy másodperces
ellenőrzési határa és az általános HTTP-kérések nyolc másodperces időkorlátja
változatlan; a sikertelen kéréseket nem takarja el a teszt újrapróbálással.

## 2. Képek, webes kérések és hang egyidejű használata

A hálózati feldolgozóban végzett fájlolvasások a többi kapcsolatot is
feltartották. Ez a képeknél, a webfelület saját fájljainál és a feltöltött
logók listájánál is előfordult. Ezeket most a fő programkör készíti elő;
a hálózati feladat kész, változatlan bájtokat továbbít külső RAM-ból.

- A PNG/JPEG tömörített forrását a böngésző dekódolja. Nem készül új kép az
  ESP-n a webes listához. Az LCD-kép BMP-fallbackje is előkészül küldés előtt.
  A 304-válaszhoz nem kell teljes képmásolat.
- Egyszerre két állomáskép előkészítése/küldése lehet aktív; összesen nyolc
  képkapcsolat várhat vagy dolgozhat. A megszakított kliens saját foglalása
  felszabadul, a kész kép nem tart nyitva fájlt a TCP-visszaigazolások közben.
- A HTML/JS/CSS/SVG és build-manifest útvonalak is a tényleges fájlt olvassák
  előre. Megmarad a MIME-típus, a gyorsítótár-szabály és a csak gzipként
  elérhető fájlok kiszolgálása. A kompatibilitási helyreállító oldal megmarad.
  A feltöltött logók listája továbbra is friss könyvtáradatból készül.
- A `config.json`, `state.json` és `stations.json` a valóban elmentett fájl
  tartalmát adja, nem az élő állapot helyettesíti a mentést. Az előkészítés
  és az OTA fájlrendszer-leválasztása közös foglaltsági jelzést használ.
- A normál HTTP-válaszok közös küldési kerete legfeljebb két aktív küldőt és
  5744 vissza nem igazolt bájtot enged. A foglalást a tényleges ACK vagy
  bontás engedi el. A várakozók sorban kerülnek sorra; egy kép nem töltheti
  újra korlátlanul a keretét a vezérlőválaszok előtt.
- A kérések adatszerkezete és a szöveges választörzsek külső RAM-ba kerülnek.
  Foglalási hiba nem eredményezhet sikeres, de csonka választ.
- Az állomásmentő induláskor lefoglalt, 6 KB-os belső vermet használ. Egy munka
  dolgozhat, és csak tartós fájlcsere után jelezhet sikert. A változatlan
  állomás ismételt mentése nem írja újra a fájlt.
- Az új képek előkészítését a mentési **munka** befejezéséig tartjuk vissza.
  Korábban ezt egy régi jelzés a mentési HTTP-kapcsolat lezárásáig meghosszabbította;
  nagyobb terhelésnél az üresen váró képek ezért időkorlátba futottak.
  A küldött TCP-bájtok foglalása ettől külön, továbbra is ACK-hoz kötött.
- A spektrum csak feladatból használt, 16 bájtra igazított 8 KB-os FFT-munkaterülete
  külső RAM-ba került. A DMA-megfigyelő és a 4 KB-os átadó belső RAM maradt.
  Az ERB-felosztás, a számítás, a csillapítás és a hangkimeneti szinkron változatlan.
- Lejátszás alatt a logóírás 512 bájtos részei között 20 ms engedés ad időt a
  hangutánpótlásra. Álló lejátszónál 4 KB-os részek használhatók.
  A teljes gyorsítótár-statisztika frissítése megállított lejátszásra vár.
  Az írás előtti méretkorlát-ellenőrzés továbbra is élő foglaltságot használ;
  a változatlan kapacitás ismételt lekérdezése nem járja be újra a fájlrendszert.
- A Wi-Fi dinamikus küldőpuffere legfeljebb nyolc keret; a fogadóoldali SDK-
  beállítások változatlanok. A hálózati feladat belső verme 8 KB. A fizikai
  mérés legalább 2 KB megmaradó veremtartalékot követel.

Az 536 bájtos TCP-csomagméretet, az általános malloc-küszöb csökkentését,
a fogadóoldali Wi-Fi-pufferek átállítását és az olvasások magasabb prioritását
elvetettük. Ezek próbái nem adtak megfelelő eredményt. A végső megoldás nem
növeli meg a hálózati időkorlátokat és nem támaszkodik ezekre a kísérletekre.

## Fizikai ellenőrzés

A futtató legfeljebb 12 HTTP-kapcsolatot nyit, hat állomásképet és ismételt
JSON/CSS-olvasásokat indít. Ez meghaladja egy szokásos böngésző hat kapcsolatát.
Közben működik az LCD és a spektrum, új logók/állomások és valódi beállítások
mentése történik; a hosszú próba valódi MP3-rádióadásra is átvált és visszatér
a folyamatos Ogg-FLAC kontrollhangra. A hangerő legfeljebb 1%.

| Próba | HTTP-kérés | Stabil hangminta | Váratlan nulla DMA-blokk | Eredmény |
|---|---:|---:|---:|---|
| 15 perces, 12 kapcsolatos vegyes terhelés | 6541 | 750 | 0 | sikeres |
| Mentés HTTP/TLS-borítóletöltés közben | 111 | 32 | 0 | sikeres |
| Saját logók feltöltése és cseréje | 326 | 85 | 0 | sikeres |
| Félbeszakított képletöltések | 111 | 31 | 0 | sikeres |
| Tartós mentések terhelés alatt | 542 | 99 | 0 | sikeres |
| Gyors váltások, új állomás, beállítások, MP3/WAV/FLAC | 1142 | 259 | 0 | sikeres |

A 15 perces próbában 142 287 ténylegesen kiküldött DMA-blokkot ellenőriztünk;
váratlan nulla blokk, HTTP-hiba vagy újraindulás nem volt. A mintavételezett
legkisebb belső szabad memória 16 844 bájt, a legnagyobb egybefüggő blokk
minimuma 8180 bájt volt. Ezek mintavételezett értékek, nem folyamatos heap-követés.

A logófeltöltési próba kis és 67 738 bájtos képek ismételt, azonos útvonalon
végzett cseréjét is tartalmazta. A megszakítási próba félig elolvasott képek
elhagyását is vizsgálta. Mindegyik futás ellenőrizte az eredeti állomáslista,
beállítások és lejátszóállapot visszaállítását; a végén áll a lejátszás,
a hangerő 0%.

Automatizált ellenőrzés: 667 Node-teszt, 64 + 15 Python-teszt, JavaScript-
szintaxisellenőrzés, firmware- és LittleFS-build, a build után megismételt
17 függőségmódosítási ellenőrzés, whitespace- és verzióellenőrzés: mind sikeres.

A normál firmware OTA-feltöltése után igazoltuk:

- Mind a hat eredeti állomás, az összes beállítás és a két feltöltött saját
  logó megmaradt. A logók eredeti bájtjai és ellenőrzőösszegei egyeznek.
- Mind a hat állomás webes és LCD-képe elérhető; működik a feltételes 304,
  és az üres 304-válaszhoz nem küldünk hibás Content-Length fejlécet.
- A tartós JSON-fájlok visszaolvasása és ETag/304-kezelése helyes.
- A 427 és 67 738 bájtos, ugyanazon az útvonalon cserélt PNG a weben
  bájtpontos, az LCD-hez 62 018 bájtos BMP készül. A nagyobb kép normál
  firmware-rel végzett feltöltése ebben a próbában 5,890 s volt.
- A félig olvasott saját kép elhagyása után az azonos útvonalra feltöltött
  új kép helyesen jelent meg; nem maradt foglalt fájl vagy elveszett kép.
- Valódi, elkülönített Chrome/Edge-menetben a Lejátszó és Állomások oldalon
  összesen 12 listajelvényből mind a 12 kapott logót. A hat egyedi képkérés
  sikeres volt, nem maradt függőben kérés vagy JavaScript-kivétel.
- A normál firmware részletes diagnosztikai végpontja 404-et ad.
  A mérési naplózás nincs bekapcsolva a végső összeállításban.

A böngészős és képcserepróbák után újra ellenőriztük az eredeti adatokat:
a lejátszás áll, a hangerő 0%. A webes forrásfájlok változatlanok; a data
csomag elkészült, a végső telepítéshez a firmware OTA-frissítése elegendő volt.

## A mérés határai

A tápellátás felhasználó által jelzett véletlen megszakításával érintett első
november 13-i futást teljes egészében kizártuk az értékelésből. A nyers FAIL
napló megmaradt, külön megjegyzés jelöli a külső megszakítást. Nem számítjuk
sikeres próbának vagy firmware-regressziónak. A későbbi valódi hibás próbákat
nem soroltuk át emiatt sikeresnek; a fenti táblázat a végső mérőváltozat új futásait mutatja.

A folytonosságot az ismert kontrollhang digitális kimenetén vizsgáltuk.
Ez nem hangszórós hangminőségmérés. A természetes rádiós csendet nem
minősítjük automatikusan rendszerhibának. Fizikai encoderes vagy infrás
kezelés nem történt, a felhasználói műveleteket API-val szimuláltuk.
A régi, külön elérhető helyi fájlútvonalak statikus kiszolgálása megmarad;
az új előkészítés a fenti webes útvonalakat és az állomáskép-API-t fedi le.

A mérést a [terheléses futtató](../tools/stress_radio.py) és a
[kontrollált médiaszolgáltató](../tools/stress_fixture.py) végzi. A részletes
nyers mérési állományok helyben, a verziókezelésből kizárt `.pio` alatt maradnak.
