# Album artwork matching

## Gyors csatornaváltás és megszakított keresés (2026-11-09)

- A csatornaváltással vagy leállítással félbeszakított albumkeresés külön
  megszakított eredményt ad; nem számít sikertelen borítókeresésnek.
- Visszaváltáskor a félbehagyott keresés újraindulhat, amint a régi feladat
  befejeződött és letelt a stabil hangkapcsolat meglévő 1500 ms-os várakozása.
- A hangkapcsolat váltásazonosítója akkor is felismeri a megszakítást, ha az
  állomás és a szám adatai a hálózati kérés visszatéréséig már ismét azonosak.
- A kész borító gyorsítótárból használható. Valódi eredménytelen keresésnél
  továbbra is 120 másodperc a várakozás; indulási hibánál 3 másodperc.
- A megszakítás alapnaplója:
  `[album-art] search cancelled: playback changed; retry available on return`.

## Ofenbach / Katchi (2026-11-08)

- A `vs.` és `versus` előadó-kapcsolat az `&`-hez hasonlóan külön krediteket
  jelöl. A kért közreműködők ellenőrzése továbbra is kötelező, nincs fuzzy
  előadókeresés. A korábban elutasított `Ofenbach vs. Nick Waterhouse` kredit
  így már nem ejti ki a saját Katchi kislemezt és az Ofenbach EP-t.
- Az iTunes `Katchi (Ofenbach vs. Nick Waterhouse)` címe erős egyezés lehet
  a rádiós `Katchi feat. Nick Waterhouse` címmel, ha a zárójel tartalma pontosan
  a szolgáltató teljes előadói kreditjét adja, és a rádiós közreműködő is szerepel
  benne. Ez a bizonyított kredit egy Single/EP esetén is használható.
- Az általános opcionális alcím továbbra is gyenge egyezés, saját albumot
  igényel. A remix/live/karaoke/extended/idegen előadó védelmek megmaradnak;
  a feature-szöveg után álló verziójelölés sem tűnhet el levágáskor.
- A szolgáltatók sorrendje, a saját album elsőbbsége, a tartalékok sorrendje,
  a RAM-képek és a spektrum működése változatlan.

- Prefer a verified album owned by the performer. Single/EP, artist collection,
  unverified release and compilation images remain later fallbacks.
- Exact titles rank ahead of small spelling corrections and optional subtitles.
  Optional subtitles still require verified artist-owned album metadata.
- A complete trailing `[Radio Version]`, `(Radio Edit)` or equivalent standard
  version group can follow an optional subtitle. Earlier live, remix, acoustic,
  karaoke, instrumental and numbered-version annotations remain protected.
- Different artist names are equivalent only when a matching MusicBrainz track
  or release group established the artist MBID, and an artist lookup confirms
  both names on that identity. There is no inferred acronym or fuzzy artist match.
- Ambiguous IDs, wrong lookup IDs and search-hint aliases do not establish an
  equivalence. Explicit duets still require all requested performers.
- Alias verification is attempted at most once per track, only after a provider
  returns a matching title under another artist name. It uses the existing
  cancellation, deadline, MusicBrainz rate limit and HTTP 503 deferral policy.
  At most eight normalized names of 96 characters are retained for the search.
- Without identity proof, the original strict artist rule remains in effect.
  A temporarily unavailable MusicBrainz service can therefore still prevent
  acceptance of an otherwise valid alias on that search.
- Provider order, image transport, RAM image slots, LCD rendering and spectrum
  processing are unchanged by this matching refinement.

Regression example: `ATC - Around the World` can match iTunes' `A Touch of Class -
Around the World (La La La La La) [Radio Version]` after identity verification.
The store's album lookup must still confirm ownership of `Planet Pop`; a Various
Artists compilation does not become a verified own album through the alias.

Useful serial messages:

```text
[album-art] verified artist aliases: ATC (... names, MBID ...)
[album-art] verified artist alias match: A Touch of Class = ATC
[album-art] iTunes subtitle match: A Touch of Class - Around the World (...)
[album-art] verified artist album: Planet Pop
```

## Keresési időkeretek, PNG és részletes napló (2026-11-07)

A Chris Rea – Looking For The Summer naplója alapján az albumot megtalálta
az adatbázis, de a 35 másodperces teljes keretből a keresés/feldolgozás 34,3
másodpercet elhasznált. A keresés ezért legfeljebb 23 másodpercet kap, a
képre 12 másodperc marad a változatlan 35 másodperces közös keretben.

A korábbi próbában a szolgáltatónkénti 12 másodperc tévesen a már megkapott
JSON és a találati lista feldolgozását is korlátozta. A Rob 'n' Raz – Take a
Ride naplóban 11,5 másodpercnél készült el a dokumentum, majd csak két
felvételt dolgozott fel. A saját Circus album a 12. találatnál szerepel a
2026-11-07-én lekért MusicBrainz-válaszban, 80-as pontszámmal. A tömörített
válasz és az 11,5 másodperces késés célzott regressziós próbában szerepel.

A javításban a szolgáltatói 12 másodperc az új hálózati kéréseket korlátozza.
A JSON és a már letöltött lista feldolgozása a közös metaadat-határidőt kapja;
annak lejártakor csak a már ellenőrzött jelöltek maradnak meg. Három
másodpercnél kevesebb keresési idővel új szolgáltató helyett a meglévő képek
következnek. A JSON-olvasó 128 bájtonként ellenőriz; a számváltás ellenőrzése
legfeljebb 100 ms-onként másol állapotot. Részleges/lejárt dokumentum nem
szolgáltathat találatot. A felszabadítás, az ütemezés és a könyvtár szinkron
DNS-művelete miatt ez együttműködő időkorlát, nem valós idejű garancia.

A következő naplóban a 66664 bájtos borító megérkezett, de PNG volt:
31388 bájt szabad belső RAM kevesebb a megkövetelt 32768-nál. A két képslot
üres volt; ez nem beragadt LCD- vagy webes olvasó. A JPEG-feltétel 24576 bájt
és 6144 bájtos szabad blokk, amit a napló 10228 bájtos legnagyobb blokkja
szintén teljesít. A memóriahatárok változatlanok maradnak.

Kevés PNG-memóriánál a már igazolt nyilvános borító-CDN-ek képéből 250×250
pixeles, baseline JPEG-változatot kérünk a logóknál már használt wsrv
szolgáltatással. Ismert .png URL-nél ez megelőzi az eredeti nagy kép
letöltését. Eltérő kiterjesztésnél a payload alapján is felismerjük a PNG-t.
Nem új borítót keresünk: ugyanaz a forráskép, azonos számellenőrzéssel és
albumborító-cachekulccsal kerül átalakításra. Állomáslogó, API-cím, queryvel
aláírt vagy hitelesítési adatot tartalmazó URL nem kerül ebbe az ágba.

A sikeresen megkapott kép RAM-/dekódolási hibája többé nem vált ki azonos
képre HTTPS-letöltést, és nem rejti el egy későbbi hálózati időtúllépés az
okot. Valódi HTTP-hálózati hibánál a meglévő HTTPS-fallback megmarad.
A képek továbbra is PSRAM-ban készülnek, flash-írás nélkül.

Külön napló mutatja a letöltést (JSON fetch), feldolgozást (JSON parse)
és a teljes szolgáltatói munkát (provider-work). A részletes albumart-napló
aktív marad. Később a src/config/diagnostics.h fájlban a
SIMPLE_RADIO_ALBUM_ART_DETAILS=0 csak indulást, eredményt és leállási okot
hagy meg. Az előadó-/számellenőrzés, a MusicBrainz 503 utáni sorrend, a
számváltási megszakítás, a PSRAM-kezelés, a logók és a 2 perces teljes
sikertelenségi újrapróbálási szabály megmaradnak.

## Spektrum melletti ütemezés és HTTP-megszakítás (2026-11-07)

Az újabb naplóban az Inna-válaszból 63244 bájt megérkezett, de a 12 s-os
hálózati művelet 18 s után hibával zárult. A Fiesta két CAA-képe valódi
404-et adott; utána az iTunes és a közvetlen Last.fm-kép letöltése is
időkeretbe ütközött. Ez a napló nem jutott PNG-dekódolásig vagy RAM-foglalásig.

A borítófeladat eddig a spektrum DMA-átadója, FFT-je és az LCD mellé,
az 1-es magra volt rögzítve, 0-s prioritással. Most bármelyik mag szabad
idejében futhat (`tskNO_AFFINITY`), változatlan 0-s prioritással. Az audió
mindkét magon magasabb prioritású marad, a meglévő TLS-kapcsolódási scope
és az együttműködő várakozások megmaradnak. Nincs új feladat, nagyobb stack,
spektrum-, kijelző- vagy hangkönyvtár-módosítás. A javulás mértékét FLAC és
MP3 mellett, az eszközön kell ellenőrizni; a magterhelés szerepe a forráskód
alapján azonosított kockázat, nem a naplóból közvetlenül mért CPU-terhelés.

A használt Arduino `Stream::timedRead()` a `read()` -1 eredményét újrapróbálja
a saját, itt 6 s-os időkorlátjáig. A socket bezárása ezért nem állította le
rögtön a fejléc/szeletméret olvasását. Megszakításkor a Stream időkorlátja is
0-ra vált. A regressziós teszt a telepített keretrendszer valódi timedRead
törzsével reprodukálja a 12→18 s-os esetet és annak megszüntetését.
A HTTPClient továbbra is feldolgozza a chunked keretezést; részleges JSON
vagy kép nem minősül sikeres válasznak. A szinkron DNS és TLS-könyvtári
hívások időkorlátja ettől még nem válik kemény, valós idejű garanciává.

A meglévő `JSON fetch`, `JSON parse` és `timing ...` sorok `cpu=...ms`
értéke a keretrendszer feladatonkénti futásidő-számlálójának különbsége.
Ez közelítő tényleges CPU-idő, az aktuális időszeletet nem feltétlenül
tartalmazza teljesen. Nem összes processzorterhelés: a hálózati várakozás
és más feladatok ideje a fali időben szerepel. A mérés nem kér teljes
feladatlistát, stackvizsgálatot vagy új memóriát, és nem ad új periodikus
naplósorokat. Az adott keretrendszerben a számláló mikroszekundumos;
eltérő, futásidőmérés nélküli konfigurációban a CPU-érték 0.

A 2026-11-07-i új eszköznaplóban mindhárom borító megérkezett: a teljes
keresés és képelőkészítés 7,237 s, 8,369 s (Green Day – Bang Bang) és
6,128 s (Fish! – Mi Vagyunk Itt) volt. Az utóbbi két kép RAM-dekódolása
455 és 445 ms alatt végzett. A felhasználó gyors, megfelelő működést
igazolt vissza; ez az 1.2.07-es mentés funkcionális alapja.

## Évszám a rádiós számcím végén (2026-11-07)

A `MADONNA - Love Sensation [2026]` naplóban az iTunes és a Deezer több
előadó-/főcím-egyezést adott, de a rádiós címben maradó `2026` miatt az
ellenőrzés elutasította őket. A feloldás most külön keresési címet használ:
csak a végén álló, szóközzel/tabbal elválasztott `[1900..2099]` csoportot
hagyja el. Ugyanez a cím megy minden szolgáltatóhoz és a találatok
ellenőrzéséhez. Az eredeti teljes cím továbbra is megmarad a kijelzésben,
a cachekulcsban és a számváltási megszakítás ellenőrzésében.

A szó szerinti teljes címegyezés elsőbbsége megmarad, ha a szolgáltató is
évszámmal nevezi a számot. A sima `1999`, a címbe írt szám, a `[Live 2026]`,
`[2026 Remix]` és a zárójel nélküli cím nem válik levágott keresési címmé.
A más előadó, duett, remix, élő vagy instrumentális felvétel ellenőrzése
változatlan. Az eddigi gyenge stúdiómix-egyezés továbbra is tulajdonosi
albumellenőrzést igényel; az évszám eltávolítása nem emeli pontos egyezéssé.

## Mentett állomáslogók lejátszás közben (2026-11-07)

A lejátszás korábban a teljes előkészítési sort letiltotta, így egy újonnan
mentett adó logója is várakozott a megállításig. A már sorba tett kérések most
stabil lejátszás mellett is feldolgozhatók. Az automatikus teljes listaellenőrzés
csak megállított rádiónál fut. A hangkapcsolat elkészülése után megmarad az
5 s-os TLS-türelmi idő, a 3 s-os munkaköz és az egyszerre egy képfeladat.
Lejátszás alatti távoli logófeladat 12 s-os közös letöltési keretet kap; egy
hangkapcsolat/kijelölt állomás által megszakított előkészítés visszakerül a sorba.

A kész logó után a rádió egyszeri WebSocket-jelzést küld. A teljes szokásos
lejátszóállapotot tartalmazza egy opcionális `stationArtworkReady` jelöléssel,
így korábbi webfelületek is biztonságosan feldolgozhatják. Az új WebUI csak
a még hiányzó mentett állomásképeket próbálja újra: nincs időzített lekérdezés,
a már látható kép nem töltődik újra, és egy régi azonos URL-es kérés sem írhatja
felül az új eredményt. A közvetlen RAM-albumborító megjelenítése változatlan.
Ehhez a körhöz a firmware és a data/LittleFS frissítése is szükséges.

## Átmeneti belsőmemória-hiány a borító letöltése után (2026-11-07)

A letöltött kép megmarad a PSRAM-ban, amíg a képpuffer foglalása rövid ideig
újrapróbálkozik. A foglalt képslot és az átmenetileg kevés belső memória
legfeljebb 1500 ms-os, 25 ms-onkénti várakozást kap. A meglévő kép-/keresési
határidő ennél korábban is megszakíthatja; számváltás és leállítás szintén
érvényes marad. Nem indul új letöltés ugyanazon foglalási kísérletek miatt.
Más foglalási hibát az újrapróbálkozás nem fed el.

A belső tartalék JPEG-nél 24 KiB és 6 KiB összefüggő blokk, PNG-nél 32 KiB
és 8 KiB marad. A képekhez továbbra is két PSRAM-slot áll rendelkezésre, és
egy megjelenített vagy olvasók által használt képet nem használunk munkapuffernek.
Tartós memóriahiánynál továbbra is az állomáslogó a biztonságos tartalék.

Egy közös, foglalásmentes állapotjelző összehangolja a borító RAM-foglalását
és dekódolását az állomás-/PNG-mentés átmeneti 6 KiB-os feladatvermével.
A mentési kérés addig a már létező, egyhelyes sorban vár, nem foglal új vermet.
Egy folyamatban levő mentés után a várakozó borító megelőzi a következő mentést.
A jelző minden sikeres, hibás és megszakított úton felszabadul. A FreeRTOS által
később visszaadott veremmemóriát is kivárhatja a fenti rövid újrapróbálkozás.

A napló várakozáskor egyszer `RAM wait`, sikeres helyreálláskor egyszer
`RAM recovered` sort ír. Normál, azonnali foglalás nem kap új naplósorokat.

## Előadói névváltozatok és duplázott névelő (2026-11-07)

Az előadónévben a külön álló ` + ` ugyanazt a szerepet kapja, mint az `&`
vagy az `and`. Egy kapcsolás utáni `the the <név>` elejéről egyetlen hibásan
ismételt névelő marad el: a rádiós `Mike and the The Mechanics` ezért egyezik
a szolgáltatók `Mike + The Mechanics` és `Mike & the Mechanics` neveivel.
A valódi `The The`, a `Duran Duran` és a névhez tapadó pluszjel nem változik.
A már igazolt, azonos MusicBrainz-azonosítóhoz tartozó névváltozatok megtartják
az elsőbbségüket; a javított közvetlen egyezést egy aliaslista nem ronthatja el.

Minden kért előadói részt továbbra is ellenőrzünk. A plusz Paul Carrack-kredit,
a Machine Mouse-feldolgozás, a karaoke-előadók, az akusztikus/élő/remix-változatok
és az eltérő számcím nem válnak elfogadott találattá. Az eredeti kijelzett név,
a cachekulcs és a számváltás ellenőrzése változatlan; a szűk javítás csak az
előadó-egyeztetésben fut. A webfelület változatlan, ehhez a körhöz firmware-frissítés kell.

## Keresésindítás és a képfeladatok memóriája (2026-11-08)

A hibás naplóban 44 744 bájt szabad belső RAM mellett a legnagyobb egybefüggő
blokk csak 12 276 bájt volt. A kereső 12 288 bájtos feladatverme ezért nem
jött létre; a szolgáltatók lekérdezéséig sem jutott el. A három másodpercenkénti
újrapróbálkozás nem változtatott ezen. A november 7-i működő és a november 8-i
csomagban az indítás és a veremméret azonos; a rendelkezésre álló napló nem
azonosítja, pontosan mely foglalások alakították ki ezt a memóriaelrendezést.

A régi feladatban a `vTaskDelete(nullptr)` a külső hatókör `String`-jeinek és
szegmensvektorának megsemmisítése előtt futott. A FreeRTOS a feladat saját
heap-puffereit nem szabadítja fel, így ezek hosszabb logó-/számváltási sorozatok
alatt megmaradhattak. Ez külön, korábban is meglévő erőforrás-kezelési hiba.

Mind a hat képfeladat ugyanazt az induláskor létrehozott háttérmunkást használja:
borítókeresés, logóletöltés, beágyazott kép, LCD-bélyegkép, csatornaválasztó
kis logója és böngészőből importált kép. Az egyhelyes sor statikus tárolót
használ, a küldés nem várakozik. Az eddigi közös foglaltsági jelző továbbra
is csak egy képmunkát enged be. Minden munka normál függvényvisszatéréssel
fejeződik be; a helyi pufferek felszabadulnak, mielőtt a foglaltság megszűnik.
Hibás kép és megszakított letöltés után is visszatér a várakozó munkás.

A verem marad 12 KiB, belső DRAM-ban; nem kerül PSRAM-ba és nem lesz kisebb.
A fordított programban a verem, feladatvezérlő és sor együtt kb. 12,5 KiB
állandó helyet foglal. Ez üresjáratban is foglalt, cserébe futáskor nem kell
új nagy memóriablokkot keresni. Albumkeresés közben a korábbi feladat ugyanekkora
vermet és vezérlőt foglalt a heapből; a kisebb logómunkák az eddigi 8 KiB helyett
ugyanezt a 12 KiB-os vermet használják. Nincs második képfeldolgozó vagy új
egyidejű képfeladat. Az alapprioritás 0, a létrehozás `tskNO_AFFINITY` marad.

A JPEG/PNG belsőmemória-tartalékai, PSRAM-képslotjai, keresési határidői és
számváltási/megszakítási feltételei változatlanok. A spektrum és a hangkimenet
kódja nem módosul. Ehhez a javításhoz csak firmware-frissítés szükséges;
a meglévő 1.2.07 webfelület és adatcsomag használható.
