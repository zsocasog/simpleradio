const test=require('node:test'),assert=require('node:assert/strict');
const csv=require('../../data/station-playlist.js');
const sample='A Rock 103.9\thttps://icast.connectmedia.hu/5301/live.mp3\t0\nForrás Rádió\thttps://example.hu/radio\t-5\nDanubius\thttps://stream.danubiusradio.hu/danubius_320k\t0\n';
test('yoRadio tabs, UTF8 names, BOM, CRLF, empty lines and ignored ovol preserve file order',()=>{
  const result=csv.parse('\ufeff\r\n'+sample.replace(/\n/g,'\r\n')+'\r\n');
  assert.deepEqual(result.errors,[]);assert.equal(result.entries.length,3);
  assert.equal(result.entries[1].name,'Forrás Rádió');assert.equal(result.ignoredOvol,1);
  assert.deepEqual(result.entries.map(x=>x.line),[2,3,4]);
});
test('comma and semicolon CSV correctly read quoted separators and escaped quotes',()=>{
  for(const text of ['"Rock, Jazz","https://example.org/a,b",0','"Rock; Jazz";"https://example.org/a;b";0',
    '"The ""Radio""",https://example.org/live,0']){
    const result=csv.parse(text);assert.equal(result.errors.length,0,text);assert.equal(result.entries.length,1);
  }
  assert.equal(csv.parse('"The ""Radio""",https://example.org/live,0').entries[0].name,'The "Radio"');
  assert.equal(csv.parse('name,url,ovol\nTest,https://example.org,0').entries.length,1);
});
test('literal quotes in original yoRadio TSV roundtrip without adding quote characters',()=>{
  const stations=[{name:'"Jazz" & Blues, élő',url:'https://example.org/a?b=c,d;e=f'}];
  const text=csv.serialize(stations);assert.equal(text,'"Jazz" & Blues, élő\thttps://example.org/a?b=c,d;e=f\t0\r\n');
  assert.deepEqual(csv.parse(text).entries.map(({name,url})=>({name,url})),stations);
});
test('append keeps saved metadata and order, skips exact URL duplicates in either list',()=>{
  const saved=[{id:5,name:'Saved',url:'https://example.org/live',logo:'/logos/a.png'}];
  const entries=[{name:'Renamed',url:' https://example.org/live '},{name:'New',url:'https://example.org/new'},
    {name:'Repeated',url:'https://example.org/new'}];
  const result=csv.plan(saved,entries,'append');
  assert.equal(result.added,1);assert.equal(result.skipped,2);assert.equal(result.total,2);
  assert.deepEqual(result.rows[0],saved[0]);assert.equal(result.rows[1].name,'New');assert.equal(saved.length,1);
});
test('replace contains only unique CSV rows in file order; old list is not mutated',()=>{
  const saved=[{id:3,name:'Old',url:'https://old.example.org'}];
  const result=csv.plan(saved,csv.parse(sample+sample).entries,'replace');
  assert.equal(result.added,3);assert.equal(result.skipped,3);assert.equal(result.total,3);
  assert.equal(result.rows[0].name,'A Rock 103.9');assert.equal(saved[0].name,'Old');
  assert.throws(()=>csv.plan(saved,[],'bad'),/invalid/);
});
test('malformed, empty, unsafe and excessive data is visible as errors, never silently imported',()=>{
  for(const text of ['', 'Only a name', 'Radio\tjavascript:alert(1)\t0', 'Radio\thttps:///bad\t0',
    'Radio\thttps://example.org/a b\t0', '\thttps://example.org\t0', 'A\0B\thttp://example.org\t0',
    'A\thttp://example.org\t0\textra', '"Unclosed,https://example.org,0'])
    assert.ok(csv.parse(text).errors.length,text);
  assert.equal(csv.parse('x'.repeat(csv.MAX_BYTES+1)).errors[0].code,'limit');
  assert.ok(csv.parse(Array.from({length:501},(_,i)=>`Radio ${i}\thttps://example.org/${i}\t0`).join('\n')).errors.some(x=>x.code==='limit'));
  assert.equal(csv.plan(Array.from({length:500},(_,i)=>({name:'R',url:'http://example.org/'+i})),[{name:'New',url:'http://example.org/new'}],'append').limit,true);
  assert.equal(csv.valid('á'.repeat(81),'http://example.org'),'nameError');
});
test('export is a browser-only yoRadio playlist: no header, same order, zero ovol, complete roundtrip',()=>{
  const rows=csv.parse(sample).entries;
  const output=csv.serialize(rows);assert.ok(!output.startsWith('name'));assert.ok(!output.startsWith('\ufeff'));
  assert.ok(output.endsWith('\r\n'));assert.equal(output.split('\r\n').filter(Boolean).every(x=>x.split('\t')[2]==='0'),true);
  assert.deepEqual(csv.parse(output).entries.map(({name,url})=>({name,url})),rows.map(({name,url})=>({name,url})));
  assert.throws(()=>csv.serialize([{name:'Bad\nName',url:'http://example.org'}]),/nameError/);
});
