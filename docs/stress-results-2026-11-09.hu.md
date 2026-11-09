# Első készülékes terheléses eredmények – 2026. november 9.

Elkészült a megismételhető tesztkörnyezet, és két némított készülékes próba is lefutott. A rendszer a vizsgált helyzetekben nem indult újra, de a mérés **nem ad hibátlan hangutánpótlási eredményt**. A következő fejlesztéshez már van rögzített kiindulópont és reprodukáló forgatókönyv.

## Körülmények

- ESP32-S3 N16R8, ILI9488, firmware 1.2.09. LovyanGFX maradt 1.2.34.
- Kiinduló és visszaállított firmware: `ec0d53ba2`; külön mérőfordítás: `c3b1c9a6a`.
- A mérőfordítás a hangmintákhoz, az I2S-pufferhez, az írási időtúllépéshez és a prioritásokhoz nem nyúlt. A kiinduló kódhoz képest 160 bájttal több statikus RAM-ot foglalt; új feladatot nem indított.
- A HTTP/WebSocket műveleteket gépi kliens végezte a valódi rádión. A hangerő 0% volt. FLAC, MP3 és gépről kiszolgált, ismételhető sztereó WAV is szerepelt.
- Mindkét mérés körülbelül másodpercenként állapotot és külön hangdiagnosztikát is lekért. Ez a megfigyelés is része a rögzített terhelésnek.
- A forrás-/fordítási azonosítók, a nyers események és a saját próbacsatornák helyreállítási adatai helyben a `.pio` alatt találhatók. Az eszköz USB-naplója az első sorozat egy részéről rendelkezésre áll; nem teljes sorozatlefedésű.

## Eredmények

| | Vegyes, extrém használat | Elkülönített terhelések |
|---|---:|---:|
| Futási idő | 329,4 s | 147,8 s |
| HTTP-kérések | 1007 | 377 |
| Állapotminták | 241 | 111 |
| Stabil lejátszáshoz tartozó hangmintavételek | 205 | 107 |
| Váratlan újraindulás / I2S írási hiba | 0 / 0 | 0 / 0 |
| Mintavételezett legkisebb belső szabad RAM | 4712 B | 15256 B |
| Legnagyobb belső szabad blokk legkisebb mintája | 3188 B | 7668 B |
| Teljes állomáslista és beállítások visszaállítása | Ellenőrizve | Ellenőrizve |

A legkisebb mintavételezett szabad PSRAM a vegyes próbában is 6 806 516 bájt volt. A szűk belső memória és a nagy szabad PSRAM tehát egyszerre állt fenn. Ezek mintavételezett értékek; a minták közötti rövidebb mélypont nem zárható ki.

A vegyes sorozatban új ideiglenes állomás és logó mentése, a logó hozzárendelése, állomás áthelyezése, hat gyors állomásváltás, kijelző- és hangbeállítások, leállítás/újraindítás, állomás- és albumképek letöltése is megtörtént. A HTTP-válaszok tartalmát és a képek teljességét is ellenőrizte a kliens. A még nem elérhető képek 404-es válasza nem teljes képletöltésnek és nem önmagában hibának számít.

## A lényeg: a képkiszolgálást érdemes először elkülönítve vizsgálni

A képkérések nélküli első FLAC-alapmérés stabil ablakában nem volt konzervatívan kimutatható digitális adathiány. Párhuzamos képkérésekkel mindkét sorozatban megjelent:

| Stabil mérési ablak | Ablak hossza | Kiküldött és átadott adatmennyiség különbsége, játékidőre számítva | Konzervatív hiánybecslés |
|---|---:|---:|---:|
| Első FLAC-alapmérés | 39,4 s | 10,7 ms | 0 ms |
| Első sorozat: képek és web | 39,2 s | 981,0 ms | 575,5 ms |
| Második sorozat: csak képkérések | 37,7 s | 1468,7 ms | 912,9 ms |
| Második sorozat: csak beállításmentések | 24,4 s | 52,2 ms | 0 ms |
| Második sorozat: képek és mentések | 24,7 s | 580,5 ms | 24,7 ms |

A becslés két teljes DMA-gyűrűnyi tartalékot és az észlelt maximális írásidőt is levonja; a részletes módszer a [tesztleírásban](stress-testing.hu.md) olvasható. A számlálók alapján kimutatható digitális utánpótlási hiány nem azonos egy hangszórón rögzített, pontos hosszúságú hallható kihagyással. Némítva az utóbbit nem mértük.

Időzítési figyelmeztetés a második alapmérésben is előfordult, ezért a képkiszolgálás nem bizonyítottan az egyetlen ok. Az alapmérés alatt a normál album-/logóháttérmunka sincs mesterségesen kikapcsolva. A helyi WAV vegyes terheléses szakaszában is volt hiánybecslés, így a jelenség teljes egészében nem magyarázható egy távoli internetes adó viselkedésével. A pontos feladat vagy függvény még nincs ok-okozati szinten azonosítva.

## Mentés és képfeltöltés

| Művelet / körülmény | Darab | Medián | Legnagyobb idő |
|---|---:|---:|---:|
| Fényerőmentés a vegyes FLAC-terhelésben | 3 | 375 ms | 766 ms |
| Kijelzőbeállítás mentése a vegyes MP3-szakaszban | 3 | 625 ms | 1656 ms |
| Második sorozat: csak mentés | 3 | 281 ms | 875 ms |
| Második sorozat: képek mellett mentés | 3 | 625 ms | 781 ms |
| Új állomás mentése | 2 | kis elemszám | 1016 ms |
| PNG-logó feltöltése | 1 | 3359 ms | 3359 ms |

A sikeres mentések után a kliens a ténylegesen tárolt beállítást is visszaolvasta. A háromelemű minták mediánjai hasznos első jelzések, nem bizonyított általános teljesítményhatárok. A beállításmentés jelenleg megvárhatja a háttérhálózat leállását; a teljes HTTP-időből önmagában nem állapítható meg, mennyit vitt el a flash-írás.

## Következő, méréssel igazolandó célpontok

1. **Képek és TCP-kiszolgálás közös terhelése.** Egy, kettő és több párhuzamos képkérés összevetése, azonos FLAC- és helyi hangforrással. A kérések sorba állításának és a válaszküldési callback futási idejének külön mérése megmutathatja, hol lehet csökkenteni a hangot kiszolgáló feladat várakozását. A prioritások átállítása még nincs igazolva javításként.
2. **Mentési várakozás és tényleges írás szétválasztása.** Külön időbélyeg a sorba állításhoz, a háttérhálózat elengedéséhez, a tároláshoz és a válasz elküldéséhez. Így lehet a biztonságos mentésből a szükségtelen várakozást kivenni.
3. **Belső memóriacsúcs új állomás és logó mentésekor.** A feladatvermek, hálózati kapcsolatok és kiszolgálási objektumok együttfutásának vizsgálata. A PSRAM szabad mennyisége alapján nem szabad azt feltételezni, hogy ezek számára is elegendő belső memória maradt.

Ebben a körben a fenti teljesítménycélpontokra **nem került be új viselkedésmódosító javítás**. A mérőkód alapból kikapcsolt, a függőségverziók változatlanok. A cél, hogy a következő egyetlen változtatást ugyanezekkel a próbákkal lehessen elfogadni vagy elvetni.

Az egy héttel korábbi firmware-rel, azonos szolgáltatókkal, cache-állapottal és terheléssel még nem készült A/B mérés. Ezért a régi és a mostani sebesség különbségének pontos oka nincs bizonyítottnak nyilvánítva.

## Ellenőrzés és lezárás

- 507 JavaScript-teszt sikeres, köztük az új mérőkód logikájának 6 próbája.
- A mérési környezet Python-próbái, valamint a rögzített függőségek megfigyelő/kapcsolati javításainak tesztjei sikeresek.
- Az elkülönített mérési firmware fordítása sikeres. Az ISR-ben futó mérőfüggvény az ELF-ben IRAM-ban, a számlálói belső DRAM-ban találhatók.
- A próbák végén az eredeti `ec0d53ba2` firmware visszakerült a készülékre. A teljes állomáslista, a konfiguráció és a lejátszó vezérlési állapota egyezik a próba előtti mentéssel. A rádió némítva, leállítva maradt.

Részletes helyi eredmények: `.pio/stress-extreme-20261109/report.md`, `.pio/stress-isolation-20261109/report.md`. Újraelemzéshez a mellettük lévő `events.jsonl` használható a `tools/stress_report.py` programmal.
