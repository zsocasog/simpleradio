# Lejátszás közbeni mentések és képolvasás – 2026. november 11.

## A vizsgálat célja

A `logo_test` ág `fcb7b5c8744f35d58ac1274b16b7690cfb01c177` mentése megmaradt visszatérési pontnak. A vizsgálat 1.2.09-es verzióval, változatlan rádiós könyvtárakkal készült. A fizikai ESP32-S3-on a hangerő a felhasználó engedélyével legfeljebb 1%; minden próba visszaállította a kiinduló állomáslistát, beállításokat és a megállított, 0%-os lejátszót.

A 0%-os próbák nem terhelték ténylegesen az FFT-t. Most külön számláló bizonyítja, hogy az FFT-eredmények és az LCD-rajzolások is haladnak. A részletes megfigyelés csak a mérőfirmware-ben aktív; a normál kiadásban nincs ilyen végpont vagy DMA-tartalomvizsgálat.

## Pontosabb hangellenőrzés

A régebbi referencia szándékos csendeket és rövid hangimpulzusokat is tartalmazott. Ez továbbra is használható spektrumvizsgálatra, de a teljesen nulla hangblokkok nem értelmezhetők benne automatikusan hibának.

A `tools/generate_continuous_fixture.py` külön, folyamatos kontrollmintát készít: 600 másodperc, 44 100 Hz, két csatorna, 16 bites FLAC, rögzített zajmaggal és változó amplitúdójú hangokkal. A natív FLAC és az Ogg-ba csomagolt FLAC visszafejtett hangadata azonos. A leghosszabb teljesen nulla szakasz **2 hangkocka**; egyikben sincs teljes, 256 kockás csendes blokk.

- A vizsgált Ogg SHA-256: `8bffade02ca3f68c93aa3c42d5c902a22495b62c0369213a02ed4adff9c73b82`.
- A visszafejtett PCM SHA-256: `e2ca7489736a1e3d58fe0320a41bf13a25c6e14f68dc03c50eb9c338eaf71f3e`.
- A PC-s FFmpeg csak a tesztfájl készítésére és ellenőrzésére szolgál; nem rádiós könyvtárfrissítés.

A mérőfirmware a ténylegesen kiküldött DMA-adatot nézi, mielőtt a meghajtó törli azt. Egy ellenőrzött blokk legfeljebb 256 sztereó Q31 kocka, körülbelül 5,8 ms. A megfigyelés nem módosítja a mintákat, nem foglal memóriát és nem ír naplót a megszakításban. A szándékos váltások és a kezdeti beállási idő nem tartoznak a stabil hangméréshez. A `--expect-continuous` kizárólag az ellenőrzött helyi forrás stabil szakaszain tekint egy ilyen csendes blokkot hibának; valódi rádión a zenei csend természetes is lehet.

**Kiderült egy korábbi mérési korlát:** a konzervatív pufferhiány-becslés lehetett nulla rövid tényleges elnémulás mellett is. Ezért a nulla becslést önmagában nem nevezzük akadásmentes hangnak. Az új kiértékelés az eltárolt mintákból utólag is felismeri a csendes blokkokat, akkor is, ha az élő eseménybesorolásból hiányzott a tesztszakasz neve.

Azonos ellenőrzött forrásnál és változatlan DMA-korszaknál a tesztszakasz nevének változása sem zárhat ki mintapárt: a feltöltés első pillanataiban fellépő hiba is számít. A forrásváltás és a valódi rádióra átlépés továbbra is elkülönül. A korábbi kontrollok újrakiértékelésével a nulla blokkok száma nem változott; a lefedett minták száma nőtt.

## A megvizsgált okok és változtatások

1. **Logócsere:** a teljesen kiírt ideiglenes PNG egyetlen LittleFS-cserével kerül a végleges helyére. A régi célfájl a csere sikeréig elérhető marad. A korábbi külön átnevezés `.bak`-ra és vissza fölösleges metaadat-műveleteket és átmenetileg hiányzó célútvonalat okozott. A meglévő régi `.bak` sikeres csere után takarítható el. Hibás PNG vagy sikertelen csere nem érvényteleníti a régi logót.

2. **Tömörített eredeti kép:** a közvetlenül böngészőnek megtartható PNG/JPEG felső fájlmérete 32-ről 128 KiB-ra nőtt. Így a teljes, legfeljebb 120 KiB-os böngészős PNG-feltöltési tartomány belefér. Ez fájlméretkorlát, nem új képpuffer: a vizsgálat továbbra is csak rögzített fejlécet/véget olvas, a hálózat darabonként továbbít. A már meglévő, nyolc helyes LCD-PSRAM-tár kerete nem változik. A 67 738 bájtos mintánál elkerülhető a nagy nyers LCD-másolat tartós kiírása, és a tartós PNG az eredeti marad.

3. **Fölösleges tárhelyszámolás:** a RAM-ban elkészített vagy már kész LCD-logó önmagában nem módosítja a gyorsítótár fájljait. Lejátszás alatt ilyen thumbnail után nem szükséges teljes fájlrendszer-foglaltságot újraszámolni. Tényleges LCD-fájlírásnál és üresjárati munkánál a frissítés megmarad. A kijelzett tárhelyadat továbbra is időbélyeges pillanatkép; nem a cache-korlát érvényesítésének helyettesítője.

4. **Prioritáskölcsönzés fájlolvasáskor:** a magas prioritású HTTP-feladat fájlrendszermutexre várva átadhatta prioritását egy alacsony prioritású írónak vagy bejárásnak. Az olvasási műveletek idejére a hívó alapprioritása 1, így a hangfeladat megelőzheti. Ez kiterjed a metaadatokra, könyvtárbejárásra, megnyitásra, olvasásra, pozicionálásra és lezárásra. A művelet végén az eredeti **alapprioritás** áll vissza; örökölt prioritást nem szabad alapprioritásként megőrizni. A hálózat parsingja, socketkezelése és a többi HTTP-munka továbbra is a korábbi prioritáson fut. Nincs új feladat vagy heap-puffer.

Nem módosult az ERB-felosztás, a spektrum mozgása, a hangerő feldolgozása vagy a rádió könyvtárverziója.

5. **Állomáslista a PSRAM-ban:** a mentett lista és a mentéshez szükséges teljes másolat korábban a belső memóriát foglalta. Most a már használt, korlátos PSRAM-JSON-foglalót használja mindkettő. A foglaló a kezelő osztály tagja, így a sikeres fájlírást követő dokumentumcsere után sem marad hivatkozás megszűnt helyi foglalóra. A listát továbbra is csak sikeres tartós írás után publikálja a rendszer. A mentési feladat 6 KiB-os belső vermét nem csökkentettük; a mérőváltozat külön rögzíti a tényleges tartalékát.

6. **Több képkliens kezelése:** lejátszás alatt egy, álló lejátszónál két állomáskép átvitele aktív. Legfeljebb nyolc további kérés várhat; ezek még nem nyitnak képfájlt. A hely nem a forrásfájl végén szabadul fel, hanem a teljes hálózati válasz lezárásakor, mert addig TCP-pufferek és újraküldési adatok maradhatnak. Ez külön keret az LCD nyolc PSRAM-képhelyétől. Az összes képküldés az AsyncTCP saját feladatában indul; a főciklus csak megszűnt ügyfelek várakozó kéréseit takaríthatja. A fájlformátumok és az ETag/304 működése megmaradnak.

A hosszabb próba utáni vegyes terhelés még megtalálta a mentési verem átmeneti foglalási hibáját: a rendszer újraindulás helyett szabályosan 503-at adott, de a logó mentése nem sikerült. Emiatt az új képátvitelek az elfogadott állomás-/logómentés idejére várakoznak. A már aktív képek befejeződhetnek; a várakozókat a mentési válasz lezárásakor vagy a mentő kliens bontásakor maga a hálózati feladat indítja újra. Nincs állandó új munkaszál vagy tartalékpuffer, és a 6 KiB-os mentési verem nem lett kisebb. A megoldás a foglalások átfedését csökkenti.

7. **Fájlműveletek memóriahiánynál:** a vegyes használat korai próbája újraindulást okozott. A hozzá tartozó ELF-fel feloldott hívási sor a logócsere utáni `LittleFS.exists()` → `fopen()` → `__sfp()` → új rekurzív mutex foglalása volt. A 92 bájtos foglalási hiba ezen az útvonalon `abort()`-ot okozhatott, mielőtt a hívó hibát ellenőrizhetett volna. A futó képkezelés és webes mentés létezésvizsgálatai most metaadatot olvasnak. A logó- és atomikus JSON-írás közvetlen, hibával visszatérő VFS-leírót használ; a részleges írást, szinkronizálást és lezárást külön ellenőrzi. Sikertelen szinkron vagy lezárás után nem nevezheti át az ideiglenes fájlt a korábbi érvényes cél fölé. A 512 bájtos JSON-adagolás megmaradt, új stdio-puffer nincs.

A részletes mérés JSON-válasza is PSRAM-ban készül, korlátosan, belső RAM-ra visszaesés nélkül. Ez csak a mérőváltozat terhelését csökkenti; a normál firmware-ben a végpont továbbra is hiányzik.

8. **Mentési válaszok hálózati átadása:** a későbbi nagylogós próba egyszer fejléc nélküli JSON-választ kapott. A rögzített ESPAsyncWebServer 3.12.1-ben a főciklusból folytatott válasz `_response` mutatója már a fejléc elkészülte előtt láthatóvá válhatott a másik magon futó ACK/poll számára. A mentés most egy atomikus mutatón adja át a teljesen elkészített válasz tulajdonjogát; a meglévő hálózati poll indítja el. Félbeszakított kapcsolatnál a kérés felszabadítja az át nem vett választ. Nincs új feladat vagy külön tartalommásolat. A kis javítás külön, ellenőrzőösszeghez kötött fordítási lépés; a könyvtár verziója változatlan. Az átadás a következő hálózati ütemezésig várhat. A részletes `replyUs` időbélyeg az átadás közzétételét jelöli; a teljes válasz idejét a kliens HTTP-mérése adja.

9. **Azonos lejátszási állapot ismételt kiírása:** az állomás logójának frissítése is kérhetett állapotmentést, pedig a `state.json` mezői nem változtak. A rendszer most kizárólag a legutóbbi sikeres, tartós írás hét vezérlési értékét jegyzi meg. Azonos értékeknél és meglévő fájlnál kihagyja a JSON felépítését és az írást. Tényleges állomás-, hangerő-, lejátszás-, EQ- vagy balanszváltozás továbbra is mentést okoz. Hiányzó fájlnál, újraindítás után és sikertelen írásnál nem tekinti tartósnak az állapotot. Az állapot JSON-ja is a már használt PSRAM-foglalót használja. Sikertelen tartós írás újra ütemeződik.

10. **Kétféle mentés ne torlódjon össze:** a halasztott lejátszásiállapot-mentés a beállításmentési válasz lezárásáig vár, így nem kerül két nagyobb fájlrendszer-tranzakció közvetlenül egymás mögé ugyanabban a főciklusban. A függő jelzés közben megmarad. A kifejezett kényszerített mentés továbbra is megkerülheti ezt a várakozást.

11. **A statikus webfájlok is átadhatták magas prioritásukat:** a külön, párhuzamos statikusfájl-olvasásos próba 21 csendes hangblokkot és egy 500-as mentési választ reprodukált. A megszakításból eltett eseményekben a főciklus alapból 1-es feladata **10-es örökölt prioritással** futott beállításmentés közben. A hangfeladat prioritása 2. A korábbi védelem a saját képválaszokat kezelte, az ESPAsyncWebServer statikus fájlmegnyitása, olvasása, metaadata és lezárása kimaradt. Most ezek is ugyanazt a hatókörre szóló prioritásvédelmet használják. A teljes HTTP-feladat prioritása, a hangfeladatok prioritása és a hálózati konfiguráció nem változott. A fordítási lépés öt rögzített függőségi fájlt ellenőriz, az előző ismert javításról is átáll, és együtt ismételhető a korábbi pufferezési javítással.

12. **Nyitott célfájl és atomikus csere:** az ESP LittleFS VFS-rétege [nyitott forrás vagy cél esetén EBUSY-val visszautasítja az átnevezést](https://github.com/joltwallet/esp_littlefs/blob/v1.20.2/src/esp_littlefs.c#L1872). Egy hosszú statikus HTTP-válasz ilyen olvasót tarthatott életben. A `/config.json`, `/state.json` és `/stations.json` kérései most a főciklusban a tényleges tárolt bájtokat olvassák PSRAM-ba, majd **lezárják a fájlt a hálózati válasz átadása előtt**. Nem élő beállításobjektumot adnak vissza. Az olvasási sor nyolc helyes, a válasz legfeljebb a JSON-dokumentumok 512 KiB-os keretét használja, és megtart 512 KiB PSRAM-tartalékot. A tartalom alapú ETag és a 304 megmarad. JSON- és logócserénél kizárólag EBUSY-ra van legfeljebb 1500 ms-os, fájlrendszermutexen kívüli újrapróbálás; más hibát nem takar el. Az OTA-jelzés és az aktív rövid olvasás közös kézfogása megelőzi a fájlrendszer lecsatolását; frissítés alatt új ilyen olvasás nem indul.

A DMA-telítettség lekérdezésére épülő külön várakozási kísérlet **nem maradt meg**. Egy tízperces futást teljesített, de az ismétlés ismét 10 csendes blokkot talált egy állapotfájl-írás körül. Ezért nem tekintettük az időben egybeeső mentést bizonyított, teljesen kijavított hanghibának. Az I2S órajele, hangformátuma és DMA-mérete változatlan.

## A megtartott változat fizikai ellenőrzése

A `9712622e0` mérőfirmware a fenti megtartott javításokat tartalmazza. A részletes hangellenőrzés alatt 1% hangerő, látható és ténylegesen haladó spektrum futott.

| Próba | HTTP-művelet | Stabil ellenőrzött DMA-blokk | Nulla blokk | HTTP-hiba / újraindulás |
|---|---:|---:|---:|---:|
| 24 beállításmentés, ténylegesen tartós EQ/balanszváltozások, hat kép és két tartós JSON olvasása | 536 | 17 306 | 0 | 0 |
| Tíz perc, öt logózási/mentési kör, JSON- és CSS-olvasások, valódi rádióra váltás, hat összesített HTTP-kapcsolat | 5578 | 95 659 | 0 | 0 |
| Vegyes használat: valódi FLAC/MP3 adó, új állomás, hideg logó, tartós beállítások/EQ, gyors váltás, WAV, VU/spektrum és stop/start | 1218 | 50 719 | 0 | 0 |
| Négy PNG-feltöltés és csere, hat képkérés szándékával | 332 | 15 108 | 0 | 0 |
| Harminc szándékosan félbehagyott és harminc teljes képátvitel | 109 | 5401 | 0 | 0 |

Az első sorban 50 tényleges fájlírás történt; az EQ/balansz utolsó értékeit a tárolt `state.json` is igazolta. A hosszú próba 426 mintapárban igazolta egyszerre az FFT és a kijelzés haladását. A legkisebb mintavételezett belső szabad memória 11 312 B, a legnagyobb szabad blokk minimuma 7668 B volt. A korábbi sikertelen nagyobb kapcsolatszámú futás külön szerepel a határoknál, nem része a sikeres teszteknek.

A valódi rádiós szakaszoknál a csendes blokk önmagában nem minősíthető hibának; a szigorú tartalomellenőrzés csak az ellenőrzött helyi forráshoz tartozik. A vegyes próba a tartós kezelőparancsokat is használta. A megszakításos teszt végén az aktív és várakozó képkérések száma egyaránt nulla volt.

Külön funkcionális próba a 427 és 67 738 bájtos PNG-t ugyanazon az útvonalon cserélte. A webes válasz az eredeti PNG-vel bájtra azonos, az LCD-válasz külön, érvényes 62 018 bájtos BMP volt, az ETag/304 működött, és nem készült fölösleges tartós nyers LCD-fájl. A feltöltések 453 és 2812 ms-ig tartottak. Egy további próba a nagy PNG-ből csak 64 bájtot olvasott, 700 ms-ig nyitva tartotta a kapcsolatot, és közben ugyanoda új logót töltött. A félbehagyott olvasó lezárása után a csere 1219 ms alatt sikerült; a végleges PNG pontosan az új tartalom volt.

A normál, részletes megfigyelés nélküli firmware azonosítója `70e5d803a`, mérete 3 079 840 B; a statikus belső RAM-igény 104 684 B. A firmware és a LittleFS-csomag is lefordult; 609 Node-teszt, 75 Python-teszt, az összes webes JavaScript szintaxisellenőrzése és a ténylegesen összeillesztett könyvtárjavítások ismételt ellenőrzése sikeres. A verzió 1.2.09 maradt.

A normál firmware OTA-frissítése után a hat eredeti állomás, a teljes konfiguráció, a két saját PNG és az összes webes fájl megegyezett a kiinduló mentéssel. Mind a hat logó eredeti webes és külön LCD/BMP-képként elérhető, ETag/304-gyel. A három tartós JSON-válasz is érvényes és 304-et ad az egyező ETag-re; a mérési végpont 404. Friss, rejtett böngészőben a lejátszó és az állomásoldal összesen 12 logóhelye betöltött, JavaScript-kivétel, befejezetlen vagy hibás képkérés nélkül. A böngészős próba végén az eredeti megállított, 0%-os állapot tartós visszaállítása is ellenőrzött.

### Kimért, továbbra is nyitott korlátok

- **Albumkeresés melletti mentési várakozás:** a célzott mentési próba mediánja 1719 ms, 95. percentilise 2718 ms volt. A valódi MP3-adónál viszont egy mentési válasz 12 468 ms-ig tartott. Ebből a mérőszámláló 11 516 ms várakozást rögzített az aktív borítókeresési hálózati kérés befejezésére; maga a konfiguráció tartós mentése 445 ms volt. A mentés végül sikerült, a zene folytatódott, de ez a kezelői várakozás még gyorsítható. A meglévő memória-/TLS-védelmet nem távolítottuk el a látszólag gyorsabb válaszért.
- **Több kliens együttes túlterhelése:** a hat összesített kapcsolatos próba sikeres, a nagyobb mesterséges párhuzamosságnál képkérések határidő-túllépése maradt. Ez külön szerveroldali hálózati/memóriakeretezési feladat; nem oldja meg önmagában a tesztgép kapcsolatkorlátja.
- **Hosszabb valódi használat:** a mérés nem napokig tartó hallgatás, és nincs akusztikai, fizikai encoderes/távirányítós vagy élő Home Assistant-próba. Ezeket nem állítjuk ellenőrzöttnek.

## Azonos folyamatos forrású kontrollok

Mindegyik alábbi futás 1%-os hangerővel, működő spektrummal, egy párhuzamos állomásképkéréssel és 427 / 19 053 / 67 738 / 67 738 bájtos PNG-feltöltéssel készült. A flash korábbi elrendezése és a gyorsítótár állapota futásonként eltérhetett, ezért egyetlen próba nem általános sebességgarancia.

| Változat | Stabil szakaszokban nulla hangblokk | Nyers utánpótlási figyelmeztetés | HTTP / újraindulási hiba |
|---|---:|---:|---:|
| 4 KiB-os írás, bővebb tömörített képtartomány; `4448130b2` | 36 | 2 | 0 |
| Külön 512 bájtos írási próba; `a80249dd3` | 142 | a nyers mérési jegyzékben | 0 |
| Csak a fölösleges RAM-thumbnail utáni számolás kihagyása; `89b9173a8` | 40 | 1 | 0 |
| A fájlolvasási prioritás kezelése is; `e94b3c833` | **0** | **0** | **0** |

Az utolsó, 95,9 másodperces kontrollban 247 HTTP-művelet, 83 állapotminta, 14 922 ellenőrzött stabil DMA-hangblokk és 76, FFT- és LCD-haladást egyszerre igazoló mintapár volt. A legkisebb mintavételezett szabad belső memória 11 620 B, a legnagyobb szabad blokk minimuma 7 668 B. A kis/közepes/nagy/nagy feltöltés 578 / 1469 / 3765 / 3812 ms volt. Ez nem jelenti azt, hogy minden mentés gyorsabb: a cél a hang folyamatossága a tartós mentés mellett.

A csak képválasz-adagolásra korlátozott prioritáspróba nem hozott egyértelmű javulást, ezért nem maradt meg. Az 512 bájtos feltöltési próba is vissza lett vonva. A korábbi, összes HTTP-munkát alacsony prioritásra helyező változatot sem használjuk.

Az egyképes kontroll után a hat képes próba további hibákat tárt fel; ezért az egyképes eredményt nem tekintettük a teljes munka lezárásának. A túl korán felszabaduló képkorlátozás, illetve a főciklusból indított streamelés kísérleti változata nem maradt meg. A teljes átvitel élettartamára szóló korlátozással és a PSRAM-állomáslistával a `8331bfbe7` mérőváltozat 97,3 másodperc alatt 359 kérést és négy feltöltést teljesített: 15 348 stabil DMA-blokkban nulla csendes blokk, nulla nyers hangutánpótlási figyelmeztetés és nulla HTTP-hiba volt. A vermen legalább 2492 B maradt. A későbbi vegyes próba viszont megtalálta a fent leírt fájlmutex-összeomlást; emiatt ezt a változatot sem neveztük késznek.

## Ismételhetőség és határok

A statikus olvasásokkal kibővített, korlátozatlan klienspróba a `9712622e0` mérőváltozatnál 2460 kérés után három képletöltési határidőt túllépett, így **sikertelen**. A 41 081 stabil ellenőrzött hangblokkban nem volt nulla blokk, nem volt újraindulás, és a visszaállítás sikerült. A foglalási hívási sor a Wi-Fi küldőpufferéhez vezetett. A hat képkérés mellett három fájlkérés, állapotfigyelés és mentés is indult; a nyolc PC-s munkaszálon emiatt helyi várakozás is keletkezett. A teljes kérésidőből ezt korábban nem választottuk külön. Ez nem teszi sikeressé a futást, és a hálózati terhelésnek marad határa.

A futtató most alapból hat összesített HTTP-kapcsolattal modellezi az egy böngészős használatot; a hat képkérés ebből a közös keretből fogyaszt. A `--http-parallel 12` külön nagyobb mesterséges terhelést enged. A napló külön rögzíti a tesztgépen várakozást (`clientQueueMs`) és a hálózati műveletet (`networkMs`). A félbeszakított kliens a valódi háttérkérés befejezéséig megtartja a helyét; a visszaállítás előtt minden ilyen munka lezárul. A 8 másodperces hálózati határidő nem nőtt meg.

A később visszavont várakozási kísérlet (`aaf723ff9`) kontrolljai:

| Fizikai próba | HTTP-műveletek | Ellenőrzött stabil DMA-blokkok | Nulla blokk a kontrollhangban | HTTP-hiba / újraindulás |
|---|---:|---:|---:|---:|
| 24 egymás utáni beállításmentés, hat képkliens | 323 | 12 827 | 0 | 0 |
| Tízperces ismétlődő terhelés, öt mentési/logózási kör, valódi rádióra váltással | 2538 | 95 356 | 0 | 0 |

A hosszabb futásban 493 mintapár igazolta egyszerre az FFT és az LCD-rajzolás haladását. A legkisebb mintavételezett belső szabad memória 12 060 B, az egybefüggő szabad blokk minimuma 7 668 B volt. Ez a próba az előző `b1678f2e2` tízperces futásban talált 58 ms-os esetet nem reprodukálta. Az utána következő `154e240bc` tízperces ismétlés viszont 96 276 vizsgált blokkban ismét 10 csendes blokkot talált. A várakozási kísérlet emiatt vissza lett vonva; az alábbi régi mérés nem a végső változat igazolása.

A mentés tartós befejezésének sebességére nem állítunk általános gyorsulást: a 24 mentés mediánja 1188 ms, 95. percentilise 2875 ms volt. Ez a visszavont várakozási kísérlet mérése; nem a végső változat sebessége. A pillanatnyi kezelési visszajelzés és a beállítás biztos flash-be írása két külön időpont.

A futtató `uploads`, `cold-logos`, `switches`, `saves`, `isolation`, `disconnects`, `extreme` és korlátos `soak` forgatókönyveket támogat. A `--static-read-load` a mentési és hosszú próbához tartós JSON- és CSS-olvasásokat ad. A `--durable-commands` a közönséges lejátszási/EQ-parancsokat is tartósan menti, mint a kezelőfelület; a visszaállítás ettől függetlenül mindig tartós. A mentési próba ezt külön, a tényleges `state.json` visszaolvasásával ellenőrzi. A megszakításos próba valóban félbehagyott képátviteleket váltogat teljes letöltésekkel, és ellenőrzi a várakozó kérések felszabadulását. Alapból némítást igényel; az 1% kizárólag explicit `--test-volume 1` kapcsolóval engedélyezett. Külső hangerőváltozásnál megszakítja a terhelést és visszaállít. A hosszú próba minden körben saját állomásokat használ, időnként valódi rádióra lép, és a végén ellenőrzi az eredeti listát és beállításokat.

A mérési mappák, a visszaállítási naplók, firmware-ek és hangelemző segédeszközök a nem publikált `.pio` alatt maradnak. A 25 másodperces feltöltési megfigyelési ablak nem tünteti el a lassú eseteket: a futtató külön megjelöli a szokásos 8 másodperces tesztkliens-határidőt túllépő feltöltést.

Ez a vizsgálat nem akusztikai hangminőség-mérés, nem bizonyít minden 5,8 ms-nál rövidebb hibát, és nem helyettesít fizikai encoderes, távirányítós vagy hangszórós használati próbát. Az állomásváltás parancsának visszaigazolását továbbra sem szabad az új állomás első hallható hangjának pontos idejeként értelmezni. A hosszú távú memóriaelemzésnél az azonos nyugalmi szakaszokat kell összehasonlítani; eltérő aktív TLS- és képfeladatok pillanatnyi memóriaigénye önmagában nem szivárgás.
