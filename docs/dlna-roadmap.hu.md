# SimpleRadio DLNA – kutatás és ellenőrizhető fejlesztési ütemterv

Dátum: 2026. november 9.  
Kiindulás: `logo_test`, `488afd0`, SimpleRadio 1.2.09.  
Állapot: kutatás és tervezet. DLNA-programkód nem készült, a készüléken ebben a körben nem változtattunk semmit.

## 1. Az elérendő használat

- Rádió és Médiatár / DLNA forrásválasztó.
- A NAS vagy a Windows gép DLNA-médiatárának böngészése a weben és az LCD-n.
- Egy vagy több szám, illetve egy vagy több mappa hozzáadása a lejátszási sorhoz.
- Önálló használat egyetlen encoderrel; ugyanazok a műveletek távirányítóval és weben is.
- A SimpleRadio jelenlegi témái, képei, lejátszónézete, hangerőkezelése, VU-ja és spektruma megmaradnak.
- A böngészés, a mappák hozzáadása és a képek betöltése közben is lehessen vezérelni a lejátszást.
- A korábbi funkciók működését minden kis fejlesztési lépés után külön ellenőrizzük.

A saját NAS: **Synology DS220+**. A felhasználó tudomása szerint van rajta médiaszerver; a telepített DSM- és csomagverzió, illetve a DLNA engedélyezése még helyben ellenőrizendő. A [Synology hivatalos Media Server csomagja](https://www.synology.com/en-af/dsm/packages/MediaServer) felsorolja a DS220+-t a támogatott modellek között.

DLNA-hoz a NAS-on vagy a Windows gépen DLNA/UPnP-médiaszervernek is futnia kell. A közzétett médiatárat látjuk majd: ez lehet mappanézet, előadó-, album- vagy műfajnézet, és nem feltétlenül azonos a NAS teljes fájlrendszerével. Windowsos második próbaszervernek például a [Universal Media Server](https://www.universalmediaserver.com/download/) használható. Jellyfin esetén a [hivatalos DLNA-bővítményt](https://jellyfin.org/docs/general/post-install/networking/dlna/) külön telepíteni kell.

Synologyn a [Media Server által közzétett zenemappákat az indexelés határozza meg](https://kb.synology.com/en-global/DSM/tutorial/how_to_stream_videos_stored_on_Synology_NAS). A 0. lépésben ellenőrizzük, hogy a csomag fut, a próbaanyagok indexelve vannak, és a médiaszerver az új DLNA-eszköznek enged hozzáférést. Audio Station jelenlétéből önmagában nem következtetünk a Media Server beállításaira. Nem szükséges most NAS- vagy DSM-frissítést indítani.

## 2. Pontosan milyen DLNA-funkció kell?

A kutatásnál különválasztottam a szerepeket:

| Szerep | Mit csinál? | A mi tervünkben |
|---|---|---|
| Médiaszerver | Közzéteszi a zenéket és a médiatárat. | A NAS vagy a számítógép feladata. |
| Böngésző / vezérlő | Megtalálja a szervert, lekéri a mappákat, kiválasztja a számokat. | Ezt a SimpleRadio valósítja meg. |
| Önálló lejátszó | Letölti és megszólaltatja a kiválasztott számot. | A meglévő SimpleRadio hanglejátszó végzi. |
| Telefonról vezérelhető DLNA-renderer | Egy másik alkalmazás küld neki lejátszandó zenét és parancsokat. | Hasznos későbbi kiegészítés; külön fejlesztési lépés. |

A telefonról fogadott DLNA-lejátszás önmagában nem ad önálló NAS-böngészést és saját lejátszási sort. A protokollban a ContentDirectory szolgáltatás biztosítja a böngészést és a lapozást; a renderer vezérlése más szolgáltatások feladata. Lásd a [UPnP ContentDirectory specifikációt, Browse művelet, 2.5.7. szakasz](https://www.upnp.org/specs/av/UPnP-av-ContentDirectory-v4-Service-20101231.pdf), illetve a [StreamCore32 renderer-leírását](https://github.com/tobiasguyer/StreamCore32/blob/main/components/sc_dlna/README.md).

## 3. Mit csinálnak más projektek?

Az alábbiak a most elolvasott dokumentációból és forráskódból származnak. Ezeket a projektekhez tartozó fizikai készülékeken nem próbáltam ki.

| Projekt | Ellenőrzött megoldás | Tanulság a SimpleRadio számára |
|---|---|---|
| [ESP32-MiniWebRadio](https://github.com/schreibfaul1/ESP32-MiniWebRadio) | Webes DLNA-lejátszás, önálló DLNA-kliens, lapozott böngészés. Közeli referencia az audioI2S miatt. | Érdemes tanulmányozni a meglévő dekóderhez kapcsolódást. A teljes projekt átvétele sok más alrendszert is érintene. |
| [yoRadio-Fusion](https://github.com/SimZs/yoRadio-Fusion/blob/main/DLNA%20setup/readme.md) | Dokumentált Build/Append, aszinkron sorkészítés, 200-as oldalak, egymástól független rádiós és DLNA-lista. A beállítási leírás szerver-IP-t és kezdőmappa-azonosítót kér. | A két forrás állapotának megőrzése és a sor bővítése jó minta. Nálunk cél az automatikus szerverkeresés és a több mappára is használható kezelés. |
| [jRadio](https://github.com/jmper-ha/jradio/blob/main/doc/dlna.en.md) | Automatikus felderítés, web és encoder, szerveres címadatok és borító, következő szám a mappából. Dokumentált korlát: mappánként az első 64 sor; nincs szerveren keresés és számon belüli tekerés. | Az egyszerű encoderes navigáció jó referencia. Nálunk a nagy mappák lapozását és a több mappából épülő sort is meg kell oldani. |
| [ESP32MediaBox](https://github.com/mikedeblin/ESP32MediaBox) | Egy audiofeladat kezeli a lejátszót, parancssoron keresztül; külön hálózati feltöltés és 256 KB PSRAM-puffer. DLNA albumArtURI, encoderes böngészés, dokumentált Synology-próba. | A lejátszó egyértelmű tulajdonosa és a korlátozott pufferelés fontos minta. A saját dekóderük/pipeline-juk átvétele nálunk felesleges kockázat. |
| [ESP32-Webradio-PlusDLNA](https://github.com/yellobyte/ESP32-Webradio-PlusDLNA) | SoapESP32, encoderes szerver- és mappaböngészés, ismétlés, VS1053 hardveres dekóder. A webes DLNA-böngészés a README teendőlistáján szerepel. | A kevés gombos kezelés és a médiaszerverek eltérései jó referenciák. A VS1053-ra épülő hangutat nem vesszük át. |
| [StreamCore32](https://github.com/tobiasguyer/StreamCore32) | Több forrás, központi AudioControl, DLNA-renderer. Külön [PC-s protokoll- és HTTP-próbakészletet](https://github.com/tobiasguyer/StreamCore32/blob/main/tools/dlna_test/README.md) ad valódi vezérlőklienssel és mesterséges hibákkal. | Követendő a protokollteszt, a HTTP-teszt és a készülékteszt külön kezelése. A renderer később épülhet a mi forráskezelésünkre. |

Fontos: az automatikus keresés, a webes böngészés és az encoderes vezérlés már létező megoldások. A mi többletünk célja ezek együttese, a részletes sorépítés és a kiszámítható működés a SimpleRadio meglévő kezelőfelületeivel. Nem állítom, hogy ezek a funkciók a világon egyedülállóak.

### Könyvtárválasztás: előbb kis próba

Három lehetséges kiindulást vizsgáltam:

- **[SoapESP32](https://github.com/yellobyte/SoapESP32):** sok médiaszerverrel dokumentált kompatibilitás, lapozás, keresési képességek lekérdezése. A `seekServer()` és a `browseServer()` szinkron hívás; az alap keresési idő 60 másodperc. A megvizsgált `soapObject_t` nem ad külön albumArtURI-mezőt. Közvetlen UI-hívásként így nem megfelelő; adapter és a szükséges kiegészítések vizsgálata kell.
- **[MiniWebRadio DLNAClient](https://github.com/schreibfaul1/ESP32-MiniWebRadio/blob/master/lib/dlna_client/DLNAClient.h):** külön `loop()`-os állapotgép és lapozás. A [forrásban](https://github.com/schreibfaul1/ESP32-MiniWebRadio/blob/master/lib/dlna_client/DLNAClient.cpp) egy állapot feldolgozása több várakozó hálózati műveletet is meghív; a fejlécben 25 másodperces válaszvárás is szerepel. A callback vagy a `loop()` elnevezés önmagában nem bizonyítja, hogy a felület soha nem blokkol.
- **[arduino-dlna](https://github.com/pschatzmann/arduino-dlna):** kínál külön médiaszerver-vezérlőt, lapozott Browse/Search hívásokat és XML-visszahívást. A [vizsgált osztály](https://github.com/pschatzmann/arduino-dlna/blob/main/src/dlna/clients/DLNAControlPointMediaServer.h) dokumentációja szintén szinkron metódusokat jelez. A kisebb saját adapterhez való illeszkedést külön meg kell mérni.

**Javaslat:** a DLNA a SimpleRadio saját, kicsi illesztőjén keresztül működjön. A hálózati/protokollréteget a kompatibilitási és memóriapróba eredménye alapján választjuk ki. A végleges könyvtárdöntést, új állandó háttérfeladatot és a meglévő könyvtárak frissítését most még nem rögzítjük. A függőségekhez pontos verzió/commit és az eredeti licenc-/szerzői információk tartozzanak.

## 4. Miben adhatunk többet?

1. **Böngészés közben is tovább szólhat a rádió.** A médiatár megnyitása és egy DLNA-s szám tényleges elindítása külön művelet.
2. **Több számból és több mappából is építhető közös sor.** Lejátszás most / Következőnek / Sor végére, később átrendezés, ismétlés és keverés.
3. **A web, az LCD és a távirányító ugyanazt a sort látja.** Egy másik kezelőfelület megnyitása nem hoz létre eltérő állapotot.
4. **Nagy mappák is böngészhetők.** Lapozás és korlátozott gyorsítótár; a teljes NAS tartalma nem kerül az ESP memóriájába.
5. **Megszakítható mappahozzáadás.** Látható haladás, azonnal elfogadott Mégse, a meglévő sor és a folyamatban lévő lejátszás megőrzése.
6. **Külön emlékezet a két forráshoz.** Utolsó rádióállomás, illetve utolsó médiaszerver/mappa/sor; a közös hangerő és hangbeállítások kiszámíthatóak maradnak.
7. **A NAS saját címadata és borítója az elsődleges.** Ha rendelkezésre áll, nem keresünk helyette egy hasonló című számhoz másik albumot.
8. **Érthető hibakezelés.** Külön állapot a keresésre, üres mappára, eltűnt szerverre és nem támogatott formátumra. Egy lassú borító nem akadályozhatja a számváltást.
9. **Kiszámítható helyreállás.** Eltűnt számnál vagy szervernél megmarad a sor, és világos az újrapróbálás/visszalépés lehetősége. A hiányzó elem helyett nem indul el észrevétlenül másik szám. A sorból eltávolítás nem töröl fájlt a NAS-ról.

Ezek tervezett tulajdonságok, nem elkészült vagy már igazolt képességek.

## 5. A saját kód vizsgálatának következményei

- Az audioI2S már külön kezelt hangutat ad. A DLNA is a jelenlegi dekódert és I2S-kimenetet használja; a spektrumhoz és VU-hoz szükséges minták ugyanarról a kimenetről érkeznek.
- Az `Audio::evt_eof` jelenleg nincs feldolgozva az alkalmazásban. Az audiofeladat a leállt hálózati lejátszót rádióként újracsatlakoztathatja. A szám vége, a szünet, a hálózati hiba és a Stop ezért külön kezelendő.
- A mai állapotmodell rádióállomás-központú. A DLNA címadatait nem írjuk bele a mentett állomásokba, és nem használjuk valamelyik állomást rejtett DLNA-sorként.
- A meglévő HTTP-foglaltságkezelés a rádiókapcsolatnak és a mentésnek ad elsőbbséget. A DLNA-böngészés nem futhat ennek megkerülésével, és a rádiós borítók sem éhezhetnek ki tartósan.
- A legutóbbi készülékes mérésben a belső RAM minimuma **4608 bájt** volt. Az akkor mért pillanatnyi értékek és a teljes PSRAM mennyisége nem helyettesítik ezt a minimumadatot. Új állandó feladatverem hozzáadása előtt külön memóriamérés szükséges.
- A PSRAM nem minden belső memóriafelhasználást vált ki. Az Espressif szerint a feladatok verme alapértelmezetten belső memóriába kerül, a külső memória flashműveleteknél is külön figyelmet igényel. [ESP-IDF 5.5, External RAM](https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32s3/api-guides/external-ram.html)

Az első mérés eldöntendő kérdése: elfér-e a protokollkezelés a meglévő ütemezés mellett, vagy szükséges és biztonságosan fenntartható-e egy kicsi kiegészítő feladat. Nem kerül be automatikusan új, nagy veremmel induló szál.

## 6. Megvalósítási szabályok

- A lejátszót kizárólag a kijelölt audiofeladat hívja. Webes, DLNA-s és IR-parancsok közös parancskezelésen jutnak el hozzá.
- A rádió és a DLNA megőrzi a saját kiválasztását. A forrásváltás nem törli a mentett állomásokat vagy a DLNA-sort.
- Minden aszinkron kéréshez tartozik azonosító. A régi mappa-, metaadat- vagy borítóválasz nem módosíthatja az új kiválasztást.
- Hálózati várakozás és teljes XML-feldolgozás nem futhat a webes kéréskezelőben vagy az LCD/encoder útvonalán.
- A lista és a sor PSRAM-keretet kap, darabszám- és bájtlimittel. A tényleges határokat mérés véglegesíti. Kiinduló próbaérték: 50 elem/oldal, legfeljebb 500 sorbejegyzés és 512 KiB sormemória; ez nem az összes böngészhető fájl korlátja.
- Almappák bejárásakor mélység- és munkakeret, valamint ismételten meglátogatott objektumok felismerése szükséges. A virtuális mappák hivatkozásai nem okozhatnak végtelen bejárást. A limit elérését jelezzük, nem hagyjuk el észrevétlenül a sor végét.
- Albumoknál a rendelkezésre álló lemez-/sorszámot és a szerver rendezési képességeit figyelembe vesszük; a saját sorba már felvett tételek sorrendjét egy később megérkező oldal nem írhatja át.
- A kiszolgáló által visszaadott elemszámot és haladást ellenőrizzük. Nem használunk korlátlan „mindent kérek” lekérdezést. A lapozás, az objektumazonosító és a médiaszerver frissítési azonosítója a [ContentDirectory](https://www.upnp.org/specs/av/UPnP-av-ContentDirectory-v4-Service-20101231.pdf) alapján kezelendő.
- A szerver azonosítása tartós eszközazonosítóval történjen; az IP-cím változhat. A mentett objektumot szükség esetén újra feloldjuk lejátszható URL-re.
- A Synology vezérlési portját és a zenemappa azonosítóját a szerver leírásából és böngészéséből vesszük. Nem építünk be kötelező `50001` portot vagy `21` mappaazonosítót.
- A támogatott hangforrást a visszakapott erőforrások/MIME/protocolInfo alapján választjuk ki. Az ESP nem lesz általános formátumátalakító.
- A lejátszási sor az ESP-n éljen, így a böngésző bezárása után is működik. A tartós mentés ritkított és atomi; nem írunk flashre minden másodpercben vagy listamozdulatnál.
- Az új programrész kezdetben kikapcsolható. Kikapcsolva nem keres szervert, nem indít DLNA-munkát, és nem változtatja meg a rádió kezelését.
- A megvalósítás külön fejlesztési ágon, kis commitokkal induljon a most elmentett állapotból. Minden mérföldkőnek visszakereshető binárisa és ellenőrzési jegyzőkönyve legyen.

## 7. Lépésenkénti ütemterv

Az összes alábbi fejlesztési lépés **tervezett, még nincs végrehajtva**. A következő lépés az előző ellenőrzési kapujának teljesülése után indul.

| Lépés | Egyértelmű eredmény | Továbbhaladás feltétele |
|---|---|---|
| **0. A jelenlegi alap minősítése** | Pontosan azonosított firmware/data, tesztanyagok és mérési jegyzőkönyv; DS220+ médiaszerver-csomagja és zenemappái ellenőrizve. | 30–60 perc valódi vegyes rádióhasználat, majd hosszabb alapjárati próba; a korábbi hibák nem reprodukálhatók. Ha van hiba, itt javítjuk. |
| **1. Forráskezelési keret** | Rádió/DLNA elkülönítés, kezdetben kikapcsolt DLNA-val. | A kikapcsolt új réteg mellett a régi rádiós működés, API, beállítások és HA-kártya változatlanul működik. |
| **2. Szerverkeresés és kis protokollpróba** | Az elérhető szerverek listája, még új zenelejátszás nélkül. | Nulla, egy és több szerver; alvó NAS; ismételt keresés és megszakítás. Rádió közben is elérhető marad minden vezérlés. Memória és időzítés alapján itt választunk protokollréteget. |
| **3. Mappák böngészése** | Lapozott szerver → mappa → tartalom nézet, elsőként egyszerű diagnosztikai/webes eléréssel. | Üres, nagy és mély mappák; ékezetek; vegyes hang/kép/videó; lassú és hibás válasz. Régi válasz nem írhatja felül az új mappát. |
| **4. Egyetlen szám lejátszása** | A kiválasztott hálózati fájl a meglévő hangúton szól. | MP3 és FLAC ismert mintával, fájlvég, Stop, szünet/folytatás, ismételt ugyanazon szám, eltűnő fájl, rádióra visszalépés. VU és spektrum külön összehasonlítva. |
| **5. Központi lejátszási sor** | Több szám, Következőnek/Sor végére, eltávolítás és átrendezés; sor bezárt böngészőnél is működik. | Számvégen pontosan egyszer lép tovább; a megállított lejátszást nem indítja újra késői esemény. Az aktuális tétel törlésének viselkedése előre rögzített. |
| **6. Teljes webes kezelés** | A mostani dizájnhoz illeszkedő forrásválasztó, médiatár és sor; többes kijelölés, telefonos nézet. | Több megnyitott böngésző ugyanazt az állapotot mutatja. Beállításmentés, képek és új rádióállomás mentése lejátszás mellett is működik. |
| **7. LCD, egy encoder, távirányító** | Mindhárom vezérléssel elérhető a forrásválasztás, mappák, számok és a sor alapműveletei. | Csak encoderrel is végigjárható használati próba; külön IR-próba; közben webes beavatkozás; hosszú címek és listagörgetés. A rádiós gombkiosztás külön visszaellenőrizve. |
| **8. Több mappa, almappák, nagy médiatár** | Lapozott, fokozatos mappafeldolgozás, több mappa hozzáadása, haladás és Mégse. | Több ezer médiatétellel sem nő korlátlanul a memória. Megszakítás és megtelt sor mellett is megmarad a korábbi sor. Jelenlegi zene nem állhat meg a bejárás miatt. |
| **9. DLNA-címadatok és borítók teljes kezelése** | Szerveres kép és metaadat, szükség szerinti további források; megfelelő kép minden felületen. | Hiányzó, nagy és sérült kép; gyors váltások; rádióra visszalépés. Régi DLNA-borító nem kerülhet rádióra, rádiólogó nem ragadhat DLNA-s számra. |
| **10. Állapotmegőrzés és HA-együttműködés** | Utolsó forrás/szerver/mappa/sor mentése, rádiós állapot külön megőrzése; a meglévő HA-kezelés helyes marad. | Újraindítás, megváltozott IP, újraindexelt szerver, hiányzó tétel, firmware/data OTA és ismételt OTA. Adat- és állomásvesztés nélkül. A kibővített HA-sor csak külön későbbi feladat lehet. |
| **11. Teljes használati és tartós próba** | Dokumentáltan kipróbált első DLNA-változat. | A Synology DS220+ tényleges médiaszerverével és egy másik megvalósítással, például Windows/UMS alatt is ellenőrizzük. 60 perc kevert használat és legalább 8 óra tartós próba. A kritikus rádiós ellenőrzések ismét sikeresek. |

### Az LCD-kezelés javasolt alapja

- A lejátszón az encoder továbbra is hangerőt állít; hosszú nyomással nyílik a lista.
- Böngészéskor tekerés = kijelölés mozgatása; rövid nyomás = mappa megnyitása vagy a szám műveletei.
- DLNA-böngészőben a hosszú nyomás egy szinttel visszalép; a listában „Vissza” sor is lehet. Távirányítón ezt a Back végzi.
- Számnál kevés, egyértelmű művelet: Lejátszás most, Következőnek, Sor végére.
- A rádió/DLNA választás egyetlen encoderrel is elérhető legyen. A rádióállomások számozása és megszokott rövid nyomásos indítása megmaradjon.
- A hálózati betöltésnek legyen visszajelzése; a lista közben is elhagyható legyen. Mappanézetben nem töltünk le automatikusan minden sorhoz külön borítót.

A végleges kiosztást a 7. lépés használati próbája rögzíti. A DLNA-listában nem indítunk automatikusan számot pusztán az encoder mozdulatlanul hagyásától.

## 8. Kötelező ellenőrzések minden lépés után

### Rövid rádiós visszaellenőrzés a készüléken

1. MP3- és FLAC-rádió hallgatása normál hangerőn, a hallható kihagyások megfigyelésével.
2. Gyors állomásváltások, a logó és az albumborító megvárása nélkül.
3. Új állomás mentése és szerkesztése lejátszás alatt; logófeltöltés a hozzá tartozó lépéseknél.
4. Fényerő és más mentett beállítás változtatása aktív képletöltés közben. A mentés lemezre került eredményét is ellenőrizzük.
5. Webes lapok váltása, párhuzamos képbetöltés, mobilmenü; a képek teljes tartalma is megérkezik, nem csak HTTP 200-at kapunk.
6. LCD-állomásválasztó, listagörgetés és hosszú cím; encoder és IR-vezérlés.
7. VU/spektrum mozgása és szinkronja ugyanazzal az ismert hangmintával összevetve.
8. HA-kártya: rádiós kép, állapot, állomás és vezérlés.

### Protokoll- és hibatesztek PC-n

- Valós UPnP-válaszokból vett minták és egy szabályozható tesztszerver: késleltetés, részleges válasz, hibás XML, hiányzó mezők, túl hosszú URL, eltérő névterek.
- Hálózati próba a kliens és egy valódi szerver között: chunked átvitel, átirányítás, hiányzó Content-Length, megszakadt és újraindított letöltés.
- Lapozásnál rossz elemszám, nulla előrelépés, frissítés közben változó médiatár, utolsó oldal és a nem támogatott keresés/rendezés.
- Almappabejárásnál ismétlődő hivatkozás, túl nagy mélység, megtelt sor, illetve kétlemezes album és 1/2/10 jellegű számsorrend.
- Megszakításkor és új parancsnál a régi válasz figyelmen kívül marad. Nem zárja le másik feladat élő hálózati objektumát.
- Eseménysorrend: EOF → Next, Next → régi EOF, Stop → késői kép, forrásváltás → régi mappaválasz, azonos szám kétszeri indítása.
- A korábbi automatizált ellenőrzések megmaradnak; a jelenlegi kiindulásnál 484 JavaScript- és 10 Python-teszt futott sikeresen. A darabszám nem helyettesíti a használati próbát.

### Mérési kapuk

- Nincs váratlan újraindulás, beragadt mentés, eltűnő állomás vagy hibásan visszaálló régi állapot.
- Azonos műveletsorok ismétlése után nem fogy folyamatosan a memória. A belső szabad memória, a legnagyobb egybefüggő blokk, a minimum és a feladatvermek tartaléka is szerepel a jegyzőkönyvben.
- A vezérlés visszajelzési idejét és a hálózati hangindulás idejét külön mérjük. Kezdő cél az általános kezelői visszajelzésre 200 ms; a tényleges határértékeket a 0. lépésben rögzítjük. Egy lassú NAS-válasz nem jogosítja fel a programot a kezelőfelület blokkolására.
- A hanghiba vizsgálatához hallgatás vagy külső hangrögzítés is kell. A `connected` állapot és a némított próba nem bizonyítja önmagában a kihagyásmentes hangot.
- A 0., 4. és 11. lépésnél hosszabb próba is szükséges; a többi lépésnél a rá vonatkozó rövid rádiós és hibateszt-készlet kötelező.
- Ha egy korábbi funkció romlik, új funkció helyett az ok feltárása következik. Az utolsó ismerten jó állapot megmarad; csak az adott kis lépés kerülhet visszavonásra.

## 9. Mit jelent majd az, hogy „tesztelve”?

Minden mérföldkőhöz ezt rögzítjük:

| Mező | Elvárt tartalom |
|---|---|
| Kód és csomag | Git-commit, firmware buildazonosító/ELF, adatcsomag azonosító. |
| Környezet | NAS típusa, médiaszerver neve/verziója, hálózat és hangformátum. |
| Próba | Pontos műveletsor, időtartam, ismétlésszám. |
| Szint | Automatizált részteszt / PC-s hálózati integráció / készüléken némítva / készüléken hallgatva. |
| Eredmény | Sikeres, hibás vagy még nem vizsgált; szükség esetén napló és reprodukció. |
| Megőrzött funkciók | A rövid rádiós visszaellenőrzés konkrét eredményei. |
| Határ | Amit ebben a körben nem próbáltunk ki. |

A kutatás során a SimpleRadio rádiós és DLNA-s kódját nem futtattam új használati próbaként; a korábbi 341 másodperces mérés és az 1.2.09-es mentés adatait csak kiinduló bizonyítékként olvastam vissza.

## 10. Későbbi, külön bővítések

- Szerveren keresés és rendezés, ha a szerver jelzi és a valós próba igazolja a támogatást. Egyébként egyértelműen csak a megjelenített listában keresünk.
- Számon belüli tekerés, a kiválasztott fájl/formátum és a szerver Range-képességének külön igazolásával.
- Ismétlés és keverés a már stabil központi soron.
- Telefonos DLNA-renderer: külső alkalmazásból küldött zene, AVTransport/RenderingControl és eseményértesítések; saját külön tesztkörrel.
- HA-n kibővített médiatár- és sorkezelés, ha az alap rádiós együttműködés már bizonyított.

A szünet nélküli számváltás, a többhelyiséges szinkron és az összes NAS/formátum támogatása nem szerepel az első változat ígéretei között. Ezek külön mérést és további fejlesztést igényelnek.

## 11. Első ténylegesen elvégzendő lépés

**A 0. lépés: a jelenlegi rádió felhasználószerű alappróbája és a Synology DS220+ médiaszerver-beállításainak ellenőrzése.** Ennek sikeres lezárása után kezdődhet a kikapcsolható forráskezelési keret és a kicsi DLNA-protokollpróba.
