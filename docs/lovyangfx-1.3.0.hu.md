# LovyanGFX 1.3.0 frissítés — 2026-11-14

A függőség `platformio.ini`-beli rögzítése 1.2.34-ről 1.3.0-ra változott.
A rádió és a WebUI verziója 1.3.14 maradt. Az alkalmazás C++ forrásai, a
webcsomag, a hangkönyvtár és a többi függőség változatlan.

## Áttekintés és fordítás

- Az új könyvtár [kiadási megjegyzései](https://github.com/lovyan03/LovyanGFX/releases/tag/1.3.0)
  alapján a PSRAM-sprite DMA-átvitele módosítja a puffer élettartamának szabályát.
  A két jelenlegi `pushSprite()` hívás a hangerő- és bootanimációban nem marad
  nyitott külső LCD-`startWrite()` tranzakcióban: a legkülső `endWrite()` lezárja
  az átvitelt, mielőtt a következő rajzolás/pufferújralétrehozás következne.
  Emiatt nem kellett új várakozást vagy dupla puffert bevezetni.
- A borító, csatornalista és óracsempék közvetlen, szinkron `writePixels()`
  útvonalon maradtak. Ennél a publikus függvénynél a harmadik logikai argumentum
  a bájtsorrendet jelöli, nem az aszinkron DMA engedélyezését.
- Az új könyvtár és minden alkalmazáskód külön, üres fordítási könyvtárban
  teljesen újrafordult; korábbi LovyanGFX-osztályokkal fordított objektum nem
  került az új firmware-be. Az összes 397 könyvtári forrás hash-e rögzítve lett.
- Normál ESP32-S3/ILI9488/SPI2/40 MHz, ESP-IDF 5.5.5 konfiguráció. A statikus
  RAM 103172-ről 103188 bájtra nőtt (+16); a programméret 3013043-ról
  3015579 bájtra nőtt (+2536). Nem történt platform-/SDK-frissítés.

## Ellenőrzések

- 689 Node-ellenőrzés és 65 + 15 Python/C++ ellenőrzés sikeres. A firmware és
  a LittleFS összeállítása, valamint mind a 10 JavaScript-fájl szintaxisellenőrzése
  is sikeres; a kész webcsomagra nem volt szükség a feltöltésnél.
- A fizikai rádióra a normál, diagnosztikai végpontok nélküli firmware került
  fel, `666d8eed0` buildazonosítóval. Csak firmware OTA történt, data OTA nem.
- Némított ICY-próba: MP3-mal a Geszti / Embertelen dal'22, FLAC-cal a
  Henri PFR & Carston / Make Love borítója is megjelent. A teljes képek
  bájtról bájtra egyeztek az ellenőrzött kiadványok képével (16657/8189 bájt).
- FLAC lejátszása közben az eredeti Retro Rádió, Radio1 és Forrás PNG-logót
  változatlan forrásbájtokkal ismét feltöltöttük, így a meglévő gyorsítótár
  érvénytelenítése után az új könyvtár készítette el az LCD-változatokat.
  Mindhárom 62018 bájtos LCD-BMP SHA-256 alapján azonos lett a frissítés
  előtt mentett változattal. A saját logófájlok neve és tartalma megmaradt.
- Az analóg és digitális készenléti nézet, a kijelző kikapcsolása és az
  ébresztés állapotváltásai is lefutottak, válaszoló webfelülettel.
- Az egyetlen ideiglenes tesztállomás törölve. Mind a 7 eredeti állomás,
  3 saját logó, minden beállítás, valamint a frissen mentett lejátszóállapot
  ellenőrizve és visszaállítva: Forrás rádió leállítva, hangerő 35%,
  EQ +1/0/-1, balansz 10. A webes fájlok egyeztek az induló állapottal.

## A mérés határai

A két borító teljes, hálózatos ellenőrzése 6,578 és 9,672 másodperc volt.
Ezek eltérő szolgáltatói válaszokat is tartalmaznak; ebből nem állapítható meg
az LCD-rajzolás gyorsulása. Külön képküldési CPU-/FPS-benchmark nem készült.
A teszt némítva futott, akusztikus hangellenőrzés és a fizikai panel
szemrevételezése nélkül. A logóknál a dekódolt LCD-képadatot hasonlítottuk.

A 32 KB feletti közvetlen átvitelek SCT-gyorsítása a könyvtárban elérhető,
de a jelenlegi ILI9488-as, RGB565-ről három bájtos pixelszínre konvertáló,
gyakran kis darabokat küldő rajzolási útvonalat nem alakítottuk át.
