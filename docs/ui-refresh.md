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
