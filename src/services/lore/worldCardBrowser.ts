import type { WorldCard } from './worldCard';
import { MAX_WORLD_FILE_BYTES, writeWorldPng } from './worldCardPng';

/** Render a readable world cover; no AI or image service is needed. */
export async function renderWorldCover(name: string, entryCount: number, cover?: File): Promise<Uint8Array<ArrayBuffer>> {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 1000;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Your browser cannot render a PNG cover.');
    ctx.fillStyle = '#09172e';
    ctx.fillRect(0, 0, 800, 1000);
    if (cover) {
        if (cover.size > MAX_WORLD_FILE_BYTES) throw new Error('Cover image must be smaller than 20 MB.');
        const url = URL.createObjectURL(cover);
        try {
            const image = await new Promise<HTMLImageElement>((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = () => reject(new Error('The cover image could not be opened.'));
                img.src = url;
            });
            const scale = Math.max(800 / image.naturalWidth, 1000 / image.naturalHeight);
            const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
            ctx.drawImage(image, (800 - w) / 2, (1000 - h) / 2, w, h);
        } finally { URL.revokeObjectURL(url); }
    } else {
        ctx.strokeStyle = '#164467';
        ctx.lineWidth = 2;
        for (let i = 0; i < 9; i++) {
            ctx.beginPath(); ctx.arc(690, 210, 80 + i * 60, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.fillStyle = '#64d7ec';
        ctx.beginPath(); ctx.arc(650, 195, 75, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#09172e';
        ctx.beginPath(); ctx.arc(680, 175, 72, 0, Math.PI * 2); ctx.fill();
    }
    const gradient = ctx.createLinearGradient(0, 350, 0, 1000);
    gradient.addColorStop(0, 'rgba(4,12,24,0)'); gradient.addColorStop(0.6, 'rgba(4,12,24,0.92)');
    ctx.fillStyle = gradient; ctx.fillRect(0, 350, 800, 650);
    ctx.fillStyle = '#78e6f4'; ctx.font = '20px sans-serif';
    ctx.fillText('NARRATIVE ENGINE / WORLD LORE', 55, 580);
    const title = name.trim() || 'Untitled World';
    let fontSize = 62;
    const wrap = () => {
        ctx.font = `bold ${fontSize}px sans-serif`;
        const lines: string[] = []; let line = '';
        for (const word of title.split(/\s+/)) {
            const candidate = line ? line + ' ' + word : word;
            if (line && ctx.measureText(candidate).width > 680) { lines.push(line); line = ''; }
            if (line) line += ' ';
            for (const char of word) {
                if (ctx.measureText(line + char).width > 680) { lines.push(line); line = ''; }
                line += char;
            }
        }
        if (line) lines.push(line);
        return lines;
    };
    let lines = wrap();
    while (lines.length > 3 && fontSize > 26) { fontSize -= 2; lines = wrap(); }
    ctx.fillStyle = '#f1f8ff';
    lines.slice(0, 3).forEach((line, i) => ctx.fillText(i === 2 && lines.length > 3 ? `${line.slice(0, -1)}…` : line, 55, 675 + i * (fontSize + 10)));
    ctx.fillStyle = '#a8bfd0'; ctx.font = '22px sans-serif';
    ctx.fillText(`${entryCount} lore entries · Import to explore`, 55, 922);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('PNG export failed.')), 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
}

export async function worldCardBlob(card: WorldCard, cover?: File): Promise<Blob> {
    const image = await renderWorldCover(card.world.name, card.world.chunks.length, cover);
    return new Blob([writeWorldPng(image, card)], { type: 'image/png' });
}

export function downloadWorldFile(blob: Blob, name: string, extension: 'png' | 'json'): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${Array.from(name, c => c.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(c) ? '_' : c).join('').slice(0, 100) || 'World'}.world.${extension}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
