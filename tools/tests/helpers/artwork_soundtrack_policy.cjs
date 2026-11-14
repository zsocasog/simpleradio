const fs=require('node:fs'),path=require('node:path');
const title=require('./artwork_title_policy.cjs');
const source=fs.readFileSync(path.resolve(__dirname,'../../../src/artwork/artwork_soundtrack_match.h'),'utf8');
function body(marker){const at=source.indexOf('{',source.indexOf(marker));let depth=0;for(let i=at;i<source.length;i++){if(source[i]==='{')depth++;if(source[i]==='}'&&!--depth)return source.slice(at,i+1);}throw Error(marker);}
function code(text){return text.replace(/ArtworkTitleMatch::wordChar/g,'title.wordChar').replace(/ArtworkTitleMatch::protectedSubtitle/g,'title.protectedSubtitle').replace(/ArtworkTitleMatch::hasWord/g,'title.hasWord')
 .replace(/ArtworkTitleMatch::trim\(([^)]+\([^)]*\))\)/g,'$1.trim()')
 .replace(/for \(const char\* (\w+) : \{([^}]+)\}\)/g,'for (const $1 of [$2])')
 .replace(/for \(char (\w+) : (\w+)\)/g,'for (const $1 of $2)')
 .replace(/const auto /g,'const ').replace(/const (?:size_t|char) /g,'const ').replace(/\b(?:size_t|bool) /g,'let ')
 .replace(/\.size\(\)/g,'.length').replace(/([\w.]+)\.empty\(\)/g,'($1.length === 0)');}
const nextWord=new Function('title','text','at',code(body('std::string_view nextWord(')).replace('return text.substr(begin, at - begin);','return {value:text.substr(begin,at-begin),at};')).bind(null,title);
const genericWord=new Function('value',code(body('bool genericWord(')));
const words=new Function('title','nextWord','genericWord','MAX_TEXT','MAX_WORDS','text','annotation',code(body('Words words('))
 .replace('Words out;','const out={values:[],number:"",count:0,valid:false};')
 .replace('char noNumbers[MAX_TEXT] = {};','const noNumbers=Array(MAX_TEXT).fill(" ");')
 .replace('std::string_view(noNumbers, text.length)','noNumbers.slice(0,text.length).join("")')
 .replace('!text.substr(at).trim().empty()','text.substr(at).trim().length > 0')
 .replace('const value = nextWord(text, at);','const step=nextWord(text,at);const value=step.value;at=step.at;')).bind(null,title,nextWord,genericWord,192,16);
const relatedRelease=new Function('words','annotation','release',code(body('bool relatedRelease('))).bind(null,words);
const soundtrackMetadata=new Function('title','genre','release',code(body('bool soundtrackMetadata('))).bind(null,title);
module.exports={relatedRelease,soundtrackMetadata};
