const fs = require('node:fs'), path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../../../src/artwork/artwork_title_match.h'), 'utf8');
function body(marker) {
  const start = source.indexOf('{', source.indexOf(marker)); let depth = 0;
  for (let i = start; i < source.length; ++i) {
    if (source[i] === '{') ++depth;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw Error(marker);
}
function code(text) {
  return text.replace(/for \(const char\* (\w+) : \{([^}]+)\}\)/g, 'for (const $1 of [$2])')
    .replace('for (char c : normalized)', 'for (const c of normalized)')
    .replace(/const std::string_view (\w+)\((\w+)\);/g, 'const $1 = $2;')
    .replace(/\bconst (?:size_t|auto|char) /g, 'const ').replace(/\bsize_t /g, 'let ')
    .replace(/\.size\(\)/g, '.length').replace(/([\w.]+)\.empty\(\)/g, '($1.length === 0)')
    .replace(/\.find\(/g, '.indexOf(').replace(/std::string_view::npos/g, '-1')
    .replace(/std::string_view\{\}/g, '""').replace(/return \{\};/g, 'return "";');
}
const wordChar = new Function('c', body('bool wordChar('));
const hasWord = new Function('wordChar', 'text', 'word', code(body('bool hasWord('))).bind(null, wordChar);
const protectedSubtitle = new Function('hasWord', 'normalized', code(body('bool protectedSubtitle('))).bind(null, hasWord);
const featureCredit = new Function('trim', 'protectedSubtitle', 'text', code(body('std::string_view featureCredit(')))
  .bind(null, s => s.trim(), protectedSubtitle);
const withoutFeatureCredit = new Function('trim', 'featureCredit', 'text', code(body('std::string_view withoutFeatureCredit(')))
  .bind(null, s => s.trim(), featureCredit);
module.exports = { featureCredit, withoutFeatureCredit, protectedSubtitle, hasWord, wordChar };
