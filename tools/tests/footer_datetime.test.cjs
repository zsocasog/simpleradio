const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const test=require('node:test');
const read=f=>fs.readFileSync(path.join(__dirname,'../..',f),'utf8');
const source=read('src/display/display.cpp'),fonts=read('src/display/lcd_font_data.h');
function metrics(name) {
 const glyphs=new Map([...fonts.match(new RegExp('kLcdFont'+name+'Glyphs\\[\\][^]*?= \\{([^]*?)\\n\\};'))[1].matchAll(/\{0x([0-9a-f]+),\s*(\d+),\s*(\d+),\s*(\d+),\s*(-?\d+),\s*(-?\d+),\s*(\d+)\}/g)]
   .map(m=>[String.fromCodePoint(parseInt(m[1],16)),{width:+m[3],height:+m[4],x:+m[5],y:+m[6],advance:+m[7]}]));
 const lineHeight=+fonts.match(new RegExp('kLcdFont'+name+' PROGMEM = \\{[^}]+, \\d+, (\\d+), \\d+\\}'))[1];
 return {glyphs,lineHeight};
}
test('larger date/time remains inside the player footer on 480x320 and 320x240 LCDs',()=>{
 const body=source.match(/static void drawDateTimeFooter\([^]*?\n\}/)[0];assert.match(body,/setUiFont\(3\)/);
 for(const [width,height,name] of [[480,320,'Large'],[320,240,'Medium']]) {
  const f=metrics(name),center=height-Math.round(34*height/320);
  for(const text of ['2026.11.15.  23:59','2026-11-15  00:00','8888.08.28.  08:08']) {
   const glyphs=[...text].map(c=>f.glyphs.get(c)),textWidth=glyphs.reduce((s,g)=>s+g.advance,0);
   assert.ok(textWidth<=width-Math.round(44*width/480),[width,text,textWidth]);
   assert.ok(center-Math.floor(f.lineHeight/2)+Math.max(...glyphs.map(g=>g.y+g.height))<height);
  }
 }
 assert.match(body,/stamp == dateTimeFooterMinuteStamp\) return/); // Still only redraw on a minute change.
});

test('station name uses the same readable footer size and still fits long names',()=>{
 const body=source.match(/static void drawStationFooter\([^]*?\n\}/)[0];
 assert.match(body,/setUiFont\(3\)/);
 assert.match(body,/fitText\(station, SCREEN_W - sx\(44\)\)/);
 assert.match(body,/middle_center/);
});
