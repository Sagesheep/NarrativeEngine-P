/**
 * settingsCrypto.ts
 * ------------------
 * Client-side AES-GCM encryption for apiKey fields in AI presets.
 * The key is device-local: derived from a random salt stored in IndexedDB.
 * Keys are encrypted before hitting disk (idb / server file), decrypted at load time.
 *
 * Format stored:  "enc:<base64iv>:<base64ciphertext>"
 * Plain keys:     anything that does NOT start with "enc:"
 */

import { get as idbGet, set as idbSet } from 'idb-keyval';
import type { AIPreset } from '../types';

const IDB_DEVICE_KEY = 'nn_device_key';
const ENC_PREFIX = 'enc:';

// ─── Key bootstrap ───────────────────────────────────────────────────────────

/** Returns the AES-GCM CryptoKey, generating + storing it on first use. */
async function getDeviceCryptoKey(): Promise<CryptoKey> {
    let rawKey: ArrayBuffer | undefined = await idbGet(IDB_DEVICE_KEY);

    if (!rawKey) {
        // First run: generate a fresh key and persist it
        const generated = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 },
            true,
            ['encrypt', 'decrypt']
        );
        rawKey = await crypto.subtle.exportKey('raw', generated);
        await idbSet(IDB_DEVICE_KEY, rawKey);
    }

    return crypto.subtle.importKey(
        'raw',
        rawKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

// ─── Core helpers ─────────────────────────────────────────────────────────────

async function encryptString(plaintext: string, key: CryptoKey): Promise<string> {
    if (!plaintext) return plaintext;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

    const ivB64 = btoa(String.fromCharCode(...iv));
    const ctB64 = btoa(String.fromCharCode(...new Uint8Array(cipherBuf)));
    return `${ENC_PREFIX}${ivB64}:${ctB64}`;
}

async function decryptString(ciphertext: string, key: CryptoKey): Promise<string> {
    if (!ciphertext || !ciphertext.startsWith(ENC_PREFIX)) return ciphertext;
    try {
        const payload = ciphertext.slice(ENC_PREFIX.length);
        const [ivB64, ctB64] = payload.split(':');
        const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
        const ct = Uint8Array.from(atob(ctB64), c => c.charCodeAt(0));
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
        return new TextDecoder().decode(plain);
    } catch {
        // Key mismatch or tampered data — return empty so user can re-enter
        console.warn('[settingsCrypto] Failed to decrypt apiKey. Was the browser storage cleared?');
        return '';
    }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Encrypts apiKey fields in a preset and returns a new preset object. */
export async function encryptPreset(preset: AIPreset): Promise<AIPreset> {
    const key = await getDeviceCryptoKey();
    const [storyKey, imageKey, summKey, utilKey] = await Promise.all([
        encryptString(preset.storyAI.apiKey, key),
        encryptString(preset.imageAI.apiKey, key),
        encryptString(preset.summarizerAI.apiKey, key),
        preset.utilityAI ? encryptString(preset.utilityAI.apiKey, key) : Promise.resolve(''),
    ]);
    return {
        ...preset,
        storyAI: { ...preset.storyAI, apiKey: storyKey },
        imageAI: { ...preset.imageAI, apiKey: imageKey },
        summarizerAI: { ...preset.summarizerAI, apiKey: summKey },
        ...(preset.utilityAI ? { utilityAI: { ...preset.utilityAI, apiKey: utilKey } } : {}),
    };
}

/** Decrypts apiKey fields in a preset and returns a new preset object. */
export async function decryptPreset(preset: AIPreset): Promise<AIPreset> {
    const key = await getDeviceCryptoKey();
    const [storyKey, imageKey, summKey, utilKey] = await Promise.all([
        decryptString(preset.storyAI.apiKey, key),
        decryptString(preset.imageAI.apiKey, key),
        decryptString(preset.summarizerAI.apiKey, key),
        preset.utilityAI ? decryptString(preset.utilityAI.apiKey, key) : Promise.resolve(''),
    ]);
    return {
        ...preset,
        storyAI: { ...preset.storyAI, apiKey: storyKey },
        imageAI: { ...preset.imageAI, apiKey: imageKey },
        summarizerAI: { ...preset.summarizerAI, apiKey: summKey },
        ...(preset.utilityAI ? { utilityAI: { ...preset.utilityAI, apiKey: utilKey } } : {}),
    };
}

/** Encrypt all presets in a settings object (for storage). */
export async function encryptSettingsPresets(presets: AIPreset[]): Promise<AIPreset[]> {
    return Promise.all(presets.map(encryptPreset));
}

/** Decrypt all presets in a settings object (after loading from storage). */
export async function decryptSettingsPresets(presets: AIPreset[]): Promise<AIPreset[]> {
    return Promise.all(presets.map(decryptPreset));
}
