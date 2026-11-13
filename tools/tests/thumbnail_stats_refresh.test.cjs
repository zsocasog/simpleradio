const fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.resolve(__dirname,'../../src/artwork/artwork_cache.cpp'),'utf8');
function body(marker){const at=source.indexOf('{',source.indexOf(marker));let depth=0;for(let i=at;i<source.length;i++){if(source[i]==='{')depth++;if(source[i]==='}'&&!--depth)return source.slice(at,i+1);}throw Error(marker);}
function run(kind,playing,diskWrite,pending=false){
 const order=[];let writes=0;
 const cache={cacheStatsPending:{load:()=>pending,store:v=>{pending=v;}},lcdDiskWrites:{load:()=>writes},refreshCacheStats:()=>order.push('stats'),markDownloadFinished:()=>order.push('finished')};
 const code=body('void ArtworkCache::downloadTask(')
  .replace('ArtworkCache* cache = static_cast<ArtworkCache*>(param);','const cache=param;')
  .replace('ArtworkDownloadJob* job = nullptr;','let job=null;')
  .replace('if (xQueueReceive(artworkJobQueue, &job, portMAX_DELAY) != pdTRUE) continue;','if (supplied) return; supplied=true; job=input;')
  .replace(/const (?:bool|uint32_t) /g,'const ').replace(/->/g,'.')
  .replace(/ArtworkJobKind::/g,'Kind.').replace('PlayerState::instance()','PlayerState.instance()');
 const Kind={Url:'url',Thumbnail:'thumbnail',AlbumSearch:'album',PickerLogo:'picker',CacheStats:'stats'};
 const worker=new Function('input','Kind','PlayerState','runDownloadJob',`let supplied=false;return function(param)${code}`)(
  {kind},Kind,{instance:()=>({snapshot:()=>({playing})})},()=>{order.push('job');if(diskWrite)writes++;});
 worker(cache);return {order,pending};
}
test('playing cached and RAM-only thumbnails finish without a full filesystem usage walk',()=>{
 assert.deepEqual(run('thumbnail',true,false),{order:['job','finished'],pending:false});
});
test('playing writes defer maintenance while stopped writes refresh before releasing the worker',()=>{
 assert.deepEqual(run('thumbnail',true,true),{order:['job','finished'],pending:true});
 assert.deepEqual(run('thumbnail',false,true).order,['job','stats','finished']);
 assert.deepEqual(run('thumbnail',false,false).order,['job','finished']);
});
test('downloaded originals defer their scan and cached/RAM jobs do not manufacture dirty statistics',()=>{
 assert.deepEqual(run('url',true,true),{order:['job','finished'],pending:true});
 for(const kind of ['album','picker','stats'])assert.deepEqual(run(kind,true,false),{order:['job','finished'],pending:false});
 assert.deepEqual(run('stats',false,false,true).order,['job','stats','finished']);
});
test('disk revision advances only after the temporary LCD file was committed successfully',()=>{
 const prepare=body('bool ArtworkCache::ensureLcdThumbnailPrepared(');
 assert.equal((prepare.match(/\+\+lcdDiskWrites/g)||[]).length,1);
 assert.ok(prepare.indexOf('++lcdDiskWrites')>prepare.indexOf('if (!LittleFS.rename(tempPath, thumbPath))'));
 assert.ok(prepare.indexOf('++lcdDiskWrites')>prepare.indexOf('if (published)'));
});
