const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),test=require('node:test');
const root=path.resolve(__dirname,'../..');
const policy=fs.readFileSync(path.join(root,'src/artwork/album_search_policy.h'),'utf8');
const source=fs.readFileSync(path.join(root,'src/artwork/artwork_cache.cpp'),'utf8');
const marker='constexpr uint32_t archiveMetadataDeadline(';
const start=policy.indexOf('{',policy.indexOf(marker));let end=start,depth=0;
for(;end<policy.length;end++){if(policy[end]==='{')depth++;if(policy[end]==='}'&&!--depth){end++;break;}}
const code=policy.slice(start,end).replace('const int32_t left = static_cast<int32_t>(imageDeadline - now);','const left = (imageDeadline - now) | 0;')
  .replace('static_cast<int32_t>(ARCHIVE_FILE_RESERVE_MS)','ARCHIVE_FILE_RESERVE_MS')
  .replace('static_cast<uint32_t>(left)','(left >>> 0)').replace('const uint32_t available','const available')
  .replace(/return now \+ ([^;]+);/g,'return (now + $1) >>> 0;');
const metadataDeadline=new Function('ARCHIVE_METADATA_MS','ARCHIVE_FILE_RESERVE_MS','now','imageDeadline',code).bind(null,2000,6000);
test('logged 4534ms redirect leaves at least 6 seconds for the actual JPEG after optional metadata times out',()=>{
 const started=1000,deadline=started+12000,afterRedirect=started+4534;
 const metadataEnd=metadataDeadline(afterRedirect,deadline);
 assert.equal(metadataEnd,7000);assert.equal(deadline-metadataEnd,6000);
 // The logged 7725ms metadata wait is now stopped at 1466ms; file download fits.
 const fileEnd=metadataEnd+2300+400;assert.ok(fileEnd<deadline);
});
test('fast mirror lookup retains both existing direct servers, within a two-second maximum',()=>{
 assert.equal(metadataDeadline(1250,13000),3250);
});
test('late/expired image windows skip optional metadata, while millis rollover remains bounded',()=>{
 assert.equal(metadataDeadline(7000,13000),7000);assert.equal(metadataDeadline(14000,13000),14000);
 assert.equal(metadataDeadline(0xfffff000,(0xfffff000+12000)>>>0),(0xfffff000+2000)>>>0);
});
test('production resolver bounds metadata alone and retains the original file URL on metadata failure',()=>{
 const a=source.indexOf('static std::vector<String> resolveCoverArchiveServers('),b=source.indexOf('bool ArtworkCache::prepareAlbumMemory(',a);
 const resolver=source.slice(a,b);
 assert.match(resolver,/metadataOptions.deadlineMs = AlbumSearchPolicy::archiveMetadataDeadline\(millis\(\), options.deadlineMs\)/);
 assert.match(resolver,/if \(metadataOptions.deadlineMs && !deadlineReached\(metadataOptions.deadlineMs\)\)/);
 assert.match(resolver,/MAX_METADATA_BYTES, metadata, metadataOptions\)/);
 assert.match(resolver,/if \(urls.empty\(\)\) addUniqueArtworkCandidate\(urls, ArtworkHttp::publicImageUrl\(location\)\)/);
 assert.ok(resolver.includes('{"d1", "d2"}'));
 assert.equal((resolver.match(/options.deadlineMs =/g)||[]).length,0);
});
