# Albumkeresés és képi gyorsítótár: utóvizsgálat

Állapot: a célzott javítás és az alább felsorolt helyi és élő ellenőrzések
elkészültek. A normál firmware a rádión fut, a tesztképek takarítása megtörtént.
Verzió: 1.2.09, könyvtárfrissítés nélkül; normál build: `622413d4f`.

## Mit mutatnak a hibajelentések?

- A jxdn keresése megtalálta a megfelelő albumot, két képcímmel. A letöltés
  fogyott ki az időből. A két CAA-cím ezen ellenőrzéskor számítógépről 200-as
  választ és JPEG-képet adott, körülbelül 2,2–2,4 másodperc alatt. Ez nem azonos
  időpontú hálózati mérés, tehát önmagában nem bizonyítja az ESP hibáját.
- Erősebb jel a már letöltött, 7538 bájtos JSON feldolgozása: 2432 ms eltelt
  idő, 12 ms tényleges processzoridő. A memóriában végzett feldolgozás közben
  a háttérfeladat alig futott. A régi, 0-s prioritású képfeladat valódi
  FLAC + FFT/LCD terhelés mellett kiéhezhet.
- A Bryan Adams keresésénél a Last.fm válaszának mind a 957 bájtja megérkezett,
  a keresés mégis határidőhibát jelentett. A hálózati kódban a végső ellenőrzés
  a kapcsolatlezárás után történt; a lezárás késése is érvényteleníthette az
  előzőleg befejezett választ. A napló nem tartalmazza az utolsó bájt időpontját,
  ezért az adott eset pontos határidő-sorrendje még mérendő.

## Elkészített javítás

- Csak a hálózati és a teljes egészében PSRAM-ot használó albumkeresési út
  kap ideiglenesen 1-es prioritást, a hang 2-es prioritása alatt. A megosztott
  képfeladat, a logók flash-írása és a karbantartás továbbra is 0-s marad.
  A visszaállítás az eredeti alapprioritást használja, beágyazott hívásoknál is.
- A HTTP-törzs sikeressége a kézi kapcsolatlezárás előtt dől el. Hiányos,
  lejárt, megszakított vagy túlméretes válasz továbbra sem fogadható el.
  A keresési határidők és az előadó/cím egyeztetése változatlanok.
- A helyi logó cseréje/törlése most a normál és a kitöltéshez vágott LCD-képet,
  illetve mindkettő félbemaradt ideiglenes fájlját is törli. Korábban a RAM-ban
  mindkét változat törlődött, a flash-en csak a normál. Ez régi képet és
  tesztállomásokból visszamaradó, körülbelül 62 KiB-os fájlokat is hagyhatott.

## Tárhely: mért adatok

| Állapot | LittleFS foglalt | Képi gyorsítótár |
| --- | ---: | ---: |
| 2026-11-09/10 korábbi mentések | 1 114 112 B | 495 680 B |
| 2026-11-11 későbbi mérési mentés | 2 531 328 B | 1 817 866 B |
| 2026-11-14 élő állapot | 3 440 640 B | 2 556 283 B |
| Takarítás után, normál firmware | 1 167 360 B | 421 592 B |

Az első november 14-i sor lejátszás közben, a rendszerindítás óta még nem
frissített statisztikát mutat. A két
feltöltött saját PNG mérete összesen 50 805 B. A tárhelyadat nem a szabad RAM.
Az albumképek jelenlegi útja a PSRAM-ban marad, flash-írás nélkül.

A próbák ideiglenes állomásait és feltöltött logóit a teszteszköz törölte,
de a kitöltött képváltozatok és az egyedi távoli teszt-URL-ek gyorsítótára
maradhatott. A kezdeti 77 fájlból 45-öt azonosítottunk a mérési naplók alapján.
A további próbák után 80 fájlt, 2 613 442 bájtot mentettünk le a számítógépre.
A név szerinti azonosítást a generált teszt-PNG-k és a bizonyított teszt-LCD-képek
bájtpontos egyezésével egészítettük ki. Az aktuális állomások képcsaládjai
külön védelmet kaptak.

70 tesztfájl törlődött, összesen 2 191 850 bájt. A megmaradó 10 gyorsítótárfájl
tartalmát ismét összehasonlítottuk a mentéssel: mind sértetlen. A két saját
feltöltött PNG is bájtpontosan megmaradt. Szabad LittleFS: 6 041 600 B,
a felület 1024-es egységeivel körülbelül 5,8 MB a kezdeti 3,6 MB helyett.

Az egyedi távoli teszt-URL-ek továbbra is a normál, korlátos gyorsítótárba
kerülnek. Terheléses kör után ezért az állomások visszaállítása mellett
a tesztképek elkülönített, mentéssel védett takarítására is szükség van.

## Ellenőrzések és korlátok

- 673 Node-teszt, 64 + 15 Python-teszt, 17 ismételt könyvtárpatch-ellenőrzés:
  sikeres. Normál firmware és LittleFS-fordítás: sikeres.
- Új esetek: eredeti alapprioritás visszaállítása, egymásba ágyazott hívások,
  teljes válasz utáni lassú lezárás, hiányos/megszakított válasz elutasítása,
  mindkét képváltozat takarítása és más képek megőrzése.
- Az előző hosszú terheléses mérések eredményei továbbra is az ott leírt
  forgatókönyvekre vonatkoznak. Nem bizonyították kellően a friss, teljes külső
  albumkeresést valódi FLAC-adás mellett. A szintetikus FLAC-terhelés és a
  már gyorsítótárazott képek ezt nem helyettesítik.

| Élő forgatókönyv | Naplózott kérések | Stabil hangminták | Eredmény |
| --- | ---: | ---: | --- |
| Régi keresés, valódi FLAC és MP3, kontroll | 328 | 148 | Hiba nem jelentkezett |
| Új keresés, valódi FLAC/MP3, majd FLAC + web + mentés | 948 | 219 | Hiba nem jelentkezett |
| Aktív FLAC-albumkeresés közbeni mentés, webes terheléssel | 385 | 44 | Hiba nem jelentkezett |
| HTTP-fejléc, törzs és TLS közben megszakító mentés | 111 | 33 | Hiba nem jelentkezett |
| Nagy képfeltöltések folyamatos, ismert FLAC-hangmintával | 335 | 84 | Hiba nem jelentkezett |

Az új változat négy forgatókönyvében összesen 1779 naplózott kérés futott.
A hangellenőrzés digitális utánpótlást és hibaszámlálókat vizsgál; az ismert,
folyamatos hangmintás próbákban a nem várt néma DMA-blokkok száma is nulla.
Ez nem helyettesíti a hangszórón hallgatott hosszú felhasználói próbát.

- Friss borítók az új mérési változattal: Alestorm 4,0 s, Muse 7,2 s,
  Train 6,0 s, ABBA 6,5 s; Muse ismét, webes terhelés mellett 14,0 s.
- Az átfedési próbánál a mentés ténylegesen aktív hálózati albumkeresés közben
  indult. A mentés 2,55 s, a teljes Beast In Black-borítókeresés 8,23 s.
  A HTTP/TLS megszakítási próbák mentései 1,30–1,36 s alatt lefutottak, a
  képkérések utána a megfelelő 19053 bájtos képpel folytatódtak.
- A régi keresés is talált képet a kontrollban. A különböző éppen futó számok
  és külső kiszolgálói válaszok miatt ezek nem azonos bemenetű
  sebességbenchmarkok, és nem bizonyítanak minden adóra állandó gyorsulást.
  A bejelentett legsúlyosabb időtúllépés ebben a kontrollban nem ismétlődött.
- A normál firmware-rel az Avenged Sevenfold – Hail to the King friss
  FLAC-borítója 5,77 s alatt megérkezett; a képfájlt HTTP-n is ellenőriztük.
  Mind a hat állomás képe érvényes választ adott.
- Az összes eredeti konfigurációs mező, az állomáslista és a két saját logó
  ellenőrizve. A legutolsó normál próba előtti állapot visszaállt: álló
  Danubius, 50% hangerő, az eredeti EQ és balansz. Nem történt data OTA.
- Mindhárom mérési végpont 404-et adott a normál firmware-rel.

Két futást nem számítottunk sikeres bizonyítéknak: az egyik mérőprogram a
korábbi körök felülírt naplóelőzményeit hibásan az aktuális kör naplóvesztésének
vette; a nyers FAIL-jelentés megmaradt, a tiszta indulásos ismétlés sikeres.
Az első normál borítópróba reklámblokkba esett, nulla képtalálattal; a nyers
időkorlátos eredmény megmaradt, a zenei FLAC-adón végzett ismétlés sikeres.

A külön mérési napló és a jelszóval védett, álló lejátszót igénylő
gyorsítótár-vizsgálat kizárólag az elkülönített helyi mérési példányban van;
a normál forrásban és firmware-ben nincs új diagnosztikai végpont.
