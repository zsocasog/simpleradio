const fs=require('node:fs'),path=require('node:path');
const parts=require('./artwork_track_parts.cjs'),policy=require('./artwork_title_policy.cjs');
const source=fs.readFileSync(path.resolve(__dirname,'../../../src/artwork/artwork_cache.cpp'),'utf8');
function body(name){const at=source.indexOf('{',source.indexOf(name));let depth=0;for(let i=at;i<source.length;i++){if(source[i]==='{')depth++;if(source[i]==='}'&&!--depth)return source.slice(at,i+1);}throw Error(name);}
function strings(code){return code
 .replace(/\bnullptr\b/g,'null')
 .replace(/\(\*verifiedAliases\)/g,'verifiedAliases').replace(/\*verifiedAliases/g,'verifiedAliases').replace(/->/g,'.')
 .replace(/\.length\(\)|\.size\(\)/g,'.length').replace(/([\w.]+)\.empty\(\)/g,'($1.length === 0)')
 .replace(/\.c_str\(\)/g,'').replace(/\.push_back\(/g,'.push(').replace(/static_cast<(?:int|unsigned)>\(([^)]+)\)/g,'$1')
 .replace(/\b(\w+)\.trim\(\);/g,'$1 = $1.trim();')
 .replace('value.replace(separator, ",");','value = value.split(separator).join(",");')
 .replace('value.replace(" + ", " & ");','value = value.split(" + ").join(" & ");')
 .replace('credit.remove(0, 4);','credit = credit.substring(4);')
 .replace(/\bconst String (\w+)\s*=/g,'const $1 =')
 .replace(/auto (\w+) = \[&?\]\(([^)]*)\)/g,'const $1 = ($2) =>')
 .replace(/const ArtworkTrackParts::Parts& |std::vector<String>& |const std::vector<String>& |const String& |const String |std::string_view |String& |String /g,'')
 .replace(/\bconst (?:bool|int|size_t|auto) /g,'const ').replace(/\b(?:bool|int|size_t|auto) /g,'let ')
 .replace(/for \(const (\w+) : ([^)]+)\)/g,'for (const $1 of $2)')
 .replace(/for \((\w+) : ([^)]+)\)/g,'for (const $1 of $2)');}
const normalizeArtworkText=value=>value.toLowerCase().normalize('NFD').replace(/\p{M}/gu,'').replace(/[^a-z0-9&,]+/g,' ').trim().replace(/ +/g,' ');
let artistsCode=body('static bool artworkArtistsMatch(')
 .replace('const char* separators[] = {','const separators = [').replace(/" and ", "&", ","\s*\};/,'" and ", "&", ","\n    ];')
 .replace('for (const char* separator : separators)','for (const separator of separators)')
 .replace(/std::vector<String> (\w+);/g,'const $1 = [];').replace(/std::vector<String> (\w+) =/g,'const $1 =')
 .replace('std::vector<bool> matched(foundCredits.size(), false);','const matched = Array(foundCredits.size()).fill(false);')
 .replace('return std::vector<String>{(*verifiedAliases)[0]};','return [verifiedAliases[0]];')
 .replace('std::sort(words.begin(), words.end());','words.sort();')
 .replace(/\bconst String (\w+) =/g,'const $1 =').replace(/\bString (\w+) =/g,'let $1 =')
 .replace('joined.setCharAt(at + i, \' \');',"joined=joined.substring(0,at+i)+' '+joined.substring(at+i+1);");
artistsCode=strings(artistsCode);
const artistBody=new Function('normalizeArtworkText','artworkArtistsMatch','foundArtist','wantedArtist','verifiedAliases','allowSubset',artistsCode);
const artistsMatch=(found,wanted,aliases=null,subset=false)=>artistBody(normalizeArtworkText,artistsMatch,found,wanted,aliases,subset);

let prepareCode=body('static bool prepareArtworkTitles(')
 .replace(/ArtworkTrackParts::parse/g,'parse').replace(/ArtworkTrackParts::versionText/g,'versionText')
 .replace('String(text.data(), text.size())','text')
 .replace(/(found|wanted) = \{std::string_view\((\w+).c_str\(\), \2.length\(\)\), \{\}, \{\}, \{\}, false, true, false\};/g,'$1 = {main:$2,guest:"",version:"",tail:"",feature:false,valid:true,explicitCredit:false};')
 .replace('std::string_view(version.c_str(), version.length())','version')
 .replace(/String (\w+);/g,'let $1 = "";')
 .replace('for (const auto piece : {parts.version, parts.tail, version})','for (const piece of [parts.version, parts.tail, version])');
const refStart=prepareCode.indexOf('  auto separateVersion =');
const refEnd=prepareCode.indexOf('  separateVersion(foundGuest',refStart);
let ref=prepareCode.slice(refStart,refEnd).replace(/return;/g,'return [guest,version];');
ref=ref.replace(/\n  };\s*$/, '\n    return [guest,version];\n  };\n');
prepareCode=prepareCode.slice(0,refStart)+ref+prepareCode.slice(refEnd);
prepareCode=prepareCode.replace(/separateVersion\((foundGuest|wantedGuest), (foundVersion|wantedVersion), (\w+)\);/g,'[$1,$2]=separateVersion($1,$2,$3);')
 .replace(/return false;/g,'return {ok:false,foundTitle,wantedTitle};').replace(/return true;/g,'return {ok:true,foundTitle,wantedTitle};');
prepareCode=strings(prepareCode);
const prepare=new Function('parse','versionText','artworkArtistsMatch','foundArtist','wantedArtist','foundTitle','wantedTitle','verifiedAliases=null',prepareCode)
 .bind(null,parts.parse,parts.versionText,artistsMatch);

function trackCode(name){return strings(body(name)
 .replace('if (!prepareArtworkTitles(foundArtist, wantedArtist, foundTitle, wantedTitle, verifiedAliases)) return false;',
  'const prepared=prepareArtworkTitles(foundArtist,wantedArtist,foundTitle,wantedTitle,verifiedAliases); if(!prepared.ok)return false; foundTitle=prepared.foundTitle; wantedTitle=prepared.wantedTitle;')
 .replace(/ArtworkTitleMatch::/g,'policy.').replace(/ArtworkTrackParts::versionText/g,'versionText')
 .replace('String(stripped.data(), stripped.size())','stripped')
 .replace(/String\((\w+)\.(subtitle|main)\.data\(\), \1\.\2.size\(\)\)/g,'$1.$2')
 .replace('String(annotation.data(), annotation.size())','annotation')
 .replace(/std::string_view\((\w+)\.c_str\(\), \1.length\(\)\)/g,'$1')
 .replace(/std::string_view\((\w+)\.c_str\(\)\)/g,'$1')
 .replace(/const char\* (\w+)\[\] = \{([^}]+)\};/g,'const $1 = [$2];')
 .replace(/for \(const char\* (\w+) : \{([^}]+)\}\)/g,'for (const $1 of [$2])')
 .replace(/for \(const char\* (\w+) : (\w+)\)/g,'for (const $1 of $2)')
 .replace(/\bconst String (\w+) =/g,'const $1 =').replace(/\bString (\w+) =/g,'let $1 =')
 .replace(/value.remove\(([^)]+)\);/g,'value = value.substring(0, $1);')
 .replace(/strlen\(([^)]+)\)/g,'$1.length'));}
const titleSource=fs.readFileSync(path.resolve(__dirname,'../../../src/artwork/artwork_title_match.h'),'utf8');
const standardVersion=text=>['radio version','radio edit','album version','album edit','single version','single edit','original mix','clean version','explicit version'].includes(text.trim().toLowerCase());
// Existing subtitle parser policy is separately compiled and tested; use its
// production body here so nested/protected groups retain the same behaviour.
function titleBody(name){const at=titleSource.indexOf('{',titleSource.indexOf(name));let depth=0;for(let i=at;i<titleSource.length;i++){if(titleSource[i]==='{')depth++;if(titleSource[i]==='}'&&!--depth)return titleSource.slice(at,i+1);}throw Error(name);}
let versions=titleBody('std::string_view withoutStandardVersions(').replace(/const (?:char|size_t) /g,'const ').replace(/size_t count/g,'let count').replace(/text.empty\(\)/g,'!text.length').replace(/text.back\(\)/g,'text.at(-1)').replace(/text.find_last_of\(open\)/g,'text.lastIndexOf(open)').replace(/std::string_view::npos/g,'-1').replace(/text.size\(\)/g,'text.length');
const withoutStandardVersions=new Function('trim','standardVersion','text',versions).bind(null,s=>s.trim(),standardVersion);
let split=titleBody('TitleParts splitSubtitle(').replace(/\.size\(\)/g,'.length').replace(/const (?:char|size_t) /g,'const ').replace(/size_t /g,'let ').replace('char stack[8] = {};','const stack=Array(8).fill(0);').replace(/sizeof\(stack\)/g,'8').replace('return {text, {}, true};','return {main:text,subtitle:"",valid:true};').replace(/return \{\{\}, \{\}, false\};/g,'return {main:"",subtitle:"",valid:false};').replace('return depth ? TitleParts{{}, {}, false} : TitleParts{trim(text.substr(0, first)), text.substr(first), true};','return depth ? {main:"",subtitle:"",valid:false} : {main:trim(text.substr(0, first)),subtitle:text.substr(first),valid:true};');
const splitSubtitle=new Function('trim','withoutStandardVersions','text',split).bind(null,s=>s.trim(),withoutStandardVersions);
const deps=[normalizeArtworkText,artistsMatch,prepare,{...policy,splitSubtitle,minorTypo:()=>false}];
function build(name,artistMatcher=artistsMatch,typo=()=>false){
 const injected=[...deps];injected[1]=artistMatcher;injected[3]={...injected[3],minorTypo:typo};
 const options=name.includes('exactTrackMatch')?['allowStudioMix=false','allowTitleTypos=false','verifiedAliases=null']:['verifiedAliases=null'];
 return new Function('normalizeArtworkText','artworkArtistsMatch','prepareArtworkTitles','policy','versionText','foundArtist','foundTitle','wantedArtist','wantedTitle',...options,trackCode(name)).bind(null,...injected,parts.versionText);
}
let queryCode=body('static String albumTitleForSearch(')
 .replace('ArtworkTrackParts::parse','parse')
 .replace('String query(parts.main.data(), parts.main.size());','let query=parts.main;')
 .replace('String(piece.data(), piece.size())','piece')
 .replace('for (const auto piece : {parts.version, parts.tail})','for (const piece of [parts.version, parts.tail])')
 .replace(/const char\* (\w+)\[\] = \{([^}]+)\};/g,'const $1=[$2];')
 .replace(/for \(const char\* (\w+) : (\w+)\)/g,'for (const $1 of $2)')
 .replace(/\bString (\w+) =/g,'let $1 =')
 .replace('lower.toLowerCase();','lower=lower.toLowerCase();')
 .replace(/title.remove\(([^)]+)\);/g,'title=title.substring(0,$1);')
 .replace(/strlen\(([^)]+)\)/g,'$1.length');
queryCode=strings(queryCode);
const query=new Function('parse','title',queryCode).bind(null,parts.parse);

module.exports={query,normalizeArtworkText,artistsMatch,prepare,exactWithTypos:typo=>build('static bool exactTrackMatch(',artistsMatch,typo),exactWithArtists:matcher=>build('static bool exactTrackMatch(',matcher),exact:build('static bool exactTrackMatch('),subtitle:build('static bool subtitleTrackMatch('),creditTitle:build('static bool artistCreditTitleMatch(')};
