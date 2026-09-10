// Original handheld-inspired art. Presentation only: never changes field or route data.
export const PIXEL_PALETTE = Object.freeze({
    plains: '#8cbd62', farmland: '#a8be64', forest: '#669e58', jungle: '#5d9f58',
    taiga: '#719a75', tundra: '#bbc9a4', glacier: '#d6e8e6', mountain: '#a9ac88',
    desert: '#e4cb85', savanna: '#c6c373', marsh: '#789d7a', ocean: '#3986b5',
});
export const SITE_SPRITES = Object.freeze({ settlement: 13, camp: 5, ruin: 6, shrine: 7, crossing: 15, landmark: 14 });
let sheet = null;
let loading = null;
export function loadPixelArt() {
    if (sheet) return Promise.resolve(true);
    if (loading) return loading;
    if (typeof Image === 'undefined') return Promise.resolve(false);
    loading = new Promise(resolve => {
        const image = new Image();
        image.onload = () => { sheet = image; resolve(true); };
        image.onerror = () => { loading = null; resolve(false); };
        image.src = new URL('./assets/overworld-sprites-v1.png', import.meta.url).href;
    });
    return loading;
}
export function drawPixelSprite(ctx, slot, x, y, size) {
    if (!sheet) return false;
    const unitX = sheet.naturalWidth / 4, unitY = sheet.naturalHeight / 4;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sheet, (slot % 4) * unitX, Math.floor(slot / 4) * unitY, unitX, unitY,
        Math.round(x), Math.round(y), Math.round(size), Math.round(size));
    return true;
}
function noise(x, y, salt = 0) {
    let n = Math.imul(x + 1013, 374761393) ^ Math.imul(y + 719, 668265263) ^ Math.imul(salt + 1, 1274126177);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return (n ^ (n >>> 16)) >>> 0;
}
export function terrainSprite(biome, variant) {
    if (biome === 'forest') return 0;
    if (biome === 'taiga') return 2 === variant % 5 ? 10 : 1;
    if (biome === 'jungle') return variant % 3 ? 0 : 2;
    if (biome === 'mountain') return 3;
    if (biome === 'marsh') return variant % 3 === 0 ? 11 : null;
    if (biome === 'tundra') return variant % 9 === 0 ? 10 : null;
    if (biome === 'savanna') return variant % 7 === 0 ? 0 : null;
    if (biome === 'plains') return variant % 11 === 0 ? 9 : null;
    return null;
}
// Logical 16-pixel ground tiles at every zoom; motifs stay stable across tile/cache boundaries.
export function paintPixelCell(ctx, store, x, y, px, py, size) {
    const cell = store.getCell(x, y);
    if (!cell) return;
    const biome = cell.biome, pixel = size / 16;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = PIXEL_PALETTE[biome] ?? PIXEL_PALETTE.plains;
    ctx.fillRect(px, py, size, size);
    const mark = (color, a, b, w, h) => {
        ctx.fillStyle = color;
        ctx.fillRect(px + a * pixel, py + b * pixel, Math.max(pixel, w * pixel), Math.max(pixel, h * pixel));
    };
    if (biome === 'ocean') {
        for (let i = 0; i < 3; i++) {
            const n = noise(x, y, i), a = n % 12, b = (n >>> 8) % 14;
            mark('#4f9ec9', a, b, 3, 1); mark('#72b9d6', a + 1, b + 1, 2, 1);
        }
    } else if (biome === 'farmland') {
        for (let row = 3; row < 16; row += 4) {
            mark('#8b9f4e', 0, row, 16, 1); mark('#c2cf77', 0, row + 1, 16, 1);
        }
    } else {
        const dark = ['desert','savanna'].includes(biome) ? '#b7ac65' : biome === 'glacier' ? '#b8d2d5' : '#6a9f56';
        const light = ['desert','savanna'].includes(biome) ? '#ede09c' : biome === 'glacier' ? '#eff7ec' : '#a8cb77';
        for (let i = 0; i < 3; i++) {
            const n = noise(x, y, i), a = n % 14, b = (n >>> 8) % 14;
            mark(i === 0 ? light : dark, a, b, 1, 1);
            if (i === 1) mark(dark, a + 1, b - 1, 1, 1);
        }
    }
    // Cardinal shoreline strips join at corners. Land always retains its own biome.
    const neighbours = [[0,-1],[1,0],[0,1],[-1,0]].map(([dx,dy]) => store.getCell(x+dx,y+dy));
    if (biome !== 'ocean') {
        neighbours.forEach((other, side) => {
            if (other?.biome !== 'ocean') return;
            const horizontal = side % 2 === 0;
            const a = side === 1 ? 14 : 0, b = side === 2 ? 14 : 0;
            mark('#b5a26b', a, b, horizontal ? 16 : 2, horizontal ? 2 : 16);
            mark('#f0dfa0', side === 1 ? 13 : 0, side === 2 ? 13 : 0, horizontal ? 16 : 1, horizontal ? 1 : 16);
        });
    } else {
        neighbours.forEach((other, side) => {
            if (!other || other.biome === 'ocean') return;
            mark('#91cfdd', side === 1 ? 15 : 0, side === 2 ? 15 : 0, side % 2 === 0 ? 16 : 1, side % 2 === 0 ? 1 : 16);
        });
    }
}
export function paintPixelObjects(ctx, store, x, y, px, py, size) {
    if (size < 8) return;
    const biome = store.getCell(x, y)?.biome, seed = noise(x, y);
    const sprite = terrainSprite(biome, seed);
    if (sprite === null) return;
    const dense = ['forest', 'jungle', 'taiga', 'mountain'].includes(biome);
    const scale = dense ? 1.6 : 1;
    const offset = dense ? ((seed % 3) - 1) * size / 16 : 0;
    if (!drawPixelSprite(ctx, sprite, px - size * (scale - 1) / 2 + offset, py - size * (scale - 1) * 0.7, size * scale)) {
        ctx.fillStyle = '#49774d'; ctx.fillRect(px + size / 4, py + size / 4, size / 2, size / 2);
    }
}
