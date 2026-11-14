const fs = require('node:fs'), path = require('node:path'), test = require('node:test'), assert = require('node:assert/strict');
const source = fs.readFileSync(path.resolve(__dirname, '../../src/artwork/artwork_cache.cpp'), 'utf8');
const start = source.indexOf('void ArtworkCache::invalidateLcdThumbnail(');
const fn = source.slice(start, source.indexOf('bool ArtworkCache::ensureLcdThumbnail(', start));
const cleanup = fn.slice(fn.indexOf('  bool removed = false;'), fn.indexOf('  if (removed)'))
  .replace('bool removed = false;', 'let removed = false;')
  .replace('const String thumbnailPaths[] = {thumbPath, lcdThumbnailPath(localPath, true)};', 'const thumbnailPaths = [thumbPath, lcdThumbnailPath(localPath, true)];')
  .replace('for (const String& path : thumbnailPaths)', 'for (const path of thumbnailPaths)')
  .replace('String tempPath =', 'const tempPath =').replace(/\.c_str\(\)/g, '').replace(/ReadOnlyStorage::/g, 'ReadOnlyStorage.');
const invalidate = new Function('LittleFS', 'ReadOnlyStorage', 'thumbPath', 'lcdThumbnailPath', 'localPath', cleanup + 'return removed;');
test('replacing/deleting a source removes fit and fill files and interrupted writes, retaining other artwork', () => {
  const paths = ['/cache/fit.sr565', '/cache/fill.sr565', '/cache/fit.sr565.tmp', '/cache/fill.sr565.tmp'];
  const keep = ['/logos/user.png', '/cache/other.sr565'];
  const files = new Set([...paths, ...keep]);
  const fs = { mountpoint: () => '/littlefs', remove: p => files.delete(p) };
  const readonly = { exists: (_mount, p) => files.has(p) };
  const fill = (source, filled) => { assert.equal(source, '/logos/test.png'); assert.equal(filled, true); return paths[1]; };
  assert.equal(invalidate(fs, readonly, paths[0], fill, '/logos/test.png'), true);
  assert.deepEqual([...files], keep);
  assert.equal(invalidate(fs, readonly, paths[0], fill, '/logos/test.png'), false);
});
