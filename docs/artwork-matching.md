# Album artwork matching

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
