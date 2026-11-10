# Vendégelőadó és verzió az albumborító-keresésben

A számcím felbontása az eredeti szövegen történik, az írásjelek normalizálása előtt. Külön marad a cím, a vendégelőadó és a verziójelölés. Az LCD-n/webfelületen kijelzett eredeti metaadat és a gyorsítótár kulcsa nem változik.

## Elfogadási szabályok

- A `feat.`, `feat`, `ft.`, `ft`, `featuring` jelölés felismerhető kis- és nagybetűvel, zárójelben is.
- A vendégnévben lévő `Mix`, `Live` vagy szám nem automatikus verziójelölés. Például a **Little Mix**, **Mix Master Mike** és **Maroon 5** név lehet igazolt vendégelőadó.
- A vendégnév után külön zárójelben vagy kötőjellel érkező verzió megmarad. A `Song (Remix) feat. Little Mix` és a `Song feat. Little Mix (Remix)` egyezhet a megfelelő remixszel.
- A `Song feat. Little Mix Remix` bizonytalan alakból csak a szolgáltató előadóadataival igazolt teljes név választható le. A leghosszabb igazolt név élvez elsőbbséget; a maradék verziót külön egyeztetjük.
- A kért vendégelőadót a találat előadómezőjének vagy kifejezett címadatának igazolnia kell. Egy másik vendég, illetve egy további, nem kért résztvevő nem helyettesítheti.
- A címelírások megengedése sem módosíthat egy megnevezett remixet. A `DJ A Remix` és `DJ B Remix` különböző változat.
- A `with` közönséges címszó is lehet. Az egyértelmű `feat.` jelölés elsőbbséget kap, a sima `with` csak előadói bizonyítékkal választódik le. A `Stay With Me` címet nem rövidítjük `Stay` alakra.
- Az előadómezőben a meglévő `+`, `&`, vessző és vendégjelölések működnek. Egy pusztán szóközös névlista csak akkor egyezhet, ha a másik oldal külön felsorolt teljes előadónevei minden szót lefednek; nem maradhat extra szó.
- A megerősített előadói álnevek továbbra is használhatók. Az azonosság igazolása után a tényleges szolgáltatói névvel újra lefut a vendég- és verzióellenőrzés is.
- A gyengébb, alcímre vagy zárójeles előadói felsorolásra épülő egyezés sem kerülheti meg a vendégellenőrzést.

## Ellenőrzések és határok

- A konkrét CNCO / Reggaeton Lento / Little Mix eset pozitív próba.
- Eltérő vendég, eltérő remix, Sped Up, Live, karaoke, hibás cím és hiányzó előadói bizonyíték negatív próbák.
- A C++ felbontó az ESP32 fordítójával, fordításidejű tesztesetekkel is ellenőrzött; az Arduino `word()` makrójával való együttélés is szerepel.
- A JavaScript-próbák a gyártási C++ függvények törzsét futtatják vékony típus-/szövegnézet-adaptációval. A korábbi előadói, évszámos és alcímes próbák ugyanazt a közös hidat használják.
- Nincs új szolgáltató, külön háttérfeladat vagy tartós képbuffer. A feltételes előadói álnév-ellenőrzés a meglévő egyszeri, időkerettel védett folyamatot használja.
- Ez a javítás a szöveges találat-ellenőrzésre vonatkozik. A szolgáltatók aktuális adatbázisát, illetve a napló lezáró sorainak esetleges elvesztését nem igazolja vagy javítja önmagában.

Az új keresési szabály csak az új firmware feltöltése után fut a rádión. A webes data tartalma ehhez a módosításhoz nem változott.

## 2026. november 10-i ellenőrzött csomag

- Firmware 1.2.09, fordításazonosító: `f89636d29`.
- 523 JavaScript- és 48 Python-teszt sikeres; az utóbbi tartalmazza a tényleges C++ felbontó fordítását is.
- A teljes firmware és a LittleFS csomag fordítása sikeres. A statikus RAM-foglalás változatlanul 104 380 bájt.
- Az OTA-csomag és lenyomatai helyben: `.pio/verified-artifacts/artwork-features-20261110`.
- Ebben a körben a rádióra nem történt feltöltés és élő adásos próba. A készüléken futó korábbi stabil változat megmaradt; az új szövegkezeléshez a firmware-t kell frissíteni.
