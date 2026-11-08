# Egységes LCD és webfelület

A változtatáshoz **firmware- és data/LittleFS-feltöltés is szükséges**.
A feltöltés után a böngészőben érdemes teljes újratöltést kérni (Ctrl+F5).
A kiadási verziókat a `src/config/version.h` adja meg; az API változatlanul 1.

Az utólagos **ikonpótláshoz önmagában csak data/LittleFS-feltöltés kell**,
ha az itt leírt LCD-felületet tartalmazó firmware már az eszközön van. Az ikonok ugyanabból
a helyben tárolt Tabler-készletből származnak, és az LCD-vel közös témaszínt
követik. Az MQTT/Last.fm sorok, a mentés visszajelzése, a jelszó megjelenítése,
a LED, a GitHub-hivatkozás és a lenyitható részek is egységes jelölést kapnak.
Nem keletkezik külső ikonszolgáltatástól vagy betűkészlettől való függés.

## Használat

- A lejátszón a számcím és az előadó egy csoportba került. A kiválasztott adó
  kisebb feliratként szerepel, ha vannak számadatok.
- Az LCD csatornaválasztója az előkészített állomásképeket kicsinyíti. A kis képek
  nem kapnak külön fájlt, és a lista nem kezdeményez új letöltést. Öt 32×32-es
  RGB565 kép legfeljebb 10 KiB PSRAM-ot használ a normál LCD-n. Hiányzó kép vagy
  sikertelen memóriafoglalás esetén a sorszám marad a helyén.
- A webes állomáslistán a gyakori művelet a lejátszás; a többi a hárompontos
  menüben van. A mozgatási gombok külön rendezési módban jelennek meg.
- Az új állomás, online keresés, szerkesztés és logófeltöltés oldalsó fiókban
  nyílik meg. A meglévő adó- és képadatokat használja.
- A Rendszer három nézete: Áttekintés, Kapcsolatok, Frissítés. Az
  Áttekintés MQTT-beállításai a Kapcsolatok nézetet és az MQTT-fiókot nyitják meg.
- Az enkóderhez tartozó hangerő és állomásválasztás az Enkóder alatt található.
  Az adáskapcsolat a Vezérlés, a LED a Kijelző oldal Megjelenés része alatt van.
- A fejléc és a lejátszó közös állapotot követő előző/lejátszás/következő vezérlőt
  kapott. A hullámsáv közepe a play gomb közepére, alja a borító aljához igazodik.
  Mobilon alsó navigáció és kompakt Több menü segíti az oldalak közti váltást.
- MQTT-szerkesztésnél egyetlen mentés rögzíti az egész űrlapot. A Mégse vagy
  Bezárás elveti a módosítást. Más beállítás mentése nem menti el ezt a piszkozatot.
- A frissítési fájl kiválasztása után külön kell elindítani a feltöltést. Másik
  célra váltáskor ismét fájlt és megerősítést kell választani.

## Megőrzött beállítások

A Kijelző oldali téma továbbra is a közös `themeAccent` / `themeCustomColor`
konfigurációt menti: az LCD és a webfelület együtt vált színt. A csúszkák meglévő
elengedéskori mentése, valamint a hangerő/EQ/balansz mentés nélküli hangelőnézete
megmaradt. Az új felület ugyanazokat az API-kat és vezérlőelemeket használja.

Az audió, FFT, állomáslogó-letöltés és albumborító-keresés kódja nem része ennek a
változtatásnak. Az új kis LCD-képek a már elkészült képek olvasói.

A nyelv továbbra is fordításkor választható a `UI_LANGUAGE` beállítással. A magyar,
angol és az új nyelvekhez szánt sablon az új nézeteket is teljesen lefedi.
Részletek: `data/i18n/README.md`.

## Helyi ellenőrzés

`python tools/ui_preview.py --port 8765` tesztadatokkal indít helyi előnézetet.
A `http://127.0.0.1:8765/` magyar, a `/?lang=en` angol változat. A nyelvválasztó
paraméter csak az előnézet része. A program nem olvassa a secrets.ini-t és nem
vezérli a valódi rádiót; a módosításokat csak a saját memóriájában tárolja.

Az ellenőrzés részletei a projekt gyökerében lévő `design-qa.md` fájlban vannak.

## LCD-előnézet és mezőkiemelések

A Kijelző oldal előnézete a jobb oszlop tetején, a Képforrás beállítás fölött
található, külön magyarázó szöveg nélkül. A 480×320-as LCD lejátszójának arányait
követi: borító, számcím, előadó és alsó kijelzősáv. Mindhárom VU-stílus,
a 24 sávos spektrum, a hangerő, az állomás és a dátum/idő saját mintát kap;
kikapcsolt alsó sávnál ez a terület üres. A téma és az inverz beállítás is látható.
Az oszlopok szemléltető állóképek; az előnézet nem kér hangmintákat a rádiótól.

A mezők fókuszkiemelése a kereten belül marad, így a lenyíló menük nyilánál és
az oldalsó keresőben sem vágódik le. A nagyobb hangerőhullám körül nincs keret;
billentyűzetes kezeléskor az oszlopok kapnak jelzést. Az 50%-os pont továbbra is
a lejátszásgomb közepére, a hullám alja a borító aljához igazodik asztali nézetben.
Ezek a módosítások csak a data csomagot érintik.

## LCD-lista és oszlopos hangerőjelző

A lejátszón nincs külön felső állomásnév; a számcím és az előadó közös blokkja
középre kerül a borító melletti területen. A megállított lejátszó és a hiányzó
számadatok továbbra is az állomásnévvel azonosíthatók.

A csatornalista a meglévő SR56 képeket kicsinyíti 32×32-es méretre. A színcsatornák
átlagolása előtt kezeli a tárolt bájtsorrendet, majd natív RGB565 képként adja át
az eredményt a kijelzőnek. A sorszámok nagyobbak, a lejátszó állomást play háromszög
jelöli; a szövegsáv a jelölés és a számok előtt ér véget.

Az alsó hangerőjelző a hangerőképernyő 24 oszlopos mintáját, méretezését és
hangerő szerinti kitöltését használja a VU helyén. Nincs IP-cím, kodekadat vagy
hangerőfelirat. Ez egy hangerőállást mutató minta, nem hangszintmérő; csak a
szükséges változásokkor rajzolódik újra. A webes előnézet ezt is követi.

Ehhez a körhöz firmware és data/LittleFS feltöltése is szükséges.

## Csatornaválasztó válaszideje és borítókeresés

A csatornaválasztó öt látható sorának kész képe PSRAM-ban marad. A kijelölés
mozgatásakor csak a régi és az új kijelölés változó részei kerülnek az LCD-re;
a logók saját, állandó hátterű területét ez nem érinti. A lista szélén egy sorral
gördül tovább az ablak, teljes képernyőtörlés nélkül. Az átfedő sorok képpontjait
memóriában mozgatja, és csak az újonnan belépő sort állítja össze. A mozgó sorokat
együtt küldi a kijelzőre, a fejléc és az alsó súgó helyén marad.

A 32×32-es logók állomáshoz kötött, tízelemű gyorsítótárban maradnak; a közelmúltban
látott állomás képe visszalépéskor is újrahasználható. Rövid nyugalmi időben a lista
közvetlen szomszédainak kis képe is előkészülhet a meglévő helyi képfájlokból.
A hiányzó kis képek előkészítése a képfeldolgozó háttérfeladatban folytatódik;
a kijelző feladata nem nyit képfájlokat és nem végez átméretezést. A lista nem
indít letöltést. A később elkészülő logó csak a saját kis
területét frissíti. Az automatikus lejátszás késleltetése csak akkor telhet le, ha
az aktuális kiválasztás már megjelent a kijelzőn.

A 480×320-as kijelzőn a listakép 225 KiB, a tíz logó legfeljebb további 20 KiB
PSRAM-ot használ. A listakép számára nem foglal belső/DMA memóriát; az opcionális
puffer létrehozásakor legalább 512 KiB PSRAM-tartalékot hagy. Ha nincs elég hely,
a lista a közvetlen kirajzolást használja. Új képfájlok nem keletkeznek.

A képfeldolgozó naplósorai is a külön naplózó feladaton keresztül mennek az
USB-re. A várakozó naplók száma korlátozott: megtelt puffer esetén kimaradhat
egy naplósor, de a képfeldolgozás nem vár a soros monitorra. A hangkapcsolat
kész állapotát az audiofeladat kezeli, így egy korábbi megállított állapot
feldolgozása nem tilthatja le az új kapcsolat albumborító-keresését. Sikertelen
keresőfeladat-indítás három másodperc után újrapróbálható; a találat nélküli
keresések korábbi visszavárása és a források sorrendje változatlan.

A `/api/system/status` válaszában az `artwork` rész mutatja a képfeldolgozó
utolsó kiszolgálása óta eltelt időt, a hangkapcsolat kész állapotát és az aktív
képfeladatot. A `system` memóriaadatai segítenek elkülöníteni a memóriahiányt
a megállt feladattól akkor is, ha a soros monitor nem ad új sorokat.

Ez az optimalizálás firmware-feltöltést igényel. A korábbi webes előnézet
módosításaihoz a data/LittleFS csomag is kell, ha azt még nem töltötted fel.

### Kis logók előkészítése a háttérben (2026-11-07)

A kész SR56 állomásképek feloldása, ellenőrzése, fájlolvasása és RGB565
csatornánkénti átlagolása a meglévő, egyszerre egy képfeladatot fogadó
háttérkezelőn fut. Megmarad a 0-s prioritás és a `tskNO_AFFINITY`: a szabad
mag dolgozhat, az audió mindkettőn előrébb való. A kis logó feladata ugyanazt
a 8192 bájtos stackméretet kapja, mint az eddigi LCD-képelőkészítés; nem indul
külön párhuzamos képfeldolgozó az aktív albumborító vagy logóletöltés mellé.
Az elkészítés két kimeneti soronként átengedi a futást.

A kijelző egyetlen, korlátos postaládán keresztül kér képet, és kizárólag a
teljes eredményt veszi át. A folyamatban levő kép saját PSRAM-puffert használ;
a látható tízelemű gyorsítótárat csak a kijelző feladata módosítja. A normál
32×32-es képnél az átmeneti puffer 2 KiB, új flashfájl nem keletkezik.
A megváltozatlan útvonal/időbélyeg nem indít új átméretezést vagy kirajzolást.

Görgetéskor a kérés az állomásával együtt mozog. Egyedi kérésazonosító védi
az átadást: bezárás vagy elavult kérés után a munkafolyamat felszabadítja a
saját pufferét, és nem írhat felül új sort. Memóriahiány, hibás SR56-fejléc
vagy rövid olvasás nem publikál részleges képet; a már kész azonos logó
látható marad. Sikertelen feladatindítás később újrapróbálható. A kis logó
eredménye nem használja az albumborító/állomásképek közös eredményrekeszét.

Ha éppen albumborító-keresés fut, egy még nem gyorsítótárazott kis logó arra
várhat, hogy a közös munkafeladat felszabaduljon. A szöveges lista, kijelölés,
görgetés és a meglévő kis képek ettől függetlenül használhatók. Ez a választás
megőrzi a működő borítókeresés belsőmemória-tartalékát. A változáshoz csak
firmware-feltöltés szükséges; az élő enkóderes próba a feltöltés után következik.

### Állomáslisták logóbetöltése (2026-11-07)

Az állomássorok és az online találatok először a dokumentumon kívül épülnek
fel. A leválasztott elemeket védő ellenőrzés ezért túl korán leállította a
képkérést; a megjegyzett azonosító miatt a későbbi állapotfrissítés sem indította
újra. A még be nem illesztett sorok képkérése most az összerakás utáni
mikrofeladatban indul. A közben eltávolított sorok és az elavult képválaszok
továbbra sem töltenek vagy írnak felül képet.

A hibát a korábbi kóddal Chrome-ban reprodukáltuk. A javított változatban
1440, 820, 390 és 320 pixeles nézeten ellenőriztük az állomáslistát, a lejátszó
listáját, a szűrést, a rendezési módot, az állomásváltást és az online találatok
logóit helyi tesztadatokkal. Három új teszt védi a beillesztés előtti kéréseket.
Ehhez a javításhoz csak data/LittleFS-frissítés kell; a firmware változatlan.

### Állomásmentés lejátszás alatt (2026-11-07)

A logó méretezése és PNG-vé alakítása továbbra is a böngészőben történik,
lejátszás közben is. Az első mentés jelzi, hogy ezt a képet a böngésző tölti
fel; a rádió nem indít vele párhuzamosan saját letöltést. Sikertelen böngészős
átalakítás, feltöltés vagy a helyi kép hozzárendelése után a mentett eredeti
URL a rádió meglévő tartalékútjára kerül. A régebbi kliensek mentési kérései
továbbra is automatikusan kérik a logó előkészítését.

Az állomás JSON-mentése és az egyedi PNG kiírása közös, egyszerre egy munkát
fogadó, 0-s prioritású háttérfeladatra került. A 6 KiB-os verem csak a munka
idejére kell. A HTTP-kérés gyenge folytatási hivatkozással vár, és csak a
tényleges fájlmentés után kap sikeres választ. A PNG fogadása legfeljebb
120 KiB PSRAM-ot használ; egyszerre egy fogadás és egy mentési feladat lehet
folyamatban. Belső RAM-ra nincs visszaesés. Hiányos, túlméretes, hibás sorrendű
és hibás aláírású adat nem kerül kiírásra; megszakításkor a megfelelő tulajdonos
felszabadítja a puffert.

Az állomásmentés saját dokumentumpéldányt ír ki, az olvasási zárolás nélkül.
A látható lista és revízió csak sikeres, atomikus fájlcserét követően változik.
A logó-előkészítés bejárata is csak sorba állít: fájlrendszeri ellenőrzés nem
fut a hálózati kérésben. A meglévő audió-, FFT- és albumborító-feldolgozás
változatlan. A mentési napló egy rövid sorban jelzi a művelet idejét.

A célzott tesztek a kérés megszakítását, a foglaltságot, a memória- és írási
hibákat, a PNG-részleteket, az olvasási zárolást és a böngészős tartalékutat
ellenőrzik. Chrome-os helyi próbában futó és megállított állapotnál is a
böngésző készítette a 150×150-es PNG-t; hibás kép esetén a rádiós tartalékút
indult. Ehhez a változáshoz firmware és data/LittleFS is szükséges; az élő
lejátszás alatti hangpróba a feltöltés után következik.

Az állomáslista frissítése megtartja a meglévő logóelemeket és a folyamatban
lévő képkéréseiket. Új állomás mentése, rendezés vagy kiválasztás ezért nem
üríti ki a korábban betöltött képeket. A lista lekérése nem változtatja meg
az összes helyi kép gyorsítótár-azonosítóját; sikeres egyedi PNG-feltöltéskor
csak a felülírt kép kap új azonosítót. A csoportos logófeltöltés továbbra is
frissíti a helyi képeket. A sorok neve, számozása és gombjai frissülnek.

A nyitott kereső melletti mentést késleltetett képkérésekkel is ellenőriztük:
a korábbi változat négy betöltött logója eltűnt, a javított változat mind a
négyet megtartotta, és csak az új képet kérte le. Az asztali, tablet- és
mobilpróba a szerkesztést, azonos útvonalra történő képcserét, szűrést és
törlést is lefedte. Ez külön webes javítás; csak data/LittleFS-frissítést igényel.

A hangerő hullámsávja egérrel rámutatva halvány témaszínnel mutatja a várható
értéket a meglévő százalékos jelzés mellett. Ez nem küld vezérlési parancsot;
az egér távozásakor a tényleges hangerő jelenik meg újra. Érintéskor nincs
beragadó előnézet. A fejléc inaktív menüpontjai finom témaszínt kapnak
rámutatáskor és billentyűzetes fókusznál, az aktív oldal erősebb jelölése
megmarad. Csökkentett mozgás beállításnál nincs színátmenet.

A főoldal és a WiFi-beállító oldal közös lapfülikonja négy lekerekített,
eltérő magasságú, a középvonalra fel-le tükrözött borostyánszínű oszlopot használ.
A helyi SVG a meglévő
webes verzió- és gyorsítótárkezelést használja; külső képszolgáltatás nem kell.

## Logók megőrzése data-frissítéskor (2026-11-08)

A korábbi OTA csak a négy JSON-állományt mentette: a megmaradó állomáslisták
olyan `/logos/station-*.png` fájlokra is hivatkoztak, amelyeket az új LittleFS
image már nem tartalmazott. A javított firmware a JSON-okkal és tartalékaikkal
együtt a `/logos` könyvtár kész fájljait is elmenti, binárisan, PSRAM-ba.
A cache továbbra is újragenerálódik. A legfeljebb 128 fájlos, 4 MiB-os mentés
memória-/olvasási hibája az eredeti fájlrendszer leválasztása és az OTA indulása
előtt leállítja a frissítést. A visszaírás ellenőrzött; sikertelen visszaállítás
nem jelent sikeres frissítést, és a RAM-példány megmarad az ismételt data-kísérlethez.

A régebben elveszett automatikus PNG-ket a böngésző pontos streamcím alapján,
egyszer, sorban próbálja helyreállítani. Érvényes képek, egyedi fájlnevek,
szándékosan üres logók és privát vagy aláírt streamcímek kimaradnak. Az eredeti
és a HTTP/HTTPS-változat azonos host/path/query mellett egyezhet. Név alapján
nincs találgatás. A böngésző készíti a PNG-t, és csak a fájlt tölti fel: az
állomások sorszámát, nevét és adáscímét nem írja át. Aki közben a csatornát
szerkeszti, annál a helyreállítás nem indul el. Az adatbázisban nem szereplő
vagy saját készítésű, már törölt képet ez nem tudja rekonstruálni.

Ezt először firmware-frissítésként kell telepíteni, és csak utána következzen
a data-csomag, mert a fájlok megőrzését a feltöltést fogadó firmware végzi.
Az eljárás futás közbeni RAM-mentés, nem áramszünetet átvészelő tartalék.
