import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'public/branding');
await fs.mkdir(out, { recursive: true });
const symbol = '<path d="M128 193v-65m0 38-28-28m28 4 30-30"/><path d="M128 193c-22-19-46-22-70-22V79c27 0 49 8 70 28 21-20 43-28 70-28v92c-24 0-48 3-70 22Z"/><path d="m128 39 4.5 13.5L146 57l-13.5 4.5L128 75l-4.5-13.5L110 57l13.5-4.5Z" fill="currentColor" stroke="none"/>';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs><linearGradient id="tile" x2=".8" y2="1"><stop stop-color="#8B5CF6"/><stop offset="1" stop-color="#4C1D95"/></linearGradient></defs><rect x="8" y="8" width="240" height="240" rx="55" fill="url(#tile)"/><rect x="9" y="9" width="238" height="238" rx="54" fill="none" stroke="#C4B5FD" stroke-opacity=".35"/><g fill="none" stroke="currentColor" color="#FAF8FF" stroke-width="11" stroke-linecap="round" stroke-linejoin="round">${symbol}</g></svg>`;
await fs.writeFile(path.join(out, 'narrative-engine.svg'), svg);
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const frames = [];
for (const size of sizes) {
    const png = await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
    await fs.writeFile(path.join(out, `narrative-engine-${size}.png`), png);
    if (size <= 256) frames.push({ size, png });
}
const header = Buffer.alloc(6 + 16 * frames.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(frames.length, 4);
let offset = header.length;
frames.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    header[at] = header[at + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
});
await fs.writeFile(path.join(out, 'narrative-engine.ico'), Buffer.concat([header, ...frames.map(f => f.png)]));

const temporaryBundle = path.join(out, '.icon-preview.cjs');
try {
    await build({ entryPoints: [path.join(root, 'src/components/icons/narrativeIcons.ts')],
        outfile: temporaryBundle, bundle: true, platform: 'node', format: 'cjs', external: ['react'] });
    const require = createRequire(import.meta.url);
    const pack = require(temporaryBundle);
    const names = ['NarrativeMark', 'BookOpen', 'ScrollText', 'FileText', 'Brain', 'Database', 'Globe', 'MapPin', 'Users', 'UserCircle', 'Workflow', 'Archive', 'Pin', 'Image', 'Sparkles', 'Cpu', 'Dice5', 'SlidersHorizontal', 'Search', 'Settings', 'Plus', 'X', 'Check', 'Undo2', 'Send', 'Download', 'Upload', 'Volume2', 'Play', 'Pause', 'Trash2', 'Copy'];
    const cards = names.map(name => `<div class="card">${renderToStaticMarkup(createElement(pack[name], { size: 28, strokeWidth: 1.8, 'aria-hidden': true }))}<span>${name}</span></div>`).join('');
    for (const name of names) {
        await fs.writeFile(path.join(out, `${name}.svg`), renderToStaticMarkup(createElement(pack[name], { size: 24, strokeWidth: 1.8, xmlns: 'http://www.w3.org/2000/svg' })));
    }
    await fs.writeFile(path.join(out, 'preview.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Narrative Engine · Icon system</title><style>*{box-sizing:border-box}body{margin:0;background:#fafaf8;color:#211b2e;font:15px system-ui}main{max-width:1040px;margin:auto;padding:60px 32px}header{display:flex;align-items:center;gap:28px;margin-bottom:40px}h1{font-size:32px;margin:0 0 10px}p{color:#756d80;line-height:1.6;margin:0}header img{width:144px;height:144px}.sizes{display:flex;align-items:center;gap:24px;padding:24px 0 40px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(115px,1fr));gap:12px}.card{min-height:108px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:15px;border:1px solid #e6e1ed;border-radius:16px;color:#6d28d9}.card span{font-size:11px;color:#756d80}.dark{background:#1c1922;color:#c4b5fd;margin-top:28px;padding:24px;border-radius:24px}.dark .card{color:#c4b5fd;border-color:#393241}.dark .card span{color:#aaa1b8}a{color:#6d28d9}</style><main><header><img src="narrative-engine.svg" alt="Narrative Engine app icon"><div><h1>Narrative Engine</h1><p>A story that branches. A world that remembers.<br>Desktop identity and interface icon system.</p></div></header><p>Actual desktop sizes · 16 / 24 / 32 / 48 / 64 pixels</p><div class="sizes">${[16,24,32,48,64].map(s => `<img src="narrative-engine-${s}.png" width="${s}" height="${s}" alt="${s} pixel icon">`).join('')}</div><div class="grid">${cards}</div><div class="dark"><div class="grid">${cards}</div></div><p style="margin-top:28px"><a href="narrative-engine.ico">Windows icon</a> · <a href="narrative-engine-1024.png">1024px PNG</a> · <a href="narrative-engine.svg">Vector master</a></p></main></html>`);
} finally {
    await fs.rm(temporaryBundle, { force: true });
}
console.log(`Generated SVG, PNG, Windows ICO, interface SVGs, and preview in ${out}`);
