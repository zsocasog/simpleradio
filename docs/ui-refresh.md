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
A hiányzó kis képek előkészítése rövid részletekben folytatódik, a rajzolás nem
nyit képfájlokat és nem indít letöltést. A később elkészülő logó csak a saját kis
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
