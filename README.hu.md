# SimpleRadio

[English documentation](README.md)

**SimpleRadio** egy ESP32-S3 alapú internet-rádió firmware modern webes felülettel és külön LCD-lejátszóképernyővel. Saját építésű, I2S hangkimenetes, fizikai vezérlős és opcionális otthonautomatizálási integrációjú rádióhoz készült.

> Jelenlegi verzió: **0.8.24** · ESP32-S3 N16R8 · LittleFS · magyar és angol felület

![SimpleRadio LCD lejátszó](.screenshots/lcd/player1.jpg)

## Főbb képességek

- LCD-lejátszó állomáslogóval, metaadatokkal, hangerőnézettel, állomásválasztóval, VU/alsó sáv módokkal és készenléti órákkal.
- Külön választható, 24 sávos, 1024 pontos FFT-spektrum harmadoktávos logaritmikus beosztással (legalul basszusgyűjtősávval), Hann-ablakkal korrigált RMS-sávenergiával és a szimmetrikus VU teljes szélességű oszlopsorával. Beállítás: **Kijelző → Alsó kijelzősáv → Spektrum (24 sáv, FFT)**. Az EQ utáni sztereó Q31-minták eredeti mintavételi frekvencián kerülnek elemzésre, közös hangerő-kompenzációval; az EQ és a balance hatása megmarad. A mintaszámláló körülbelül 40 mérést ütemez másodpercenként (alacsony mintavételi frekvencián kevesebbet), a hosszú FLAC-csomagok részleteit is időrendben követve. Nincs legerősebb-részlet kiválasztás vagy automatikus szintkövető. Azonos, fix skála őrzi meg a sávok és a halk/hangos részek különbségét; az 50%-os érzékenység felezi a magasságokat. Az LCD legfeljebb kb. 30 képkockát rajzol másodpercenként, 12 ms-os felfutási és 85 ms-os lecsengési időállandóval. A hang-visszahívás csak másol, nem várakozik, nem foglal memóriát és nem számol FFT-t. A 16 PCM-puffer összesen 128 KiB PSRAM-ot használ belső RAM-os tartalék nélkül; az elemző továbbra is az audiónál alacsonyabb prioritású. Stop után az elemzés leáll, az oszlopok természetesen nullára csengenek; elrejtéskor azonnal törlődnek. Az induláskori FFT-önteszt és az ötmásodperces napló megmarad, `pcm-frames` mintaszámlálóval és `timeline v3` jelöléssel bővítve. Ehhez a spektrumfrissítéshez csak firmware-feltöltés kell; a logó- és albumborító-kezelés változatlan.
- Webes kezelőfelület lejátszáshoz, állomáskereséshez és -szerkesztéshez, EQ/balance-hoz, kijelzőhöz, enkóderekhez, IR-távirányítóhoz, WiFihez, MQTT-hez és OTA-hoz.
- MP3, AAC/AAC+, FLAC, OGG/Vorbis, Opus és más, az `ESP32-audioI2S` által támogatott streamformátumok.
- Helyi fájlból, állomás-URL-ből, ICY metaadatból vagy Radio Browserből érkező logók; az LCD-re optimalizált cache gyorsítja az ismételt lejátszást.
- A keresett JPEG/PNG albumborítók webes képe és középre vágott LCD-változata legfeljebb két PSRAM-tárolóban él, számonkénti flashírás nélkül. A webes letöltés végéig a hozzá tartozó kép nem írható felül; elégtelen memória esetén az állomáslogó jelenik meg. A borítók átmenetiek, újraindításkor elvesznek. Az audiókönyvtár verziója és a feladatprioritások változatlanok; az előkészítés idejét az `[album-art] timing RAM-*` sorok mutatják.
- Egy vagy két forgóenkóder, opcionális IR-vevő és előlapi RGB LED. A webes felület automatikusan letiltja a hardverprofilban nem engedélyezett vezérlőket.
- MQTT discovery és opcionális [Home Assistant Lovelace kártya](home-assistant/README.md).

## Támogatás

Ha hasznosnak találtad a SimpleRadio projektet, meghívhatsz egy kávéra! 

<a href="https://ko-fi.com/zsoltsogorka" target="_blank" rel="noopener noreferrer"><img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="Támogatás Ko-fi-n"></a>

Köszönöm!

## Hardverprofil

A tesztelt célhardver **ESP32-S3 N16R8**, **ILI9488 480x320 SPI kijelzővel** és I2S hangkimenettel (például két MAX98357A modullal sztereóhoz). ST7796 480x320 és ILI9341 320x240 profil is elérhető.

Az első build előtt a nyelvet, kijelzőt, pineket és opcionális hardvert a [`src/config/hardware_config.h`](src/config/hardware_config.h) fájlban állítsd be. A jelenlegi profil egy forgóenkódert és IR-vevőt használ.

## Saját nyelv hozzáadása

A felület nyelve fordításkor a `hardware_config.h` fájl `UI_LANGUAGE` értékével választható; a beépített értékek: `hu`, `en` és az angol `eng` aliasa. Saját nyelvhez másold a [firmware-sablont](src/i18n/lang_template.h) `lang_xx.h`, a [webes sablont](data/i18n/template.js) pedig `xx.js` néven, fordítsd le mindkettőt a kulcsok és helyőrzők megtartásával, állítsd be a `#define UI_LANGUAGE xx` értéket, majd fordítsd újra a firmware-t és a LittleFS/data image-et. A teljes útmutató: [nyelvi leírás](data/i18n/README.md).

## Telepítés és frissítés

Nyisd meg a projektet VS Code-ban PioArduino vagy PlatformIO támogatással, állítsd be a `hardware_config.h` fájlt, majd töltsd fel a firmware-t és a data image-et is:

```powershell
pio run
pio run -t upload
pio run -t uploadfs
pio device monitor -b 115200
```

Első telepítésnél mindkét feltöltés szükséges. A `data/` mappa módosítása után töltsd fel újra a data image-et; csak C++ módosítás után elég a firmware feltöltése. Ha nincs elmentett WiFi, a rádió az `ESP32-WebRadio` hozzáférési pontot indítja a beállításhoz.

Az első vezetékes feltöltés után a Rendszer oldalon firmware- és data-OTA frissítés is elérhető. A data OTA lecseréli a LittleFS-t; a WiFi, konfiguráció, állapot és állomáslista mentésre kerül, a logócache újragenerálódik.

A firmware és a WebUI/data külön verzióval, valamint közös Web API-kompatibilitási szinttel rendelkezik. Az eltérő kiadási verziók használhatók együtt, ha az API-szint kompatibilis. Inkompatibilis vagy hiányzó WebUI-manifest esetén a firmware a normál felület helyett egy LittleFS-től független helyreállítási OTA-oldalt indít, ahonnan a megfelelő firmware vagy data image feltölthető. A `data/build-info.json` fájlt a build automatikusan generálja a `src/config/version.h` értékeiből.

Lejátszás közben a firmware korlátlanul újrapróbálja a megszakadt streamet, ha a stream-retry be van kapcsolva; a késleltetés fokozatosan nő, legfeljebb 60 másodpercig. WiFi-szakadáskor ötmásodpercenként explicit újracsatlakozási kísérlet történik, a hálózat visszatérése után pedig a stream újraindítása automatikusan folytatódik. Az LCD külön jelzi a WiFi-hiányt, a kapcsolódást és a stream újrapróbálkozását.

A `secrets.ini` opcionális és Git által figyelmen kívül hagyott fájl. A [`secrets.example.ini`](secrets.example.ini) alapján csak helyi buildidejű beállításokhoz hozd létre, például fix teszt-Wifihez, MQTT-hitelesítéshez vagy saját OTA-jelszóhoz.

A Last.fm előzetes beállításához a helyi `[env:esp32-s3-devkitc1-n16r8]` szakasz meglévő `build_src_flags` listájához add hozzá a `-D SIMPLE_RADIO_LASTFM_API_KEY=\"YourLastFmApiKey\"` sort. A Rendszer oldal felismeri ezt a kulcsot, de nem jeleníti meg. A weben elmentett kulcs elsőbbséget élvez; annak törlésekor a firmware-be fordított kulcs lép ismét életbe. Az előre megadott kulcs eltávolításához a kapcsoló nélkül újra kell fordítani és feltölteni a firmware-t. Valódi kulcsot ne tölts fel GitHubra; a lefordított firmware is tartalmazza a kulcsot. Ehhez a beállításhoz nem kell data-feltöltés.

Az audiókönyvtár rögzített verziója megmarad. A `tools/patch_audio_hls.py` fordításkor kizárólag a HLS-listák URL-feloldásának célzott javítását alkalmazza a helyi függőségen (a `../` szülőkönyvtárak kezelésével együtt). Ez nem jár plusz hálózati lekérésekkel; ismeretlen könyvtárforrásnál a build megáll, nem alkalmaz ellenőrizetlen javítást.

A secrets.ini-ben az MQTT_HOST, MQTT_PORT, MQTT_USER, MQTT_PASS és MQTT_ROOT_TOPIC builddefiníciókkal előre megadható az MQTT-kapcsolat. A már weben elmentett, nem üres hosthoz tartozó beállítások elsőbbséget élveznek, az üres felhasználónév/jelszó is megmarad. Előre megadott adatok önmagukban nem kapcsolják be az MQTT-t. A helyi fájlban az adatokat a meglévő build_src_flags listához kell hozzáadni; a mintafájl mutatja a formátumot.

A Rendszer oldalon a Last.fm-kulcs törlése egyszeri gombművelet. Csak akkor aktív, ha van weben mentett kulcs; az előre megadott firmware-kulcsot nem törli, annak használatát külön állapotjelzés mutatja.

Az állomáslogók kicsinyítése minden újonnan felvett adó nyilvános HTTP(S) logóforrására kiterjed. Az ismert hivatalos kis változatok után általánosan a wsrv.nl képkicsinyítő szolgáltatását használjuk, legfeljebb 176×176 pixeles, képarányt megőrző JPEG-kimenettel. Csak a nyilvános kép URL-jét adjuk át; helyi feltöltések, IP-címek, belső hálózati címek és hitelesítési adatot tartalmazó URL-ek az eredeti úton maradnak. A cache kulcsa továbbra is az eredeti URL, és sikertelen kicsinyítéskor az eredeti kép következik. A webes mentés korábbi, minden adóra alkalmazott 150×150 pixeles böngészős előkészítése is megmarad. Az album- és streamborítók keresési és megjelenítési útja változatlan.

A VU/spektrum érzékenységének húzása csak RAM-os előnézetet küld. A legutolsó értéket elengedéskor mentjük, a gyors egymás utáni állításokat összevonva; a közben érkező teljes konfigurációválasz nem állítja vissza a csúszkát. Az atomi JSON-mentés 512 bájtos blokkokban ír, és hiányos írásnál megtartja az előző fájlt. Ehhez a csomaghoz firmware és data feltöltése is szükséges.

Az állomáslogóknál a letöltött JPEG formátumát még mentés előtt ellenőrizzük. A progresszív, kiterjesztett vagy nem támogatott színformátumú JPEG helyett minden adónál kompatibilis kicsinyített változatot próbálunk. A régi cache-ben talált, bizonyítottan nem támogatott JPEG csak akkor kerül újra-előkészítésre, ha nincs hozzá kész LCD-kép; felhasználói feltöltést és átmeneti memóriahibánál az eredetit nem töröljük.

Álló lejátszónál a kiválasztott adó logója elsőbbséget kap, majd a mentett adók hiányzó logói sorban készülnek elő. Egyszerre egy feladat fut, a munka között három másodperc ütemezési szünettel; a kész képeket kihagyjuk, a hibás források újrapróbálkozása késleltetett. Lejátszás közben nincs teljes állomásbejárás. Soros visszajelzés: idle station prewarm queued, prewarm download start és LCD station logo ready. Ehhez az LCD-kompatibilitási és előtöltési javításhoz a legutóbbi WebUI/data megtartása mellett csak firmware-feltöltés szükséges.

Az albumborítók keresése az egyező előadó mellett a legalább 6 betűs címeknél egy, a legalább 12 betűs címeknél legfeljebb két apró elírást is elfogad. A pontos találat előrébb kerül; az eltérő számok és koncert/remix/feldolgozás jelölések nem mosódnak össze. A Last.fm automatikus javítását is kérjük, de a visszakapott előadót továbbra is ellenőrizzük. A metaadatválasz korlátja 192-ről 256 KiB-ra nőtt, PSRAM-pufferben; a korlát elérése és a Last.fm hiányzó album-/képadat külön naplóüzenetet kap.

Az ismert hosszúságú, nem chunked HTTP(S)-válasz teljes beolvasása után az egyszer használatos kapcsolatot azonnal lezárjuk, így a keretrendszer lezáráskori utóolvasása nem okoz félrevezető TLS-hibát. A hiányos válasz továbbra is hiba; a chunked és ismeretlen hosszúságú válaszok feldolgozását az eddigi HTTPClient végzi. Az állomáslogók előtöltése, forrásválasztása, képfeldolgozása és az audio/spektrum kódja megmarad. Ehhez a keresési és kapcsolatlezárási javításhoz csak firmware-feltöltés szükséges, a legutóbbi data megtartásával.

Az albumkeresés feldolgozott JSON-dokumentumai is kizárólag PSRAM-ot használnak, 512 KiB-os dokumentumkerettel és 512 KiB külsőmemória-tartalékkal; nincs visszaesés a belső RAM-ra. Ez megakadályozza, hogy egy sok kiadást tartalmazó MusicBrainz-válasz apró memóriafoglalásai elvegyék a fájlműveletek és az audio rendszerzárainak belső memóriáját. A MusicBrainz-szűrő megtartja a találat- és albumellenőrzés összes használt mezőjét, az Archive-metaadatból pedig csak a fájlkiszolgálók adatait olvassuk be. Memóriahiánynál a részleges dokumentum felszabadul és a keresés a meglévő tartalék útvonalon folytatódik. Nagy válasznál a JSON memory sor mutatja a belső memória előtte/utána értékét. Ehhez a javításhoz csak firmware-feltöltés kell; a data és a spektrum változatlan.

MusicBrainz HTTP 503 után az adott dal keresésében azonnal a következő szolgáltatóra lépünk. A további MusicBrainz-kérések, így a Last.fm albumazonosítójának ellenőrzése is a kör végére kerül. Ha addig nincs letöltött saját albumborító és maradt idő, legfeljebb egy MusicBrainz API-kérést ismétlünk; a Last.fm-től kapott albumazonosító elsőbbséget kap a célzott ellenőrzéshez. Sikeres másik forrásnál nincs újrapróbálás. Nincs időalapú pihentetés: minden új dal eredeti sorrenddel indul. A 35 másodperces keresési keret, a képletöltési tartalék, az 1,1 másodperces MusicBrainz-kérésköz és a számváltáskori megszakítás megmarad.

A teljes cím egyezése és az apró elírások után külön alcímes egyezést is vizsgálunk: az egyik félről hiányzó, zárójelezett alcím megengedett azonos előadó és főcím mellett (például Diamond Eyes / Diamond Eyes (Boom-Lay Boom-Lay Boom)). Ehhez ellenőrzött saját nagylemez szükséges. A teljes zárójeles rész ellenőrzése megelőzi az elhagyását; a későbbi vagy beágyazott live/remix/demo/karaoke/instrumental jelölések, eltérő előadók és különböző kifejezett alcímek továbbra sem fogadhatók el ezen az úton. Soros jelzés: subtitle match, MusicBrainz HTTP 503: deferred és MusicBrainz retry. A változás firmware-frissítést igényel; a data nem változott.

## Képernyőképek

### LCD működés közben

| Lejátszó | Lejátszó logóval |
| --- | --- |
| ![LCD lejátszó](.screenshots/lcd/player1.jpg) | ![LCD lejátszó logóval](.screenshots/lcd/player2.jpg) |
| Állomásválasztó | Hangerő |
| ![LCD állomásválasztó](.screenshots/lcd/station_picker.jpg) | ![LCD hangerőnézet](.screenshots/lcd/volume.jpg) |

### Webes felület

| Lejátszó | Állomások |
| --- | --- |
| ![Lejátszó oldal](.screenshots/player.png) | ![Állomások oldal](.screenshots/stations.png) |
| Hang | Kijelző |
| ![Hang oldal](.screenshots/sound.png) | ![Kijelző oldal](.screenshots/display.png) |
| Vezérlés | Távirányító |
| ![Vezérlés oldal](.screenshots/controls.png) | ![Távirányító oldal](.screenshots/ir.png) |
| Rendszer | |
| ![Rendszer oldal](.screenshots/system.png) | |

## Projekt felépítése

```text
data/             Webes felület, nyelvek, alapállomások és WiFi oldal
home-assistant/   Lovelace kártya és Home Assistant beállítás
src/              Firmware: audio, kijelző, bemenetek, MQTT, állomások és webserver
tools/            Build segédprogramok
```

## Licenc

A SimpleRadio [GNU GPL v3](LICENSE) licenc alatt jelenik meg. A közvetlen függőségek a saját licencük alatt maradnak; lásd a [harmadik féltől származó megjegyzéseket](THIRD_PARTY_NOTICES.md).
