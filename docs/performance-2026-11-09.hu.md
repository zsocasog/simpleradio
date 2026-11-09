# Első mért teljesítményjavítás – 2026. november 9.

A fejlesztés előtti állapot a `logo_test` ágon, a `5071ac3` mentésben található. A verzió maradt 1.2.09; a függőségverziók nem változtak.

## Mi került a normál firmware-be?

Egy szűk FLAC-javítás: a bitolvasó 33 elemű, változatlan maszktáblázata automatikus helyi tömb helyett `static const` tömb lett. A rögzített S3 fordítás eredetileg **minden bitolvasáskor 132 bájtot másolt** a veremre. Az új fordításból ez a másolás hiányzik; a függvény veremkerete 192-ről 32 bájtra csökkent.

- A táblázat értékei és a teljes bitolvasási algoritmus változatlanok. A javítóprogram a rögzített függvény egészét SHA256 alapján ellenőrzi, és ismeretlen kód esetén leáll.
- Nincs új memóriafoglalás vagy háttérfeladat. A normál fordítás statikus RAM-foglalása változatlanul 104 380 bájt; a programméret 48 bájttal nőtt.
- A prioritások, processzormag-kiosztás, hangpufferek, hangerő, spektrum, képletöltés és mentés működését ez a javítás nem állítja át.
- A részletes dekódermegfigyelés kizárólag az alapból kikapcsolt mérőfordításban van jelen.

Megvalósítás: `tools/patch_audio_flac.py`, a `platformio.ini` fordítási lépésével. Négy célzott teszt ellenőrzi az egyetlen tárolási módosítást, a változatlan értékeket, az ismételhetőséget és az ismeretlen forrás elutasítását.

## Elvetett próbák

Külön mérőfordításokban kipróbáltuk az AsyncTCP prioritásának csökkentését, illetve a kiszolgálófeladat 1. maghoz kötését. Az élő FLAC-próbákban mindkettő rosszabb hangutánpótlási eredményt adott. Ezek **nem kerültek be** a normál kódba; a könyvtár eredeti ütemezése megmaradt.

Az inputpuffer nem ürült ki tartósan, és a dekóder külső feladatzárra várása nagyságrenddel rövidebb volt a hosszú hívásoknál. A teljes dekóderhívás ideje viszont elérte/meghaladta a körülbelül 186 ms-os teljes DMA-tartalékot. Ez irányította a vizsgálatot a dekóder fölösleges munkájára. A hívási idő tartalmazza a megszakításokat és belső várakozásokat is, ezért nem tekintjük tiszta CPU-időnek.

## Azonos Ogg/FLAC-mintás összevetés

Mindkét futás ugyanazt a saját generált, 600 másodperces, 44,1 kHz-es sztereó Ogg/FLAC-fájlt kapta ugyanazzal a klienskóddal és seeddel. Az Ogg-minta `Content-Length` nélkül érkezett, a készülék tényleges kodekje FLAC volt. A sima `.flac` fájl korábbi próbája a könyvtár másik, webes fájlkezelési útvonalát használta; azt nem tekintjük azonos rádiófolyam-tesztnek.

| Mérőszám | Kiinduló | Gyorsított |
|---|---:|---:|
| Fordításazonosító | `d0a943fa0` | `d4f02b15c` |
| Futás | 148,4 s | 148,1 s |
| HTTP-kérések | 368 | 371 |
| Stabil hangmérési minták | 110 | 109 |
| Váratlan újraindulás / I2S írási hiba | 0 / 0 | 0 / 0 |
| Hangutánpótlási figyelmeztetés | 0 | 0 |
| Konzervatív digitális hiánybecslés, minden szakasz | 0 ms | 0 ms |
| Leghosszabb megfigyelt betöltési szünet | 180,6 ms | 150,5 ms |
| Leghosszabb teljes dekóderhívás | 155,5 ms | 151,4 ms |
| Mintavételezett legkisebb belső szabad memória | 13 644 B | 19 876 B |
| Állomáslista és beállítások visszaállítása | ellenőrizve | ellenőrizve |

A csak képes szakasz képkéréseinek p95 ideje 719-ről 578 ms-ra csökkent, a képes és mentéses közös szakaszé viszont 578-ról 750 ms-ra nőtt. Ugyanott a három mentés mediánja 625-ről 328 ms-ra csökkent. **Egyetlen ilyen párból nem következik általános webes gyorsulás vagy garantált késleltetési határ.** A kiinduló mintás próba egy részében a számítógépen firmware-fordítás is futott; a válaszidők összevetése ezért különösen óvatosan értelmezendő.

Helyi nyers eredmények és összevetés: `.pio/performance-D-localOgg-20261109`, `.pio/performance-E-localOgg-20261109`, `.pio/performance-flac-table-local-compare.json`.

## Élő adásos ellenőrzés

A részletes kiinduló FLAC-próba 40, az új változat 3 utánpótlási figyelmeztetést adott. A csak képes terhelés konzervatív hiánybecslése 798,4-ről 71,6 ms-ra, a vegyes szakaszé 894,8-ról 176,1 ms-ra csökkent. Mindkettőnél nulla újraindulás és nulla I2S írási hiba volt.

Ez biztató jelzés, **nem szabályos, azonos hanganyagos sebességmérés**: különböző adásszakaszok szóltak, és a kliens referenciaminta-kezelése is bővült a két futás között. Az új verziónál is maradt utánpótlási kockázat. Némított mérésből pontos hallható kihagyást nem állítunk.

Helyi eredmények: `.pio/performance-D-decoder-detail-20261109`, `.pio/performance-E-flac-table-20261109`, `.pio/performance-flac-table-live-compare.json`.

## Teljes vegyes használati ellenőrzés

A gyorsított mérőverzió 329,9 másodperces próbája: **1000 sikeres HTTP-művelet, nulla sikertelen válasz, nulla váratlan újraindulás, nulla I2S írási hiba**. A kliens ellenőrizte a képek teljességét és a beállítások tényleges tárolását is. 242 állapotminta, ebből 206 stabil lejátszási hangminta készült.

Lefutott az új állomás mentése lejátszás közben, saját logó feltöltése és hozzárendelése, állomás átrendezése, hat gyors váltás, online keresés, fényerő/inverz kijelző/VU/spektrum módosítás, hangbeállítás, helyi WAV, MP3, élő FLAC és leállítás/újraindítás. Ez API-s használati próba: valódi böngészőrajzolást, fizikai encodert és IR-t nem vizsgál.

A mintavételezett belső szabad memória minimuma 15 468 bájt, a legnagyobb szabad blokk minimuma 5620 bájt volt. A normál háttérmunka és az élő adások eltérései miatt ezt nem tulajdonítjuk automatikusan a táblázat módosításának.

Az eredmény továbbra is `OBSERVED_WITH_RISKS`: három futás közbeni DMA-határidő-kockázat jelentkezett. A konzervatív digitális hiánybecslés a képes FLAC-szakaszban 669,0 ms, a beállításos szakaszban 227,8 ms, az új állomásos szakaszban 193,0 ms, a váltások utáni szakaszban 97,2 ms volt. A helyi WAV, a későbbi MP3-vegyes és a leállítás/újraindítás szakaszában a becslés nulla. Ezek nem mért hallható kihagyáshosszak; a sorozat némítva futott.

A teljes eredeti állomáslista/sorrend, konfiguráció és vezérlési állapot visszaállítását a kliens ellenőrizte. Helyi részletek: `.pio/performance-E-extreme-20261109/report.md`, mellette a nyers `events.jsonl`.

## Fordítások és regressziós ellenőrzések

- 507 JavaScript-teszt sikeres, a Home Assistant-kártya 32 tesztjével együtt.
- 47 Python-teszt sikeres, köztük a FLAC-javítás és a hálózat nélkül is ellenőrizhető mérési tesztek.
- Normál firmware- és LittleFS-fordítás sikeres; JavaScript-szintaxis és diff-ellenőrzés sikeres.
- A végleges normál firmware azonosítója `a490f31b9`, verziója 1.2.09. Az ELF-ben nincs aktív `RuntimeProbe` mérőkód.
- A normál firmware OTA-n felkerült a rádióra. Utána a teljes konfiguráció, a hat eredeti állomás és a WebSocket-vezérlési állapot egyezését külön is ellenőriztük; a készülék némítva, leállítva maradt.
- Az OTA-hoz használható normál csomagok és SHA256-lenyomataik helyben: `.pio/verified-artifacts/performance-flac-20261109`. A meglévő data tartalma nem változott.

## További vizsgálati irány

A mentés és a képkiszolgálás általános sebességromlásának oka ezzel nincs teljesen megoldva. A következő külön lépés a sorban állási idő, hálózati háttérmunka leállítása és a tényleges flash-írás mérése, valamint a képkiszolgálás terhelésének csökkentése lehet. Az egy héttel korábbi állapothoz képesti pontos különbséghez továbbra is azonos körülmények közötti külön összevetés szükséges.
