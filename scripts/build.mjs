// Bundle the viewer into one self-contained HTML page.
//   node scripts/build.mjs [argument.yaml] [-o out.html]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Safe inside <script>: no "</script" and no HTML comment openers can appear.
const scriptString = (s) =>
  JSON.stringify(s)
    .replace(/</g, '\\u003c')
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');

/**
 * @param {{ source?: string, title?: string, ideas?: object | null }} [options] The argument file's text to embed, the page title, and its notepad notes.
 * @returns {Promise<string>} A complete HTML document.
 */
export async function buildViewer({ source = '', title = 'argmap', ideas = null } = {}) {
  const result = await build({
    entryPoints: [resolve(root, 'viewer/main.ts')],
    bundle: true,
    format: 'iife',
    target: 'es2020',
    minify: true,
    write: false,
    legalComments: 'none',
  });
  const script = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const css = readFileSync(resolve(root, 'viewer/style.css'), 'utf8');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Sans+Condensed:wght@500;600&display=swap" rel="stylesheet">
<style>
${css}</style>
</head>
<body>
<main id="app"></main>
<script>window.__ARGMAP_SOURCE__ = ${scriptString(source)}; window.__ARGMAP_IDEAS__ = JSON.parse(${scriptString(JSON.stringify(ideas))});</script>
<script>${script}</script>
</body>
</html>
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const o = args.indexOf('-o');
  const out = resolve(o !== -1 && args[o + 1] ? args[o + 1] : resolve(root, 'dist/viewer.html'));
  const file = args.find((a, i) => a !== '-o' && i !== o + 1);
  const source = file ? readFileSync(file, 'utf8') : '';
  let title = 'argmap';
  const m = /^title:\s*(.+)$/m.exec(source);
  if (m) title = m[1].trim().replace(/^["']|["']$/g, '');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, await buildViewer({ source, title }));
  console.log(`Wrote ${out}`);
}
