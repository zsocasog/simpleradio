# Webes képek terhelésének csökkentése

Kiindulás: `53da02b`, `logo_test`, **1.2.09**. A verzió és a könyvtárak változatlanok.

## Működés

- Az állomáslogó böngészős 150 × 150-es PNG-előkészítése megmaradt. A nulla azonosítójú állomásnál is működik a feltöltés; ezt korábban egy logikai ellenőrzés tévesen kihagyta.
- A már letöltött, legfeljebb 32 KiB-os, megfelelő PNG/JPEG a kész LCD-kép mellett megmaradhat. A HTTP-válasz ezeket a bájtokat továbbítja; nem alakítja őket újra képpé. A meglévő, családokat együtt kezelő gyorsítótár-korlát és törlési rend vonatkozik rájuk is.
- Nagy, hibás vagy hiányzó tömörített kép esetén a korábbi LCD/BMP út marad a tartalék. Az `lcd=1` paraméterrel ez külön is ellenőrizhető. A böngésző dekódolási hibája is erre léphet tovább.
- A fejléc, a lejátszó és a két állomáslista azonos logóhoz azonos kép-URL-t használ. A helyi képek közös betöltési sora lejátszás közben egy, álló lejátszónál két új kérést enged be. A közvetlen külső képek ezt a sort megkerülik; az albumborítók meglévő RAM-útvonala megmaradt.
- A betöltési határidő a kérés indításakor kezdődik. A sorban váró képek nem járnak le; eltűnt listaelemekhez nem indul felesleges kérés. A folyamatban levő kérések közösek, a kész eredmények gyűjteménye korlátozott.
- A tömörített képek és a BMP-k külön ellenőrző azonosítót kapnak. A tényleges fájlcsere idején nem adunk érvényes ellenőrzőt; azonos nevű logó lecserélése után az új kép töltődik be.

Nincs új képdekóder, teljes HTTP-képpuffer vagy munkafeladat. Az albumkereséshez továbbra sem történik új flash-írás.

A normál firmware állandó RAM-foglalása **104 396 → 104 412 B**, azaz +16 bájt a statisztikai pillanatképekhez. A csak mérésre használt, hibafoglalást megőrző változat többletét ez nem tartalmazza.

## Valódi böngésző

Elkülönített, üres Chrome-profillal, némított FLAC-lejátszás mellett; lejátszó → állomások → lejátszó. A 12 logó a két hatos listát jelenti. Ugyanazt a 12 másodperces kezdeti megfigyelési ablakot használtuk.

| Megfigyelés | Előtte | Új webfelület |
|---|---:|---:|
| Betöltött listalogó | 4 / 12 | 12 / 12 |
| Egyidejű helyi logókérések csúcsa | 7 | 2 |
| Hibás/megszakadt helyi logókérés | 7 | 0 |

Az első állapotüzenet előtt még az álló lejátszó két kéréses korlátja érvényes. Az új felületnél a végső ellenőrzéskor sem maradt félkész képkérés vagy JavaScript-kivétel. A kiinduló letöltések hiányosak voltak, ezért azok bájtszámából nem számolunk százalékos megtakarítást.

## A kezdőoldal betöltése

A normál firmware üres Chrome-profillal végzett későbbi próbája még a logókezelő elindulása előtt elakadt: több párhuzamos JavaScript/CSS-letöltés befejezetlen maradt. Ezt a próbát nem tekintjük sikeres böngészős ellenőrzésnek. A mérőprogram végén indított külön, nagy JavaScript-letöltést is elhagytuk: a már letöltött tartalmat azóta a böngészőből ellenőrizzük.

A buildgép most előre elkészíti a tíz felső szintű JavaScript/CSS-fájl gzip-változatát. Az ESP a rögzített webszerver meglévő gzip-támogatásával változatlanul küldi ezeket; a böngésző végzi a kibontást. **300 559 → 80 926 B** a fájlok összesített adattartalma. A forrásfájlok megmaradnak, a tömörítés időbélyege rögzített, a build a kiválasztott nyelv másolása után készíti el őket. A képeket, konfigurációt és API-válaszokat ez nem tömöríti. A generált fájlok nem kerülnek Gitbe; a firmware/data build újra előállítja őket.

Az így frissített adatcsomaggal és a normál `6b65935c0` firmware-rel, új üres Chrome-profilból, némított FLAC alatt a 12 másodperces ellenőrzéskor már mind a 12 logó megjelent. A nézetváltások után is 12/12 maradt; nem volt félkész logókérés, hibás logóletöltés vagy JavaScript-kivétel. Az egyidejű helyi logókérések csúcsa 2 volt. A böngésző által ténylegesen letöltött és kibontott `app.js` SHA256-a megegyezett a helyi forrással.

A normál végpontokon a hat meglévő logó együttes teljes adattartalma **100 637 B**, a hozzájuk tartozó LCD/BMP-változatoké **372 108 B**: ebben a konkrét összevetésben körülbelül 73%-kal kevesebb kép-adatot továbbítunk. Ez a végpontok bájtösszege, nem a teljes weboldal vagy a memória százalékos gyorsulása.

## Terhelés közben megtalált régebbi hívási útvonal

A friss logók ismételt feltöltésével és hat párhuzamos képkéréssel sikerült újraindulást előidézni. A kizárólag mérési firmware-be épített, újraindulást túlélő feljegyzés megőrizte a sikertelen foglalás hívási láncát:

`/api/system/status` → `systemStatusJson` → `ArtworkCache::cacheBytes` → `openNextFile` → `fopen` → newlib fájlmutex → sikertelen **92 bájtos belső memóriafoglalás**.

Egy következő ismétlés ugyanezt a 92 bájtos sikertelen mutexfoglalást a `station-save` feladatban, a `removeOldStationLogoUploads` → `openNextFile` útvonalon rögzítette. Az állapotlekérés és a régi logók takarítása tehát egyaránt megnyitotta az összes bejárt képet. A gyorsítótár méretszámolása, családtörlése, költségkeret szerinti bejárása és a régi feltöltött logók felsorolása most közös, kizárólag könyvtármetaadatot olvasó bejárást használ. A könyvtárnyitás hibája visszaadható.

A pusztán metaadatot olvasó teljes bejárás is túl hosszú lehet a nagy prioritású HTTP-kiszolgálóban. Ezért az állapotvégpont már nem számol fájlrendszeri méreteket: atomikusan olvassa a legutóbb elkészült összesítést. Az összesítés induláskor, majd a meglévő képmunkás fájlrendszert érintő munkái után frissül, a munkás foglaltsági idején belül. Nincs külön időzített feladat vagy új statisztikai munkasor. Az albumborító RAM-keresése és a kis állomásválasztó RAM-logói nem indítanak ilyen számlálást. A teljes és a foglalt tárhelyet is innen olvassuk; a rögzített LittleFS-könyvtár mindkét eredeti függvénye újra meghívja a foglaltság számolását.

A tárhelyadat utolsó összesítés, nem folyamatosan frissített érték. Korát a `filesystem.artworkCacheStatsAgeMs` mutatja. Egy képmunka nélküli konfigurációmentés vagy törlés után a következő ilyen összesítésig a korábbi méret látszódhat. A gyorsítótár tényleges helyfoglalási és törlési döntései továbbra is a friss fájlrendszeri adatokkal dolgoznak; a kijelzett pillanatképet nem használják tárhelyengedélyezésre.

A mérési nyomkövetés alapból kikapcsolt. Nem ír új naplófolyamot vagy flash-fájlt, nem hoz létre feladatot. A sikertelen foglalásnál rögzített címek csak a hozzá tartozó, megőrzött ELF-fel értelmezhetők. A szándékos OTA-újraindulás előző feljegyzése önmagában nem újabb összeomlás.

## Ellenőrzés és korlátok

- A külön logócsere-próba ugyanarra a fájlnévre két eltérő PNG-t tölt fel. Mindkettőnél ellenőrzi az eredeti PNG-bájtokat, a megváltozott LCD-képet, az új ellenőrző azonosítót és az üres 304-es ismételt választ.
- A `cold-logos` profil hat egymást követő új állomásmentést, valóban új URL-ről érkező logót, PNG-feltöltést, hozzárendelést és törlést végez FLAC-lejátszás közben. A normál teljes forgatókönyv is futásonként új logó-URL-t használ; korábban a változatlan tesztcím meleg gyorsítótárat is vizsgálhatott.
- A metaadat-számlálás javítása utáni ismételt hatos hideglogó-próba 285 HTTP-kéréssel, 51 állapotmintával, 47 stabil hangmérési mintával végigment. Nem volt HTTP-hiba vagy újraindulás; az állomáslista, a beállítások és a lejátszó állapota visszaállt.
- Ezt megelőzően a javított számlálóval is volt egy üres, 200-as állomásmentési válasz miatti megszakított próba. Ezt nem soroljuk a sikeres futásokhoz. Az ismételt futás sikere önmagában nem bizonyítja ennek minden körülmény közötti megszűnését.
- A hatos terhelésnél a digitális hangutánpótlás késése továbbra is megfigyelhető. A némított mérés nem hallgatási teszt; nem jelent teljes akadásmentességi vagy termékminősítési igazolást. A kevesebb böngészős kérésből nem következik automatikusan minden ritka memóriahelyzet megoldása.

## Végleges forrással végzett készülékes próbák

A két feltárt könyvtárbejárási útvonal javítása és a statisztika háttérbe helyezése után, `f7e2ab753` mérési builddel:

| Próba | Idő | HTTP-kérés | Stabil hangminta | HTTP-hiba / újraindulás |
|---|---:|---:|---:|---:|
| Teljes vegyes használat, hat párhuzamos kép | 325,5 s | 1299 | 246 | 0 / 0 |
| Hat egymást követő valóban új logó mentése | 97,6 s | 340 | 69 | 0 / 0 |

Mindkét körben sikerült visszaállítani és ellenőrizni az eredeti listát, beállításokat és lejátszóállapotot. A teljes kör 290 állapotmintája között 17 100 B volt a legkisebb észlelt belső szabad memória; a hideglogó-sorozatban 8964 B. Ezek minták, nem folyamatos minimumok.

A teljes kör rendszerállapot-válaszainak mediánja **47 ms**. Az előző, még HTTP-feladatban tárhelyet számoló próbák több száz milliszekundumos értékeihez képest ez egyértelmű javulás. A fájlrendszer tartalma és a rádióadás a sorozatok között változhatott; ez nem minden hálózatra érvényes sebességígéret.

A teljes végső körben 11 nyers hangutánpótlási figyelmeztetés maradt. A konzervatív digitális hiánybecslés a FLAC-alapmérés, képkérések, beállításmentések, WAV, MP3 és leállítás/újraindítás szakaszában nulla lett. Új logó/állomás mentésénél 1494,7 ms, gyors váltások után 1553,8 ms összegzett becsült hiány maradt a vizsgált stabil időablakokban. Ez további javítandó terület; nem állítunk teljes hangfolytonosságot.

A normál firmware és az új adatcsomag ellenőrzésekor az eredeti hat állomás, a teljes konfiguráció és mindkét eredeti feltöltött logó bájtra pontosan megmaradt. A kibontott webes fájlok megegyeztek a forrással. A mérési végpont a normál firmware-ben hiányzik. Az azonos fájlnevű logó lecserélésének külön készülékes próbája is sikerült. A kódellenőrzések: 560 sikeres Node-teszt és 56 sikeres Python/C++-ellenőrzés; a firmware és a LittleFS build is sikeres.

A mérés részletes nyers anyagai a helyi, verziókezelésből kizárt `.pio/web-offload-*` könyvtárakban vannak; személyes állomás- és konfigurációmentéseket nem publikálunk.

A megmaradt lejátszás közbeni LCD-logóírás vizsgálatának és a korlátos PSRAM-képtárnak külön [mérési jegyzete](lcd-logo-memory-performance-2026-11-11.hu.md) készült. Ez az itt közölt korábbi kontrolleredmények folytatása.
