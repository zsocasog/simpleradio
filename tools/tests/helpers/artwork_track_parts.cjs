// Execute the production parser bodies; erase C++ types/views only. The same
// header is independently compiled with constexpr fixtures by the S3 compiler.
const fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../../../src/artwork/artwork_track_parts.h'),'utf8');
function body(name){const at=source.indexOf('{',source.indexOf(name));let depth=0;for(let i=at;i<source.length;i++){if(source[i]==='{')depth++;if(source[i]==='}'&&!--depth)return source.slice(at,i+1);}throw Error(name);}
function translate(code){return code
 .replace(/\\xe2\\x80\\x93/g,'–').replace(/\\xe2\\x80\\x94/g,'—')
 .replace(/c \+ \('a' - 'A'\)/g,'String.fromCharCode(c.charCodeAt(0)+32)')
 .replace(/for \(const char\* (\w+) : \{([^}]+)\}\)/g,'for (const $1 of [$2])')
 .replace(/const string_view (\w+)\((\w+)\);/g,'const $1=$2;')
 .replace(/\bconst (?:size_t|char|auto) /g,'const ').replace(/\b(?:size_t|char|auto) /g,'let ')
 .replace('string_view tail;','let tail="";').replace('char stack[8] = {};','const stack=Array(8).fill(0);')
 .replace('let stack[8] = {};','const stack=Array(8).fill(0);')
 .replace(/sizeof\(stack\)/g,'8').replace(/string_view::npos/g,'-1')
 .replace(/\.size\(\)/g,'.length').replace(/([\w.]+)\.empty\(\)/g,'($1.length === 0)')
 .replace(/([\w.]+)\.back\(\)/g,'$1.at(-1)').replace(/ArtworkTitleMatch::wordChar/g,'wordChar')
 .replace('return {text, {}, {}, {}, true, false, pass == 0};','return {main:text,guest:"",version:"",tail:"",feature:true,valid:false,explicitCredit:pass==0};')
 .replace('return {text, {}, {}, {}, false, true};','return {main:text,guest:"",version:"",tail:"",feature:false,valid:true,explicitCredit:false};')
 .replace('return {main, guest, version, tail, true, !(main.length === 0) && !(guest.length === 0), pass == 0};',
          'return {main,guest,version,tail,feature:true,valid:main.length>0 && guest.length>0,explicitCredit:pass==0};');}
const trim=s=>s.trim();
const wordChar=c=>c>='a'&&c<='z'||c>='0'&&c<='9';
const lower=new Function('c',translate(body('char lower(')));
const space=new Function('c',body('bool space('));
const equalAt=new Function('lower','text','at','token',translate(body('bool equalAt('))).bind(null,lower);
const versionText=new Function('lower','wordChar','equalAt','text',translate(body('bool versionText('))).bind(null,lower,wordChar,equalAt);
const closingGroup=new Function('text','at',translate(body('size_t closingGroup(')));
const parse=new Function('trim','space','equalAt','closingGroup','versionText','text',translate(body('Parts parse('))).bind(null,trim,space,equalAt,closingGroup,versionText);
module.exports={parse,versionText};
