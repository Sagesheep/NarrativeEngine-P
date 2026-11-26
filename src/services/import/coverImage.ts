/**
 * WO-C §3.3 — downscale the seed card's PNG for `Campaign.coverImage`.
 *
 * Card PNGs run to multiple megabytes; the campaign list must not carry that
 * as base64. Long edge ≤ `maxEdge`, JPEG at 0.85. Browser-only (needs an
 * `<img>` decode and a canvas) — callers fall back to `''` when it throws,
 * which is what happens under jsdom.
 */
export async function downscaleCover(file: File, maxEdge = 512): Promise<string> {
    if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        throw new Error('downscaleCover: no DOM available');
    }
    const url = URL.createObjectURL(file);
    try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error('downscaleCover: image failed to decode'));
            el.src = url;
        });
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!w || !h) throw new Error('downscaleCover: image has no dimensions');
        const scale = Math.min(1, maxEdge / Math.max(w, h));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('downscaleCover: no 2d context');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.85);
    } finally {
        URL.revokeObjectURL(url);
    }
}
