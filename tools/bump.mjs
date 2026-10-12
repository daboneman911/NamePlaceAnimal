// usage: npm run bump 1.2.0
// GitHub Pages serves everything with max-age=600 and iOS Safari reuses cached
// JS/CSS even on reload, so every local asset URL carries ?v=<version>. A new
// version means new URLs, which no browser has cached. This keeps all of them,
// package.json and js/version.js in step.
import { readFile, writeFile } from 'node:fs/promises';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
  console.error('usage: npm run bump <major.minor.patch>');
  process.exit(1);
}

const root = new URL('../', import.meta.url);
async function edit(path, fn) {
  const url = new URL(path, root);
  const before = await readFile(url, 'utf8');
  const after = fn(before);
  if (after !== before) await writeFile(url, after);
  console.log(`${after !== before ? 'updated' : 'unchanged'} ${path}`);
}

// Matches local refs like "styles.css", "js/app.js", './engine.js', with or without an existing ?v=.
export const ASSET_REF = /((?:href|src)="(?!https?:)[^"?]+\.(?:css|js)|from '\.\/[^'?]+\.js)(\?v=[^"']*)?(?=["'])/g;
const stamp = text => text.replace(ASSET_REF, `$1?v=${version}`);

await edit('package.json', t => t.replace(/"version": "[^"]+"/, `"version": "${version}"`));
await edit('js/version.js', t => t.replace(/VERSION = '[^']+'/, `VERSION = '${version}'`));
for (const f of ['index.html', 'js/app.js', 'js/net.js']) await edit(f, stamp);
