import { get, set, del } from 'idb-keyval';

/**
 * User-selectable chat background image (Level 1 + 2).
 *
 * We store exactly ONE image at a time — picking a new one overwrites the old.
 * The image is kept as a data-URL string in idb-keyval so it survives reloads,
 * and applied via CSS variables consumed by index.css (`--bg-image`,
 * `--chat-opacity`) plus the `data-has-bg` attribute on <html> which gates the
 * whole feature so there is no visual change until an image is chosen.
 */

const IMAGE_KEY = 'ui:bg-image';
const OPACITY_KEY = 'ui:bg-opacity';

/** Default chat-panel opacity (percent of the base surface colour kept). */
export const DEFAULT_BG_OPACITY = 70;

/** Theme-aware readability tint painted over the image so text stays legible. */
function scrimColor(): string {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    return dark ? 'rgba(22, 22, 24, 0.45)' : 'rgba(250, 250, 248, 0.30)';
}

/**
 * Paint (or clear) the image directly as inline styles on <html>. We deliberately
 * do NOT route this through a CSS custom property + stylesheet rule: `@theme`-based
 * vars did not reliably resolve inside `background-image`, which silently dropped the
 * whole declaration. Inline styles have the highest specificity and always win over
 * the base `html { background }` rule, while leaving its background-COLOR intact.
 */
function applyImage(dataUrl: string | null): void {
    const root = document.documentElement;
    if (dataUrl) {
        const scrim = scrimColor();
        // data-URLs never contain a double-quote, so this is safe to wrap.
        root.style.backgroundImage = `linear-gradient(${scrim}, ${scrim}), url("${dataUrl}")`;
        root.style.backgroundSize = 'cover';
        root.style.backgroundPosition = 'center';
        root.style.backgroundRepeat = 'no-repeat';
        root.style.backgroundAttachment = 'fixed';
        root.setAttribute('data-has-bg', 'true');
    } else {
        root.style.backgroundImage = '';
        root.style.backgroundSize = '';
        root.style.backgroundPosition = '';
        root.style.backgroundRepeat = '';
        root.style.backgroundAttachment = '';
        root.removeAttribute('data-has-bg');
    }
}

function applyOpacity(percent: number): void {
    const clamped = Math.max(10, Math.min(100, Math.round(percent)));
    document.documentElement.style.setProperty('--chat-opacity', `${clamped}%`);
}

/** State currently in memory, so the UI can render controls without re-reading idb. */
export interface BackgroundState {
    hasImage: boolean;
    image: string | null;
    opacity: number;
}

/** Read persisted background settings and apply them to the DOM. Call once on app mount. */
export async function loadBackground(): Promise<BackgroundState> {
    let image: string | null = null;
    let opacity = DEFAULT_BG_OPACITY;
    try {
        image = (await get<string>(IMAGE_KEY)) ?? null;
        const savedOpacity = await get<number>(OPACITY_KEY);
        if (typeof savedOpacity === 'number') opacity = savedOpacity;
    } catch (e) {
        console.warn('[background] failed to load persisted background:', e);
    }
    applyOpacity(opacity);
    applyImage(image);
    return { hasImage: !!image, image, opacity };
}

/** Swap in a new background image (replaces any existing one). */
export async function setBackgroundImage(dataUrl: string): Promise<void> {
    await set(IMAGE_KEY, dataUrl);
    applyImage(dataUrl);
}

/** Remove the background image entirely, reverting to the plain themed background. */
export async function clearBackgroundImage(): Promise<void> {
    await del(IMAGE_KEY);
    applyImage(null);
}

/** Update how translucent the chat panel is over the image (10–100). */
export async function setBackgroundOpacity(percent: number): Promise<void> {
    const clamped = Math.max(10, Math.min(100, Math.round(percent)));
    applyOpacity(clamped);
    await set(OPACITY_KEY, clamped);
}

/** Read a File (from an <input type="file">) into a data-URL string. */
export function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'));
        reader.readAsDataURL(file);
    });
}
