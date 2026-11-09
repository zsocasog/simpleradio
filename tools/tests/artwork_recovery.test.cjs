const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'src/artwork/artwork_cache.cpp'), 'utf8');
function body(marker) {
  const at = source.indexOf(marker); assert.ok(at >= 0, marker);
  let start = source.indexOf('{', at);
  while (source.slice(start, start + 2) === '{}') start = source.indexOf('{', start + 2);
  let depth = 0;
  for (let i = start; i < source.length; ++i) {
    if (source[i] === '{') ++depth;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw Error(marker);
}
const strings = code => code.replace(/const String /g, 'const ').replace(/\bString /g, 'let ')
  .replace(/\.length\(\)/g, '.length').replace(/\.c_str\(\)/g, '').replace(/ArtworkHttp::/g, 'ArtworkHttp.');
const rendition = new Function('ArtworkHttp', 'encodeArtworkQuery', 'url', strings(body('static String albumJpegRenditionUrl(')))
  .bind(null, { host: url => new URL(url).host }, encodeURIComponent);
const conversion = strings(body('auto attemptJpegRendition ='))
  .replace(/const uint32_t /g,'const ').replace(/memoryUnavailable && \*memoryUnavailable/g,'memoryUnavailable.value');
const wrapper = strings(body('auto attemptAlbumImage ='))
  .replace(/const uint32_t /g,'const ')
  .replace(/bool jpegTried =/g, 'let jpegTried =')
  .replace('extension.toLowerCase();', 'extension = extension.toLowerCase();')
  .replace(/memoryUnavailable && \*memoryUnavailable/g, 'memoryUnavailable.value')
  .replace(/\bpngMemoryLow\b/g, 'pngMemoryLow()');
function attempt({ url = 'http://lastfm-img.freetls.fastly.net/i/u/300x300/cover.png',
                   album = true, low = true, secure = true, receive } = {}) {
  const calls = [], budgets = [], messages = [], memory = { value:false }; let png = false;
  const dependencies = {
    albumImage:album, albumJpegRenditionUrl:rendition, pngNeedsJpeg:()=>low, allowSecureFallback:secure,
    millis:()=>1000, boundedTimeoutMs:(ms,deadline)=>Math.min(ms,deadline-1000),
    artworkCancelled:()=>false, deadlineReached:()=>false, deadlineMs:35000,
    memoryUnavailable:memory, pngMemoryLow:()=>png,
    albumArtTrace:message=>messages.push(message),
    attemptDownload:(fetchUrl,deadline)=>{
      png=false; calls.push(fetchUrl); budgets.push(deadline);
      return receive ? receive(fetchUrl, { png:()=>png=true, memory:()=>memory.value=true }) : new URL(fetchUrl).hostname==='wsrv.nl';
    }
  };
  dependencies.attemptJpegRendition=jpegUrl=>new Function(...Object.keys(dependencies),'jpegUrl',conversion)(...Object.values(dependencies),jpegUrl);
  const run = new Function(...Object.keys(dependencies), 'fetchUrl', wrapper);
  return { ready:run(...Object.values(dependencies),url), calls, budgets, messages };
}
test('both logged Last.fm PNGs use the measured baseline converter without fetching unsupported native JPEG', () => {
  for(const hash of ['a68d047493c2fc09a06d8d0e6decb4d7','d0a4b04bf955443b83095ac7752afb4b']) {
    const png='http://lastfm-img.freetls.fastly.net/i/u/174s/'+hash+'.png';
    const result=attempt({url:png});
    assert.equal(result.ready,true);assert.equal(result.calls.length,1);assert.deepEqual(result.budgets,[4500]);
    const url=new URL(result.calls[0]);assert.equal(url.protocol,'http:');assert.equal(url.hostname,'wsrv.nl');
    assert.equal(url.searchParams.get('url'),png);assert.equal(url.searchParams.get('output'),'jpg');
  }
});
test('failed public converter transport retains the established HTTPS alternative within the same image window', () => {
  const png='https://lastfm-img.freetls.fastly.net/i/u/174s/a68d047493c2fc09a06d8d0e6decb4d7.png';
  const result=attempt({url:png,receive:url=>url.startsWith('https://wsrv.nl/')});
  assert.equal(result.ready,true);assert.equal(result.calls.length,2);
  assert.ok(result.calls[0].startsWith('http://wsrv.nl/'));assert.ok(result.calls[1].startsWith('https://wsrv.nl/'));
  assert.deepEqual(result.budgets,[4500,undefined]);
});
test('HTTPS-disabled playback does not open an encrypted conversion fallback', () => {
  const result=attempt({secure:false,receive:()=>false});
  assert.equal(result.ready,false);assert.ok(result.calls.every(url=>!url.startsWith('https://')));
});
test('the logged low-memory PNG takes the JPEG route before downloading the 66KB original', () => {
  const result=attempt();
  assert.equal(result.ready,true); assert.equal(result.calls.length,1);
  const url=new URL(result.calls[0]);
  assert.equal(url.hostname,'wsrv.nl'); assert.equal(url.searchParams.get('output'),'jpg');
  assert.equal(url.searchParams.get('w'),'250');
  assert.equal(url.searchParams.get('url'),'http://lastfm-img.freetls.fastly.net/i/u/300x300/cover.png');
});
test('a PNG detected from received bytes also gets a JPEG alternative when its suffix is misleading', () => {
  const result=attempt({url:'http://lastfm-img.freetls.fastly.net/i/u/300x300/cover.jpg',receive:(url,state)=>{
    if(new URL(url).hostname==='wsrv.nl')return true;
    state.png();return false;
  }});
  assert.equal(result.ready,true);assert.equal(result.calls.length,2);
});
test('ordinary station logos retain the original downloader even with low PNG headroom', () => {
  const url='https://danubiusradio.hu/assets/img/front/danubius_radio_album_cover_v2.png';
  const result=attempt({url,album:false,receive:()=>true});
  assert.equal(result.ready,true);assert.deepEqual(result.calls,[url]);
});
test('unrelated, signed, credentialed and API URLs cannot be sent to the public image converter', () => {
  for(const url of ['https://private.example/cover.png','https://itunes.apple.com/search?term=secret',
    'https://lastfm-img.freetls.fastly.net/cover.png?signature=secret',
    'https://user:secret@lastfm-img.freetls.fastly.net/cover.png',
    'file:///cover.png','https://notarchive.org/cover.png'])assert.equal(rendition(url),'');
});
test('critical JPEG memory failure stops instead of downloading the known oversized PNG', () => {
  const result=attempt({receive:(_url,state)=>{state.memory();return false;}});
  assert.equal(result.ready,false);assert.equal(result.calls.length,1);
});

const transportCode = strings(source.slice(source.lastIndexOf('  const String publicUrl ='), source.lastIndexOf('\n}')))
  .replace(/memoryUnavailable && \*memoryUnavailable/g, 'memoryUnavailable.value');
function transport(imageReceived) {
  const calls=[],messages=[];
  const deps={url:'https://lastfm-img.freetls.fastly.net/cover.png',
    ArtworkHttp:{publicImageUrl:()=> 'http://lastfm-img.freetls.fastly.net/cover.png',host:()=> 'lastfm-img.freetls.fastly.net'},
    albumArtTrace:message=>messages.push(message),attemptAlbumImage:url=>{calls.push(url);return false;},
    artworkCancelled:()=>false,memoryUnavailable:{value:false},deadlineReached:()=>false,
    deadlineMs:35000,allowSecureFallback:true,albumImageReceived:imageReceived};
  const result=new Function(...Object.keys(deps),transportCode)(...Object.values(deps));
  return {calls,messages,result};
}
test('a downloaded image rejected by RAM/decode never triggers a misleading HTTPS retry', () => {
  const result=transport(true);
  assert.equal(result.result,false);assert.equal(result.calls.length,1);
  assert.ok(!result.messages.some(message=>message.includes('trying advertised HTTPS')));
});
test('a genuine HTTP transport failure still gets its established advertised HTTPS fallback', () => {
  const result=transport(false);assert.equal(result.calls.length,2);
  assert.ok(result.calls[0].startsWith('http://'));assert.ok(result.calls[1].startsWith('https://'));
});
test('network and parsing use distinct deadlines while the parsed list retains its metadata deadline', () => {
  const fetch=body('static bool fetchArtworkJson(');
  assert.match(fetch,/options.deadlineMs = requestDeadlineMs \? requestDeadlineMs : deadlineMs/);
  assert.match(fetch,/auto parseStopped = \[&\]\(\) \{\s*if \(deadlineReached\(deadlineMs\)\)/);
  const resolver=body('std::vector<String> ArtworkCache::resolveAlbumArtworkUrls(');
  assert.match(resolver,/for \(JsonObject recording : recordings\) \{\s*if \(cancelled\(\) \|\| deadlineReached\(deadlineMs\)\)/);
  assert.match(resolver,/fetchArtworkJson\(url, target \? \*target : doc, deadlineMs, cancelled, &status, requestDeadlineMs\)/);
  assert.match(body('bool ArtworkCache::resolveAndDownloadAlbumArtwork('),/budget.metadataDeadline\(providerStartedMs\)/);
});
