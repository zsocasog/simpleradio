# Mért teljesítményjavítás – 2026. november 10–11.

A munka előtti mentés: `54953c4`, `logo_test`. A vendégelőadók és változatjelölések javítása ezen a mentésen már szerepel. A verzió maradt **1.2.09**, a könyvtárverziók változatlanok.

## Változtatások

- A konfiguráció és az állomáslista kiírása a teljesen szinkronizált ideiglenes fájlt a LittleFS saját atomi helyettesítő átnevezésével teszi véglegessé. A régi célfájl a csere pillanatáig a helyén marad. A régi `.bak` olvasási helyreállítás támogatása megmaradt. A LittleFS ezt a műveletet áramkimaradás esetére is atominak definiálja; a beépített ESP-IDF-adapter hívási útvonalát is ellenőriztük. [LittleFS](https://github.com/littlefs-project/littlefs#readme), [ESP-IDF-adapter](https://github.com/joltwallet/esp_littlefs/blob/master/src/esp_littlefs.c).
- A fájl stdio puffere az első írás előtt 512 bájtra áll. A JSON 512 bájtos adagokban készül; sikeres adag után, már a fájlrendszer zárolásán kívül, egy ütemezési tick jut más feladatoknak. A rövid írás továbbra is hibát jelent, az adatokat és a véglegesítés feltételeit ez nem lazítja.
- A FLAC LPC-ciklus a teljes mintatartomány méretét egyszer ellenőrzi, majd ugyanazokat a 64 bites szorzásokat, összeadásokat és eltolásokat végzi. A korábbi ellenőrzött ág megmaradt. A rögzített `ps_ptr` mérete **bájtban** értendő, ezért a gyors ág ennek nyolcadával hasonlítja össze a mintaszámot. A teljes pufferfejléc és az eredeti függvény SHA256-ellenőrzése is kötelező fordításkor. Új dekóderpuffer, feladat vagy prioritásmódosítás nincs.
- A `/api/artwork/station` ETag/304 visszaigazolást ad a változatlan képekre. A verziót a tényleges LCD-kép véglegesítése/érvénytelenítése változtatja; újraindításkor új munkamenet-azonosító készül. A kép útvonala is része az azonosítónak. A fájl megnyitása előtti és a válasz előtti verziónak egyeznie kell; folyamatban lévő csere esetén teljes 200-as válasz érkezik verziócímke nélkül. A kép maga változatlan BMP, az ellenőrzéshez nem olvassuk végig újra a pixeleket. Azonos nevű feltöltéshez és data-frissítés utáni újrainduláshoz is új verzió tartozik.
- A még el nem készített állomáslogó LCD-változata ugyanazon memóriafoglalási kaput használja, mint a RAM-os albumborító készítése. A PNG/JPEG dekódolási munkaterülete így nem versenyez az ideiglenes állomásmentő stackkel. A kész képek megkeresése ezt a kaput nem érinti. A háttérmunkás legfeljebb három másodpercig várhat a kapura, még a képmutex felvétele előtt; a kijelzőt hívó főfeladat itt nem várakozik. A feltöltött PNG és az LCD-kép kiírása is 512 bájtos stdio puffert használ.
- Az állomásmentő ideiglenes 6 KB-os feladatának sikertelen indítása 50 ms-onként újrapróbálható. Három másodperc után még egy indítási kísérlet történhet, amikor a képmunka elengedte a kaput; ismételt hiány esetén valós 503 hiba érkezik. Közben a mentés nem tartja a kaput, nincs blokkoló várakozás, és továbbra is csak egy mentés kerülhet be. Megszakított kérés nem ír fájlt. A hálózati folytatás mutatója már a feladat másik CPU felé publikálása előtt elkészül. Ezt a hat párhuzamos teljes képet kérő próbán észlelt indítási elutasítás indokolta; az újrapróbálás önmagában kevés volt, a logók dekódolását is össze kellett hangolni a mentéssel. A stack méretét és prioritását nem csökkentettük.

A normál firmware állandó belső RAM-foglalása **104 380-ról 104 396 bájtra** nőtt. Ez 16 bájt különbség. Az ETag nem tárol teljes képet; a fájlolvasás továbbra is a már meglévő, hibát visszaadni képes VFS-deszkriptort használja.

## Képkérések

Leállított, némított rádió, hat meglévő logó, hat első és 24 ismételt kérés. A teljes képek SHA256-a az összevetésben egyezett.

| Mérés | Előző kiszolgálás | Képkiszolgálási javítás (`fbdec3225`) |
|---|---:|---:|
| Első hat kép mediánja | 203 ms | 172 ms |
| 24 ismételt kérés mediánja | 188 ms | 47 ms |
| Ismételt kép-adattartalom | 1 488 432 B | 0 B |
| Sikeres 304 visszaigazolás | 0 | 24 |

A 304 fejlécet és kapcsolatot továbbra is igényel; a nulla bájt a képtartalomra vonatkozik. A kliens órájának felbontása 15,625 ms, az értékek kerekítettek. Ez kis mintás, helyi hálózati eredmény, nem minden hálózatra érvényes késleltetési garancia.

Külön fizikai próba ugyanarra az állomásra és ugyanarra a logófájlnévre kétszer töltött fel eltérő képet. Az új kép teljes 200-as válasszal és új ETag-gel jelent meg; utána annak ismételt kérése már üres 304 volt. Az eredeti állomáslista a próba után visszaállt.

Egy korábbi kísérlet a teljes fájlt minden kéréskor újra hash-elte. Az ismétlések gyorsultak, de párhuzamos teljes képátvitelnél romlott a válaszidő. Ezt a változatot elvetettük; a véglegesítéshez kötött verziójelzés váltotta fel.

## Mentések azonos hangmintával

Azonos saját 600 másodperces Ogg/FLAC-minta, 44,1 kHz, sztereó; a tényleges kodek FLAC. Az adás `Content-Length` nélkül a rádiófolyam útvonalát használta. Ugyanaz a kliensprogram, seed és referenciaminta, 24 különböző fényerőmentés három párhuzamos, teljes képkérés mellett. Mind a 48 mentés után visszaolvastuk a tárolt konfigurációt.

| Mérőszám | Kiinduló `2e76cc81c` | Ellenőrzött javítás `299831fa7` |
|---|---:|---:|
| Mentések száma | 24 | 24 |
| Mentés mediánja | 407 ms | 297 ms |
| Mentés p95 | 1047 ms | 797 ms |
| Mentés maximuma | 1110 ms | 937 ms |
| Sikertelen HTTP / váratlan újraindulás | 0 / 0 | 0 / 0 |
| Konzervatív digitális hiánybecslés | 0 ms | 0 ms |
| Nyers DMA-határidő-kockázat | 1 | 1 |

A teljes, gyorsítótár nélküli képek p95 ideje ugyanitt 922-ről 1188 ms-ra változott. **Általános gyorsulás minden egyes képkérésre ebből nem állítható.** A biztos nyereség a változatlan képek újraküldésének elhagyása; a mentés hosszú szélsőértékei is megmaradtak.

Az `fbdec3225` mérőváltozat ezután a párhuzamos képcsere védelmét szigorította; az audio- és tárolási gyorsítás azonos. A fenti elkülönített mérések helyben: `.pio/performance-A-saves-20261110`, `.pio/performance-D3-saves-20261110`, `.pio/performance-A-D3-saves-compare-20261110.json`.

## Hangutánpótlás

A részletes élő FLAC-próbában a kiinduló változat 24 nyers határidő-kockázatot jelzett, az újabb próba nullát. A konzervatív digitális hiánybecslés összesen 11 513,2 ms helyett 47,4 ms lett. Ez eltérő adásszakaszok összevetése, ezért **nem azonos hanganyagos bizonyíték** a javulás mértékére, és a 47,4 ms miatt a kérdés nem tekinthető teljesen lezártnak.

A hosszabb, elkülönített saját mintás próbában a konzervatív hiánybecslés minden szakaszban nulla volt, de egy nyers határidő-kockázat ott is jelentkezett. A mért maximumok és a számlálók tartalmazhatnak belső várakozást és a folyamatban lévő I2S-írás megfigyelési bizonytalanságát is. Némítva ebből hallható kihagyáshosszt nem állítunk.

## A végleges változat teljes, hatképes próbája

A közös logó/mentési memóriavédelemmel készült `c0ca2fb4d` mérőfirmware **329,296 másodpercig** futott. **1200 HTTP-kérés, 242 állapotminta, 207 stabil hangmérési minta; váratlan HTTP-hiba és újraindulás: 0.** A némított próba FLAC-lejátszást, hat párhuzamos teljes logólekérést, borítólekéréseket, beállításmentést, új állomást, saját PNG-feltöltést és hozzárendelést, sorrendmódosítást, gyors csatornaváltást, saját WAV-mintát, MP3 melletti vegyes használatot és stop/start műveleteket végzett. A saját logó hozzárendelése 328 ms alatt sikerült. A korábban észlelt feladatindítási 503 ebben a futásban nem jelentkezett.

**A teljes próba minősítése `OBSERVED_WITH_RISKS`, nem hibátlan hangtanúsítás.** A stabil szakaszokban 16 nyers DMA-határidő-kockázat, összesen 3969,7 ms konzervatív digitális hiánybecslés keletkezett. A becslés a képes FLAC-szakaszban 1438,0 ms, az azzal egyidejű beállításmentésnél 2221,7 ms, az új állomás/logó szakaszában 230,5 ms, a gyors váltások utáni MP3-szakaszban 79,5 ms volt. A saját WAV-nál, az MP3 vegyes használatánál és a végső stop/start után nulla volt. A hat teljes kép folyamatos újrakérése erősebb terhelés, mint a háromképes összehasonlító mentésmérés; a kettő nem vonható össze egyetlen gyorsulási adattá. A hangutánpótlás javítása további feladat marad.

A mintavételezett belső szabad memória minimuma **15 268 B**, a legnagyobb szabad blokk legkisebb értéke **6132 B** volt. Ez továbbra is szűk belső RAM-tartalék; a külső PSRAM bősége ezt a korlátot nem szünteti meg. A napló és teljes gépi jelentés helyben: `.pio/performance-D6-extreme-six-20261111`.

## Telepítés és helyreállítás

A rádión a normál **1.2.09 / `79ecc76d0`** firmware fut, a részletes diagnosztika kikapcsolva. A normál és a mérőfordítás 102 forrás-/javítószkript-lenyomata egyezett, a binárisok és az ELF-be ágyazott azonosító ellenőrizve. A normál ELF nem tartalmaz `RuntimeProbe` szimbólumot, a mérési API 404-et ad.

A teljes konfiguráció, az eredeti hat állomás tartalma és sorrendje, valamint a lejátszó vezérlési állapota visszaellenőrzéssel egyezett a munka eleji mentéssel. Mind a hat logó BMP-pixeleinek lenyomata egyezett az előző kiszolgáláséval. Újraindítás után a régi ETag teljes 200-as választ és új azonosítót eredményezett, ugyanazokkal a pixelekkel. A készülék az eredeti állapotnak megfelelően leállítva, 0%-os hangerővel maradt. A data-csomagot nem töltöttük újra.

## Ellenőrzési határok

- 544 JavaScript-ellenőrzés, a Home Assistant-kártyával együtt; 53 Python/C++-ellenőrzés. A FLAC-számítás egyezését a tényleges S3 fordítóval, 350 paraméterkombinációval és rövid logikai pufferrel is vizsgáltuk. A tárolási hibák és megszakított műveletsorok, a képmunka és mentés kölcsönös kizárása, az átmeneti/tartós stackhiány, megszakított kérés és az óra túlcsordulása célzott szimulációt kaptak.
- A mérésekhez külön, kikapcsolható megfigyelő készült; a normál firmware a részletes megfigyelést és diagnosztikai végpontot kikapcsolja.
- A kliens a képek teljességét, a mentések valódi perzisztenciáját, a készülék azonosítóját, üzemidejét és digitális hangadat-utánpótlását ellenőrzi.
- Az API-s próba nem fizikai encoder/IR-próba, nem böngészőrajzolási ellenőrzés, és nem akusztikai mérés. Némítva az LCD változó oszlopainak rajzolási terhelése is eltérhet a hallható hangerővel végzett használattól.
- A belső memória mintavételezett minimuma nem folyamatos memóriaprofil. A külső szolgáltató, rádióadás, fájlrendszer-állapot és hálózat változása befolyásolja a hosszú szélsőértékeket.
