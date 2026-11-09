# Ismételhető terheléses mérés

A cél az egyszerre történő felhasználói műveletek és a megtorpanások időbeli összekapcsolása. A teszt nem optimalizál és nem frissít könyvtárat. A normál firmware-ben a mérés alapból ki van kapcsolva.

## Mit futtat?

A `tools/stress_radio.py` a rádió tényleges HTTP/WebSocket felületét vezérli. Nincs helyettesített ESP a készülékes próbában. A véletlen képkérések sorrendjét a `--seed` rögzíti.

1. Álló rádió, majd FLAC lejátszás: alapmérés terhelés nélkül.
2. Legfeljebb néhány párhuzamos kép-, állomáslista- és rendszerkérés; webes fájlok teljes letöltése.
3. Fényerőmentések, EQ és balansz módosítása lejátszás és képkérések közben.
4. Új ideiglenes állomás mentése, logó feltöltése és hozzárendelése, állomás áthelyezése.
5. Gyors A/B váltássorozat, képbetöltés kivárása nélkül.
6. Opcionális helyi, pontosan megismételhető WAV-forrás; kiszámítható PNG és lassított képkiszolgálás.
7. MP3 és vegyes használat, kijelző inverziója, VU/spektrum váltás, online keresés.
8. Leállítás, újraindítás, utómegfigyelés és a kiinduló beállítások ellenőrzött visszaállítása.

Az online keresés a valódi webfelületben is a böngésző és a Radio Browser között történik. A teszt ezt a gépről végzi, külön méri, nem könyveli az ESP válaszidejének. A találati lista DOM-ja és a böngésző képfeldolgozása nincs automatizálva ebben a tesztben. A FLAC/MP3 felirat a kiválasztási szándék; a tényleges dekóder neve az állapotmintákban szerepel, ezért ellenőrizhető a lefedettség.

## Mit mér, és mit nem bizonyít?

| Jel | Jelentés |
|---|---|
| HTTP teljes idő, első bájt ideje, bájtszám | A hálózati válasz ténylegesen elkészült-e; BMP méret és képadat ellenőrzése is történik. |
| Beállításválasz és `/config.json` visszaolvasás | A sikeres válasz után valóban a kért beállítás tárolódik-e. |
| WebSocket parancs visszaigazolása | A vezérlési állapot megváltozott; ez önmagában még nem az első megszólaló hang. |
| I2S kiküldött keretek | Halad-e a digitális hangóra; automatikusan beillesztett nulla is számít! |
| Elfogadott I2S-bájtok és beadási szünet | Kap-e a meghajtó új hangmintákat, és volt-e a teljes DMA-gyűrű játékidejénél hosszabb szünet. |
| I2S részleges írás / időtúllépés | Lehet normális visszanyomás; nem minősül automatikusan hanghibának. |
| Bemeneti puffer | Van-e tömörített adat, miközben a hangutánpótlás megakad. A bájtszám VBR/FLAC esetén nem állandó játékidő. |
| Audio pump időköz / futási idő | Beazonosíthatóvá teszi a kiszolgáló ciklus ritka hosszú futásait. |
| Aktuális belső RAM, legnagyobb blokk, PSRAM | Elkülöníti a fogyást és a töredezettséget. A minták közötti rövid mélypontot nem garantáltan látja. |
| Uptime, buildazonosító | Váratlan újraindítás vagy eltérő firmware felismerése. |
| Opcionális USB-napló | Szolgáltatói keresés, letöltés, képdekódolás és esetleges backtrace összekapcsolása a műveletekkel. |

A `feedDeadlineMisses` kockázati jel: legalább két másodperc indulási türelmi idő után az elfogadott I2S-írások szünete meghaladja a teljes DMA kapacitását + 10 ms-ot. A rögzített könyvtárban 32 × 256 keret, 44,1 kHz-en kb. 186 ms a gyűrű. Ez nem a spektrum mintavesztése, és nem tartalmat elemző hangkimaradás-számláló. Csatornaváltás és leállítás körül a jelentés nem minősíti stabil lejátszásnak az átmenetet.

A számlálók indulás óta összegződnek, nem nullázódnak HTTP-lekérésre. A jelentés különbségekkel dolgozik. A nyers maximális beadási szünet tartalmazhat szándékos leállítást is, ezért önmagában nem stabil lejátszási rekord. A digitális adategyenleg csak összefüggő stabil mintasorban hasonlítja a beadott és kiküldött sztereó Q31 kereteket; két teljes DMA-gyűrűt és az észlelt maximális írásidőt is levonja a hiány becslésénél. Ez erősebb utánpótlási jel, de továbbra sem külső hangfelvétel.

Némított mérésből nem bizonyítható a DAC, az erősítő vagy a hangszóró hibátlan működése. Ehhez később külső hangrögzítés vagy az I2S-jelek független rögzítése és az ismert mintával való összevetés szükséges. A fizikai encoder/IR, LCD képhűség, mobil böngészős görgetés, tápellátási hibák és OTA megszakítása külön tesztcsoport. Ezekre ez a mérés nem állít sikeres eredményt.

## Futtatás

Python 3 és `websockets` szükséges; USB-naplóhoz `pyserial`. A parancsokat a Git-repozitórium gyökeréből indítsd.

Csak megfigyelés, vezérlési műveletek nélkül:

```powershell
python tools/stress_radio.py --base http://192.168.0.213 --observe-seconds 60
```

Opt-in mérési firmware előkészítése, a normál projekt és annak függőségei módosítása nélkül:

```powershell
python tools/prepare_runtime_probe.py --out .pio/runtime-probe-project
python -m platformio run -d .pio/runtime-probe-project
```

A mérési firmware csak `SIMPLE_RADIO_RUNTIME_DIAGNOSTICS=1` mellett teszi elérhetővé a `/api/diagnostics` végpontot. Nincs új feladat, PCM-elemzés, periodikus diagnosztikai napló vagy diagnosztikai flash-írás. Az I2S-írás eredményét, adatait, határidejét és újrapróbálkozását a megfigyelés nem változtatja meg. A külön fordítás a már rögzített függőségeket használja, hash alapján ellenőrzött írásmegfigyelővel. Az előkészítő nem tölti fel a firmware-t.

Mérési firmware telepítése után, némított készülékes sorozat:

```powershell
python tools/stress_radio.py --base http://192.168.0.213 --exercise --mute --seed 20261109 --out .pio/stress/run-01
```

Helyi mintával: a gép LAN-címét kell megadni, nem `localhost`-ot. A rádiónak el kell érnie a megadott portot; a teszt nem módosít tűzfalszabályokat.

```powershell
python tools/stress_radio.py --exercise --mute --serve-fixture --fixture-url http://192.168.0.203:19840 --serial-port COM3 --out .pio/stress/run-02
```

A `--expect-build` azonosítja a pontos firmware-t. A `--scale` a várakozási szakaszok hosszát szorozza, a hálózati határidőket nem. Hosszabb próbához például `--scale 5`. Ha valamelyik elvárt lejátszási szakaszból nincs legalább két stabil hangmérési minta, az eredmény hiányos lefedettségű lesz. Hiányzó diagnosztika mellett nincs zöld hangminősítés.

Azonos hanganyaggal végzett összevetéshez a `--reference-file` egy hosszú helyi fájlt is elfogad:

```powershell
python tools/stress_radio.py --exercise --mute --profile isolation --serve-fixture --fixture-url http://192.168.0.203:19840 --reference-file .pio/reference.ogg --expect-build AZONOSITO --out .pio/stress/controlled-01
```

A `.ogg` mintát `audio/ogg` típussal, `Content-Length` nélkül szolgálja ki, így a rádiófolyam-kezelési útvonalat használja. A benne lévő kodeket a tényleges eszközállapotból kell ellenőrizni: az Ogg csomagolás önmagában nem jelent FLAC-ot. A `.flac`, `.mp3`, `.wav` fájlok hosszal érkeznek, ezek a könyvtár webes fájlkezelési útvonalát vizsgálják. A saját determinisztikus mintánk nem azonos összetettségű minden élő rádióadással.

A futás lementi a négy kliensprogramot és lenyomatukat, a seedet, a referenciaminta SHA256-át és a megfigyelt firmware-azonosítót. Két eredmény összevetése:

```powershell
python tools/compare_stress.py .pio/stress/before .pio/stress/after --out .pio/stress/comparison.json
```

A dekóder külön mérésében a futásközök, a teljes hívási idő és a külső feladatzárra várás szerepel. A teljes hívási időbe a más feladatok miatti megszakítás és a belső várakozás is beleszámít; ez nem tisztán CPU-idő. A megfigyelő nem olvassa ki külön az inputpuffer mutatóját módosító `readSpace()` függvényt.

Az `--profile isolation` külön FLAC-alapmérést, csak képkéréseket, terhelés utáni megnyugvást, csak mentéseket, majd a kettő együttfutását méri. Ezzel ellenőrizhető, hogy egy vegyes próba eredménye reprodukálható-e egyetlen terhelés hozzáadásával. A mentési kérés 20 másodperces megfigyelési határideje hosszabb a készülék 15 másodperces belső várakozásánál, így a rádió saját elutasítása is megkülönböztethető a kliens időtúllépésétől.

## Eredmények és helyreállítás

- `events.jsonl`: időbélyeges műveletek, válaszok, állapotminták, hibák. Már futás közben lemezre kerül.
- `summary.json`, `report.md`: szakaszonként p50/p95/p99/maximum válaszidők, mintavételezett memóriaminimumok, hangkockázatok és lefedettség.
- `recovery.json`: csak a módosított kijelzőmezők, lejátszóállapot, saját tesztprefix és eredeti állomáslista lenyomata; nincs jelszómentés.
- `serial.log`: opcionális nyers USB-napló. Tartalmazhat saját streamcímeket, ezért ne publikáld ellenőrzés nélkül.

A teszt megőrzi az eredeti állomásokat; csak a saját futási prefixével létrehozott új állomásokat törli. A visszaállítás ellenőrzi az eredeti lista tartalmát és sorrendjét, a kijelzőbeállítások perzisztenciáját és a lejátszóállapotot. A tesztcsatornák gyorsítótári fájljai maradhatnak a normál gyorsítótárban, azokat annak meglévő takarítása kezeli. Nem állítja vissza bájtról bájtra az egész fájlrendszert.

Ha a gépi tesztfolyamatot kényszerből bezártad, a naplóból újra végrehajtható a visszaállítás:

```powershell
python tools/stress_radio.py --exercise --mute --restore .pio/stress/run-02/recovery.json --out .pio/stress/recovery-02
```

A kényszerű áramtalanítást vagy megszakított hálózatot semmilyen `finally` nem tudja garantáltan helyreállítani; ezért készül előre a külön napló. Ha visszaállítás közben sem érhető el a rádió, a jelentés hibával zárul.

## Hogyan következzen ebből gyorsítás?

1. Ugyanazzal a firmware-rel, seed-del és azonos állomásokkal ismételjük a mérést. Külön futásban változzon a meleg/hideg gyorsítótár; a jelenlegi teszt nem törli a felhasználó cache-ét.
2. A külső szolgáltatói várakozást különítsük el az ESP saját CPU-idejétől és a webes mentés végrehajtásától. Egyidejű esemény önmagában még nem ok-okozati bizonyíték.
3. A korábbi Git-verziók összevetése azonos állomáslistát, webes adatcsomagot és cache-állapotot igényel. Egy régi kódvizsgálat vagy eltérő napi internetes keresés nem teljesítményteszt.
4. Egyszerre egy szűk változtatás következzen, majd ugyanez a mérés. Csak akkor gyorsítás, ha a válaszidő javulása mellett a hangutánpótlás, vezérlés, memória és visszaállítás sem romlik.
5. Végül hosszabb, több seed-del végzett sorozat és valódi böngészős/hardveres próba szükséges. Egyetlen rövid, hibamentes futás nem jelent teljes stabilitási garanciát.
