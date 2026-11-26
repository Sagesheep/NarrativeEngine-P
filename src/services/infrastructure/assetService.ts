import { API_BASE as API, ASSET_BASE } from '../../lib/apiBase';

/**
 * Downloads a remote image and saves it locally.
 * Returns the local relative path for the image.
 */
export async function downloadImageToLocal(url: string, npcName: string): Promise<string> {
    // Basic sanitization for filename
    const sanitizedName = npcName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const filename = `${sanitizedName}_${Date.now()}.png`;

    const res = await fetch(`${API}/assets/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, filename }),
    });

    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to download image to local storage');
    }

    const data = await res.json();
    // In Electron production (file:// protocol), prefix with the server base so
    // <img src> resolves to http://localhost:3001/assets/portraits/... not file:///.
    return `${ASSET_BASE}${data.path}`; // e.g. /assets/portraits/bob_123.png
}

/**
 * Reads a user-selected image File and uploads it to local portrait storage.
 * Returns the local relative path for the image, same shape as downloadImageToLocal.
 */
export async function uploadImageToLocal(file: File, npcName: string): Promise<string> {
    // Reject obviously non-image files early for a friendlier error.
    if (!file.type.startsWith('image/')) {
        throw new Error('Selected file is not an image');
    }

    const sanitizedName = npcName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
    const filename = `${sanitizedName}_${Date.now()}.${ext || 'png'}`;

    const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'));
        reader.readAsDataURL(file);
    });

    const res = await fetch(`${API}/assets/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl, filename }),
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Upload failed' }));
        throw new Error(err.error || 'Failed to upload image to local storage');
    }

    const data = await res.json();
    return `${ASSET_BASE}${data.path}`;
}
