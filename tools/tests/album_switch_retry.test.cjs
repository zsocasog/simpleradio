const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const test = require('node:test');
const root = path.resolve(__dirname, '../..');
const cpp = fs.readFileSync(path.join(root, 'src/artwork/artwork_cache.cpp'), 'utf8');
function body(marker) {
  const at = cpp.indexOf(marker); assert.ok(at >= 0, marker);
  const start = cpp.indexOf('{', at); let depth = 0;
  for (let i = start; i < cpp.length; i++) {
    if (cpp[i] === '{') depth++;
    if (cpp[i] === '}' && --depth === 0) return cpp.slice(start, i + 1);
  }
  throw Error(marker);
}
function js(code) {
  return code.replace(/Display::instance\(\)\.render\(DisplayPresenter::build\(PlayerState::instance\(\)\)\);/g, 'render();')
    .replace(/PlayerState::instance\(\)/g, 'player').replace(/ArtworkJobKind::/g, 'Job.')
    .replace(/PickerLogoLoader::/g, 'PickerLogoLoader.')
    .replace('std::vector<uint32_t> segments = job ? job->segments : std::vector<uint32_t>();', 'let segments = job ? job.segments : [];')
    .replace(/\b(?:const )?(?:ArtworkCache\*|ArtworkJobKind|PlayerStateSnapshot|String|uint32_t|bool) (\w+)/g, 'let $1')
    .replace(/->/g, '.').replace(/nullptr/g, 'null').replace(/\.length\(\)/g, '.length')
    .replace('delete job;', 'dispose(job);');
}
const start = cpp.indexOf('  if (config.displayArtworkMode == "album" && state.playing &&\n      state.artist.length() && state.title.length() &&\n      !state.hasStreamImage && activeAlbumArtworkKey == requestedAlbumKey &&');
assert.ok(start > 0);
const schedule = js(cpp.slice(start, cpp.indexOf('\n  bool albumThumbnailReady', start)))
  .replace('let existingAlbumPath;', 'let existingAlbumPath="";')
  .replace('findExistingCachePath(requestedAlbumKey, existingAlbumPath)', '(existingAlbumPath=findExistingCachePath(requestedAlbumKey))');
const worker = js(body('void ArtworkCache::runDownloadJob('))
  .replace('cache.resolveAndDownloadAlbumArtwork(artist, title, key, path)',
    'cache.resolveAndDownloadAlbumArtwork(artist,title,key,value=>path=value)');
const take = js(body('bool ArtworkCache::takeDownloadResult('))
  .replace('url = resultUrl;', 'out.url=resultUrl;').replace('path = resultPath;', 'out.path=resultPath;')
  .replace('success = resultSuccess;', 'out.success=resultSuccess;').replace('cancelled = resultCancelled;', 'out.cancelled=resultCancelled;');
const key = name => `album:v5:artist-${name}|song-${name}`;
const image = name => `/api/artwork/album?id=cached-${name}`;

function harness() {
  const jobs=[], cache=new Map([[key('A'),image('A')]]), traces=[], removed=[];
  let serial=0, disposed=0, provider=()=>false;
  const generation={value:0,load(){return this.value;},fetch_add(n){this.value=(this.value+n)>>>0;}};
  const c=vm.createContext({
    now:10000,config:{displayArtworkMode:'album'},state:null,requestedAlbumKey:'',activeAlbumArtworkKey:'',
    audioConnectionReady:true,audioConnectionReadyMs:1,
    albumSearchGeneration:generation,lastAlbumLookupKey:'',lastAlbumLookupMs:0,lastAlbumStartFailed:false,
    previousAlbumArtworkPath:'',ALBUM_ART_CACHE_PREFIX:'album:v5:',ALBUM_ART_START_RETRY_MS:3000,ALBUM_ART_MISSING_RETRY_MS:120000,
    resultMutex:{},resultReady:false,resultSuccess:false,resultCancelled:false,resultUrl:'',resultPath:'',
    xSemaphoreTake:()=>1,xSemaphoreGive(){},pdTRUE:1,pdMS_TO_TICKS:x=>x,
    millis:()=>c.now,Serial:{printf(){},println(){}},albumArtTrace:(...args)=>traces.push(args),
    Job:Object.fromEntries(['Url','AlbumSearch','PickerLogo','Embedded','Thumbnail','BrowserImport'].map(x=>[x,x])),
    dispose(){disposed++;},render(){},requestLcdThumbnail(){},refreshArtworkIfThumbnailReady(){},
    findExistingCachePath:k=>cache.get(k)||'',removeCachedArtworkFamily:p=>{removed.push(p);for(const [k,v] of cache)if(v===p)cache.delete(k);},
    startAlbumArtworkTask:(artist,title,k)=>{jobs.push({id:++serial,kind:'AlbumSearch',key:k,artist,title,
      albumSearchGeneration:generation.load(),url:'',segments:[],cache:backend});return true;},
    player:{snapshot:()=>({...c.state}),setAlbumArtworkPath:p=>c.state.albumArtworkPath=p}
  });
  vm.runInContext(`function schedule() { ${schedule} }
    function run(job) ${worker}
    function connectStarting() ${body('void ArtworkCache::notifyAudioConnectStarting(')}
    function store(url,path,success,cancelled=false) ${body('void ArtworkCache::storeDownloadResult(')}
    function take(out) ${take}
    function releaseCancelled() ${body('if (completedCancelled)')}
    function failedAlbum() ${js(body('if (completedUrl.startsWith("album:"))'))}
    function readyAlbum() ${js(body('} else if (completedUrl.startsWith("album:"))'))}`,c);
  const backend={
    albumSearchGeneration:generation,idlePrewarmCancellationRequested:()=>false,
    resolveAndDownloadAlbumArtwork:(artist,title,k,setPath)=>provider({artist,title,key:k,setPath}),
    storeDownloadResult:(...args)=>c.store(...args),download:()=>false
  };
  function select(name,{advance=true,playing=true}={}) {
    if(advance)c.connectStarting();
    c.state={playing,artist:`artist-${name}`,title:`song-${name}`,hasStreamImage:false,albumArtworkPath:''};
    c.activeAlbumArtworkKey=c.requestedAlbumKey=key(name);
    c.audioConnectionReady=true;c.audioConnectionReadyMs=c.now-2000;
  }
  function complete(job=jobs.at(-1)) {
    c.run(job);const out={};assert.equal(c.take(out),true);
    c.completedUrl=out.url;
    if(out.cancelled)c.releaseCancelled();
    else if(!out.success&&out.url.startsWith('album:'))c.failedAlbum();
    else if(out.success){cache.set(out.url,out.path);c.completedPath=out.path;c.readyAlbum();}
    return out;
  }
  select('A',{advance:false});
  return {c,jobs,cache,traces,removed,generation,select,complete,
    provider(fn){provider=fn;},tick(){c.schedule();},disposed:()=>disposed};
}

test('cached Danubius -> interrupted B -> cached Danubius -> B retries without the 120s penalty',()=>{
  const h=harness();h.tick();assert.equal(h.c.state.albumArtworkPath,image('A'));assert.equal(h.jobs.length,0);
  h.select('B');h.tick();const job=h.jobs[0];assert.equal(h.c.lastAlbumLookupKey,key('B'));
  h.select('A');h.tick();assert.equal(h.c.state.albumArtworkPath,image('A'));
  const out=h.complete(job);assert.equal(out.cancelled,true);assert.equal(h.c.lastAlbumLookupKey,'');
  assert.equal(h.c.state.albumArtworkPath,image('A'));assert.deepEqual(h.removed,[]);
  h.select('B');h.c.now+=2000;h.tick();assert.equal(h.jobs.length,2);
  assert.equal(h.cache.get(key('A')),image('A'));
});

test('B -> A -> B before the old HTTP call returns is still a cancelled attempt',()=>{
  const h=harness();h.select('B');h.tick();
  h.provider(()=>{h.select('A');h.select('B');return false;});
  const out=h.complete();assert.equal(out.cancelled,true);assert.equal(h.c.lastAlbumLookupKey,'');
  h.tick();assert.equal(h.jobs.length,2);assert.equal(h.disposed(),1);
});

test('a cancelled attempt waits for the audio connection and its existing 1500ms grace before restarting',()=>{
  const h=harness();h.select('B');h.tick();h.select('A');assert.equal(h.complete().cancelled,true);
  h.select('B');h.c.audioConnectionReady=false;h.tick();assert.equal(h.jobs.length,1);
  h.c.audioConnectionReady=true;h.c.audioConnectionReadyMs=h.c.now;
  h.tick();assert.equal(h.jobs.length,1);
  h.c.now+=1499;h.tick();assert.equal(h.jobs.length,1);
  h.c.now+=1;h.tick();assert.equal(h.jobs.length,2);
});

test('a completed genuine miss retains its two-minute backoff',()=>{
  const h=harness();h.select('B');h.tick();h.c.now+=1500;
  const out=h.complete();assert.equal(out.cancelled,false);assert.equal(h.c.lastAlbumLookupKey,key('B'));
  h.c.now+=119999;h.tick();assert.equal(h.jobs.length,1);
  h.c.now+=1;h.tick();assert.equal(h.jobs.length,2);
});

test('a completed cover for the same song remains reusable after a fast round trip',()=>{
  const h=harness();h.select('B');h.tick();
  h.provider(({setPath})=>{h.select('A');h.select('B');setPath(image('B'));return true;});
  const out=h.complete();assert.equal(out.success,true);assert.equal(out.cancelled,false);
  assert.equal(h.c.state.albumArtworkPath,image('B'));
  h.select('A');h.tick();assert.equal(h.c.state.albumArtworkPath,image('A'));
  h.select('B');h.tick();assert.equal(h.c.state.albumArtworkPath,image('B'));assert.equal(h.jobs.length,1);
});

test('stopping playback or receiving different song metadata cancels without a false miss',()=>{
  for(const change of [h=>{h.c.state.playing=false;},h=>{h.c.state.title='different song';}]){
    const h=harness();h.select('B');h.tick();h.provider(()=>{change(h);return false;});
    assert.equal(h.complete().cancelled,true);assert.equal(h.c.lastAlbumLookupKey,'');
  }
});

test('a stale cancelled result cannot release another song\'s miss backoff or erase its image',()=>{
  const h=harness();h.select('B');h.tick();h.select('C');
  h.c.lastAlbumLookupKey=key('C');h.c.lastAlbumLookupMs=9000;h.c.lastAlbumStartFailed=true;
  h.c.state.albumArtworkPath=image('C');h.c.previousAlbumArtworkPath=image('A');
  assert.equal(h.complete().cancelled,true);
  assert.equal(h.c.lastAlbumLookupKey,key('C'));assert.equal(h.c.lastAlbumLookupMs,9000);
  assert.equal(h.c.lastAlbumStartFailed,true);assert.equal(h.c.state.albumArtworkPath,image('C'));
  assert.deepEqual(h.removed,[]);assert.equal(h.cache.get(key('A')),image('A'));
});

test('the result mailbox clears cancellation and never leaks it into the next failure',()=>{
  const h=harness();h.c.store(key('B'),'',false,true);const out={};assert.equal(h.c.take(out),true);
  assert.equal(out.cancelled,true);assert.equal(h.c.resultCancelled,false);assert.equal(h.c.take({}),false);
  h.c.store(key('C'),'',false);const next={};assert.equal(h.c.take(next),true);assert.equal(next.cancelled,false);
  h.c.store(key('A'),image('A'),true,true);assert.equal(h.c.take(next),true);assert.equal(next.cancelled,false);
});

test('station-logo failures keep their original handling across playback generations',()=>{
  const h=harness();h.select('B');h.tick();const job=h.jobs[0];
  job.kind='Url';job.key='';job.url='https://station.example/logo.png';h.select('A');
  const out=h.complete(job);assert.equal(out.cancelled,false);assert.equal(out.success,false);
  assert.equal(out.url,job.url);
});

test('generation wraparound still distinguishes a cancelled attempt',()=>{
  const h=harness();h.generation.value=0xffffffff;h.select('B',{advance:false});h.tick();
  h.provider(()=>{h.select('A');h.select('B');return false;});assert.equal(h.complete().cancelled,true);
});

test('the worker captures its attempt generation before the job is queued',()=>{
  const start=body('bool ArtworkCache::startAlbumArtworkTask(');
  assert.match(start,/job->albumSearchGeneration = albumSearchGeneration.load\(\)/);
  assert.ok(start.indexOf('job->albumSearchGeneration')<start.indexOf('queueDownloadJob(job)'));
});
