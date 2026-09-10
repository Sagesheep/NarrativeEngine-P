import type { VisionImage } from './visionRequest';

/**
 * Turn whatever the UI has — a picked `File`, a stored portrait path, a data
 * URL — into the raw base64 + MIME pair a vision request needs.
 *
 * WHY THE DOWNSCALE MATTERS: the image is billed as input tokens, not as a
 * free attachment. Claude charges roughly `(width * height) / 750` tokens, so
 * a 2048x2048 portrait is ~5,600 tokens for one describe call. Capping the
 * long edge at 768px puts it near ~790 tokens with no meaningful loss for
 * "what does this character look like" — the details a caption keeps (hair,
 * clothing, marks) survive a 768px downscale intact.
 *
 * Every step of the resize is best-effort. If the environment has no canvas
 * (jsdom, a locked-down webview) we send the original bytes rather than fail
 * the whole action — a costly describe beats a broken button.
 */

/** Longest edge, in pixels, we send to the model. ~790 tokens at 768x768. */
export const DEFAULT_MAX_EDGE = 768;

export type ParsedDataUrl = { base64: string; mediaType: string };

/**
 * Split a `data:image/png;base64,AAA…` URL into its parts.
 * Returns null for anything that is not a base64 image data URL.
 */
export function parseDataUrl(dataUrl: string): ParsedDataUrl | null {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(dataUrl);
    if (!match) return null;
    // Providers reject embedded newlines; some encoders emit them.
    const base64 = match[2].replace(/\s+/g, '');
    if (!base64) return null;
    return { mediaType: match[1], base64 };
}

/**
 * Fit (width, height) inside a maxEdge box, preserving aspect ratio.
 * Images already inside the box are returned unchanged — we never upscale.
 */
export function computeScaledSize(
    width: number,
    height: number,
    maxEdge: number = DEFAULT_MAX_EDGE,
): { width: number; height: number; scaled: boolean } {
    if (width <= 0 || height <= 0) return { width, height, scaled: false };
    const longest = Math.max(width, height);
    if (longest <= maxEdge) return { width, height, scaled: false };
    const ratio = maxEdge / longest;
    return {
        width: Math.max(1, Math.round(width * ratio)),
        height: Math.max(1, Math.round(height * ratio)),
        scaled: true,
    };
}

/** Estimated input tokens for an image of this size (Claude's ~w*h/750 rule). */
export function estimateImageTokens(width: number, height: number): number {
    return Math.round((width * height) / 750);
}

function readFileAsDataUrl(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'));
        reader.readAsDataURL(file);
    });
}

/** Decode a blob to bitmap dimensions + a drawable source, or null if unavailable. */
async function decodeBlob(blob: Blob): Promise<{ source: CanvasImageSource; width: number; height: number } | null> {
    if (typeof createImageBitmap === 'function') {
        try {
            const bitmap = await createImageBitmap(blob);
            return { source: bitmap, width: bitmap.width, height: bitmap.height };
        } catch {
            // fall through to the <img> path
        }
    }
    if (typeof Image !== 'function' || typeof URL?.createObjectURL !== 'function') return null;
    const url = URL.createObjectURL(blob);
    try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error('Failed to decode image'));
            el.src = url;
        });
        return { source: img, width: img.naturalWidth || img.width, height: img.naturalHeight || img.height };
    } catch {
        return null;
    } finally {
        URL.revokeObjectURL(url);
    }
}

/** Re-encode a blob at most `maxEdge` on its long side. Returns null if it cannot. */
async function downscaleBlob(blob: Blob, maxEdge: number): Promise<ParsedDataUrl | null> {
    if (typeof document === 'undefined') return null;
    const decoded = await decodeBlob(blob);
    if (!decoded) return null;

    const { width, height, scaled } = computeScaledSize(decoded.width, decoded.height, maxEdge);
    if (!scaled) return null; // already small enough — keep the original bytes

    try {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(decoded.source, 0, 0, width, height);
        // JPEG: portraits do not need alpha, and it is a fraction of PNG's size.
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        return parseDataUrl(dataUrl);
    } catch {
        return null;
    }
}

export type LoadedVisionImage = VisionImage & {
    /** Pixel dimensions actually sent, when we could measure them. */
    width?: number;
    height?: number;
};

/**
 * Load an image for a vision call.
 *
 * @param src A `File`/`Blob` from a file picker, a data URL, or a URL/path the
 *            app can fetch (e.g. `/assets/portraits/hero_123.png`).
 */
export async function loadImageForVision(
    src: File | Blob | string,
    opts?: { maxEdge?: number },
): Promise<LoadedVisionImage> {
    const maxEdge = opts?.maxEdge ?? DEFAULT_MAX_EDGE;

    let blob: Blob;
    if (typeof src === 'string') {
        const asData = parseDataUrl(src);
        if (asData) {
            // Already inline. Try to shrink it; keep it as-is if we cannot.
            const shrunk = await dataUrlToBlob(src).then(b => (b ? downscaleBlob(b, maxEdge) : null)).catch(() => null);
            return shrunk ?? asData;
        }
        const res = await fetch(src);
        if (!res.ok) throw new Error(`Could not load image (${res.status} ${res.statusText})`);
        blob = await res.blob();
    } else {
        blob = src;
    }

    if (blob.type && !blob.type.startsWith('image/')) {
        throw new Error(`Not an image (${blob.type})`);
    }

    const shrunk = await downscaleBlob(blob, maxEdge).catch(() => null);
    if (shrunk) return shrunk;

    const dataUrl = await readFileAsDataUrl(blob);
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) throw new Error('Could not encode image for the vision model');
    return parsed;
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob | null> {
    try {
        const res = await fetch(dataUrl);
        return await res.blob();
    } catch {
        return null;
    }
}
