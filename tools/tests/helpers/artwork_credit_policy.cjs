// Execute production C++ bodies; the same policy also has ESP32-compiled
// constexpr fixtures. This adapter changes language syntax, not decisions.
const fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../../../src/artwork/artwork_credit_policy.h'),'utf8');
const titles=require('./artwork_title_policy.cjs');
function body(marker){const start=source.indexOf('{',source.indexOf(marker));let depth=0;for(let i=start;i<source.length;i++){if(source[i]==='{')depth++;if(source[i]==='}'&&!--depth)return source.slice(start,i+1);}throw Error(marker);}
const Reason=Object.fromEntries(['Match','Bounds','Primary','Guest','ExtraPrimary','ShortNameEvidence'].map(x=>[x,x]));
const verdict=(reason,shortened)=>({reason,shortened,matched:()=>reason===Reason.Match});
function syntax(code){return code
 .replace(/ArtworkTitleMatch::/g,'titles.').replace(/Reason::/g,'Reason.')
 .replace(/string_view::npos/g,'-1').replace(/string_view\("([^"]*)"\)/g,'"$1"')
 .replace(/\bconst (?:auto|size_t) /g,'const ').replace(/\b(?:size_t|bool|string_view) /g,'let ')
 .replace(/\.size\(\)/g,'.length').replace(/\.empty\(\)/g,'.length === 0').replace(/\.find\(/g,'.indexOf(')
 .replace(/for \(char (\w+) : ([^)]+)\)/g,'for (const $1 of $2)')
 .replace(/for \(const auto (\w+) : \{([\s\S]*?)\}\)/g,'for (const $1 of [$2])')
 .replace(/for \(const (\w+) : \{([\s\S]*?)\}\)/g,'for (const $1 of [$2])')
 .replace(/auto (\w+) = \[&\]\(([^)]*)\)/g,'const $1 = ($2) =>')
 .replace(/return \{(Reason\.\w+), ([^}]+)\};/g,'return verdict($1,$2);');}
const addCode=syntax(body('constexpr void add(')).replace(/\bnames\b/g,'state.names').replace(/\bsize\b/g,'state.size').replace(/\bvalid\b/g,'state.valid');
const add=new Function('titles','MAX_CREDITS','state','name',addCode).bind(null,{...titles,trim:s=>s.trim()},12);
const makeCredits=()=>{const state={names:[],size:0,valid:true};state.add=name=>add(state,name);return state;};
const splitCode=syntax(body('constexpr Credits split(')).replace('Credits result;','const result=makeCredits();');
const split=new Function('makeCredits','MAX_CREDIT_BYTES','text',splitCode).bind(null,makeCredits,384);
const shortenedName=new Function('titles','left','right',syntax(body('constexpr bool shortenedName('))).bind(null,titles);
const compareCode=syntax(body('constexpr Verdict compare(')).replace('let usedMain[MAX_CREDITS] = {};','const usedMain=Array(MAX_CREDITS).fill(false);').replace(/\(let name, let mainOnly\)/g,'(name,mainOnly)');
const compare=new Function('Reason','verdict','MAX_CREDITS','shortenedName','foundMain','foundGuests','wantedMain','wantedGuests','sameName',compareCode).bind(null,Reason,verdict,12,shortenedName);
module.exports={split,shortenedName,compare,label:reason=>new Function('Reason','reason',syntax(body('constexpr const char* label(')))(Reason,reason)};
