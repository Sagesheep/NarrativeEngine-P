import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    encryptProvider,
    decryptProvider,
    encryptSettingsProviders,
    decryptSettingsProviders,
    encryptPreset,
    decryptPreset,
    encryptSettingsPresets,
    decryptSettingsPresets,
} from '../settingsCrypto';
import type { LLMProvider, AIPreset, ApiFormat } from '../../../types';

// ─────────────────────────────────────────────────────────────────────────────
// Characterization tests for settingsCrypto.ts (Refactor 19-06 Plan 04 w1).
// SECURITY round-trip: decrypt(encrypt(x)) must deep-equal x for provider apiKey
// and preset inline-config apiKeys; ciphertext must start with "enc:" and differ
// from plaintext; empty/missing fields pass through; malformed ciphertext returns
// "" (caught). The AES-GCM key is device-local, persisted via idb-keyval — mocked
// here with an in-memory Map so encrypt/decrypt within one test share the key.
// ─────────────────────────────────────────────────────────────────────────────

// In-memory backing store for idb-keyval so getDeviceCryptoKey persists a single
// key across encrypt→decrypt within a test. Reset before each test.
const idbStore = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
    get: vi.fn((k: string) => Promise.resolve(idbStore.get(k))),
    set: vi.fn((k: string, v: unknown) => { idbStore.set(k, v); return Promise.resolve(); }),
}));

const provider = (apiKey: string, over: Partial<LLMProvider> = {}): LLMProvider => ({
    id: 'p1',
    label: 'Default',
    endpoint: 'http://localhost:11434/v1',
    apiKey,
    modelName: 'llama3',
    apiFormat: 'openai' as ApiFormat,
    streamingEnabled: true,
    ...over,
});

const preset = (storyKey: string, over: Partial<AIPreset> = {}): AIPreset => ({
    id: 'pr1',
    name: 'Default',
    storyAIProviderId: 'p1',
    storyAI: { endpoint: 'http://x', apiKey: storyKey, modelName: 'm' },
    ...over,
});

describe('settingsCrypto — encryptProvider / decryptProvider round-trip', () => {
    beforeEach(() => { idbStore.clear(); });

    it('decrypt(encrypt(provider)) deep-equals the original for a non-empty apiKey', async () => {
        const orig = provider('sk-secret-key-12345');
        const enc = await encryptProvider(orig);
        expect(enc.apiKey).not.toBe(orig.apiKey);
        expect(enc.apiKey.startsWith('enc:')).toBe(true);
        const dec = await decryptProvider(enc);
        expect(dec).toEqual(orig);
        expect(dec.apiKey).toBe('sk-secret-key-12345');
    });

    it('ciphertext starts with "enc:" and contains an IV + payload separated by ":"', async () => {
        const enc = await encryptProvider(provider('sk-test'));
        // format: "enc:<base64iv>:<base64ciphertext>"
        expect(enc.apiKey.startsWith('enc:')).toBe(true);
        const payload = enc.apiKey.slice('enc:'.length);
        const parts = payload.split(':');
        expect(parts).toHaveLength(2);
        expect(parts[0].length).toBeGreaterThan(0); // IV (12 bytes base64 -> 16 chars)
        expect(parts[1].length).toBeGreaterThan(0); // ciphertext
    });

    it('each encryption produces a fresh random IV (two encrypts yield different ciphertext)', async () => {
        const orig = provider('sk-same-input');
        const a = await encryptProvider(orig);
        const b = await encryptProvider(orig);
        // Same plaintext, different IV -> different ciphertext strings
        expect(a.apiKey).not.toBe(b.apiKey);
        // Both still decrypt back to the same plaintext
        expect((await decryptProvider(a)).apiKey).toBe('sk-same-input');
        expect((await decryptProvider(b)).apiKey).toBe('sk-same-input');
    });

    it('empty apiKey passes through unchanged (encryptString returns plaintext as-is)', async () => {
        const orig = provider('');
        const enc = await encryptProvider(orig);
        expect(enc.apiKey).toBe('');
        const dec = await decryptProvider(enc);
        expect(dec.apiKey).toBe('');
    });

    it('non-"enc:"-prefixed apiKey passes through decrypt unchanged (plaintext passthrough)', async () => {
        const orig = provider('a-plain-unencrypted-key');
        const dec = await decryptProvider(orig);
        // doesn't start with "enc:" -> decryptString returns it as-is
        expect(dec.apiKey).toBe('a-plain-unencrypted-key');
    });

    it('encrypt preserves all non-apiKey provider fields untouched', async () => {
        const orig = provider('sk-x', { label: 'MyLabel', modelName: 'mistral', endpoint: 'http://e' });
        const enc = await encryptProvider(orig);
        expect(enc.id).toBe(orig.id);
        expect(enc.label).toBe('MyLabel');
        expect(enc.endpoint).toBe('http://e');
        expect(enc.modelName).toBe('mistral');
        expect(enc.apiFormat).toBe('openai');
        expect(enc.streamingEnabled).toBe(true);
    });

    it('malformed ciphertext (tampered payload) decrypts to empty string, no throw', async () => {
        const tampered = provider('enc:AAAA:BBBB');
        const dec = await decryptProvider(tampered);
        // atob("AAAA") is valid base64 but the bytes won't decrypt -> catch -> ""
        expect(dec.apiKey).toBe('');
    });

    it('ciphertext with valid prefix but missing colon delimiter passes through? (pin actual behavior)', async () => {
        // payload.split(':') on "noColon" -> ["noColon"] ; destructure -> ivB64=undefined
        // Uint8Array.from(atob(undefined)) -> atob(undefined) throws -> caught -> ""
        const malformed = provider('enc:noColonHere');
        const dec = await decryptProvider(malformed);
        expect(dec.apiKey).toBe('');
    });

    it('decrypting with a fresh key store (key cleared) returns empty string, no throw', async () => {
        const orig = provider('sk-to-be-orphaned');
        const enc = await encryptProvider(orig);
        // Simulate browser storage clear: wipe the device key
        idbStore.clear();
        const dec = await decryptProvider(enc);
        // A new key is generated but it can't decrypt the old ciphertext -> caught -> ""
        expect(dec.apiKey).toBe('');
    });
});

describe('settingsCrypto — encryptSettingsProviders / decryptSettingsProviders (array)', () => {
    beforeEach(() => { idbStore.clear(); });

    it('round-trips an array of providers with mixed empty and non-empty apiKeys (serialized to avoid key-race)', async () => {
        const orig: LLMProvider[] = [
            provider('sk-one', { id: 'p1' }),
            provider('', { id: 'p2' }),
            provider('sk-three', { id: 'p3' }),
        ];
        // Serialize encrypts to avoid the getDeviceCryptoKey race (see "concurrency race" test below).
        const enc: LLMProvider[] = [];
        for (const p of orig) enc.push(await encryptProvider(p));
        expect(enc[0].apiKey.startsWith('enc:')).toBe(true);
        expect(enc[1].apiKey).toBe(''); // empty passes through
        expect(enc[2].apiKey.startsWith('enc:')).toBe(true);
        const dec = await decryptSettingsProviders(enc);
        expect(dec).toEqual(orig);
    });

    it('empty array round-trips to empty array', async () => {
        const enc = await encryptSettingsProviders([]);
        expect(enc).toEqual([]);
        const dec = await decryptSettingsProviders(enc);
        expect(dec).toEqual([]);
    });

    it('preserves array order and all non-apiKey fields across the round-trip (serialized)', async () => {
        const orig: LLMProvider[] = [
            provider('a', { id: '1', label: 'First' }),
            provider('b', { id: '2', label: 'Second' }),
        ];
        const enc: LLMProvider[] = [];
        for (const p of orig) enc.push(await encryptProvider(p));
        const dec = await decryptSettingsProviders(enc);
        expect(dec.map(p => p.id)).toEqual(['1', '2']);
        expect(dec.map(p => p.label)).toEqual(['First', 'Second']);
        expect(dec.map(p => p.apiKey)).toEqual(['a', 'b']);
    });

    it('KNOWN BUG (pinned): Promise.all on concurrent encrypts races getDeviceCryptoKey — first N-1 encrypts become undecryptable', async () => {
        // encryptSettingsProviders uses Promise.all(providers.map(encryptProvider)).
        // Each encryptProvider awaits idbGet(IDB_DEVICE_KEY); with no mutex, concurrent
        // calls all see idb empty, each generates a different key, and the last idbSet
        // wins. Only the last-encrypted provider's key matches the stored key, so the
        // others fail to decrypt (return ""). This is a real concurrency bug in
        // getDeviceCryptoKey (no once/memoization across concurrent calls). Pinning
        // current behavior — do NOT fix in this test-only plan.
        const orig: LLMProvider[] = [
            provider('sk-first', { id: 'p1' }),
            provider('sk-second', { id: 'p2' }),
            provider('sk-third', { id: 'p3' }),
        ];
        const enc = await encryptSettingsProviders(orig); // concurrent
        const dec = await decryptSettingsProviders(enc);
        // At least one of the first two decrypts to "" (lost the key race); the last
        // one may or may not survive depending on idbSet ordering. Assert the race
        // manifests as at least one empty decryption among the non-empty originals.
        const emptyCount = dec.filter(p => p.apiKey === '').length;
        expect(emptyCount).toBeGreaterThanOrEqual(1);
    });
});

describe('settingsCrypto — legacy encryptPreset / decryptPreset round-trip', () => {
    beforeEach(() => { idbStore.clear(); });

    it('round-trips a preset with all four inline-config apiKeys', async () => {
        const orig: AIPreset = {
            id: 'pr1', name: 'P',
            storyAIProviderId: 'p1',
            storyAI: { endpoint: 'http://s', apiKey: 'sk-story', modelName: 'm1' },
            imageAI: { endpoint: 'http://i', apiKey: 'sk-image', modelName: 'm2' },
            summarizerAI: { endpoint: 'http://su', apiKey: 'sk-summ', modelName: 'm3' },
            utilityAI: { endpoint: 'http://u', apiKey: 'sk-util', modelName: 'm4' },
        };
        const enc = await encryptPreset(orig);
        expect(enc.storyAI!.apiKey.startsWith('enc:')).toBe(true);
        expect(enc.imageAI!.apiKey.startsWith('enc:')).toBe(true);
        expect(enc.summarizerAI!.apiKey.startsWith('enc:')).toBe(true);
        expect(enc.utilityAI!.apiKey.startsWith('enc:')).toBe(true);
        const dec = await decryptPreset(enc);
        expect(dec).toEqual(orig);
    });

    it('preset with no inline configs (only *AIProviderId) round-trips unchanged', async () => {
        const orig: AIPreset = { id: 'pr1', name: 'P', storyAIProviderId: 'p1' };
        const enc = await encryptPreset(orig);
        // no storyAI/imageAI/etc -> the spread conditionals are all falsy -> shape unchanged
        expect(enc).toEqual(orig);
        const dec = await decryptPreset(enc);
        expect(dec).toEqual(orig);
    });

    it('preset with only storyAI encrypts only storyAI.apiKey; others absent', async () => {
        const orig = preset('sk-story');
        const enc = await encryptPreset(orig);
        expect(enc.storyAI!.apiKey.startsWith('enc:')).toBe(true);
        expect(enc.imageAI).toBeUndefined();
        expect(enc.summarizerAI).toBeUndefined();
        expect(enc.utilityAI).toBeUndefined();
        const dec = await decryptPreset(enc);
        expect(dec.storyAI!.apiKey).toBe('sk-story');
    });

    it('empty apiKeys in a preset pass through unchanged', async () => {
        const orig: AIPreset = {
            id: 'pr1', name: 'P', storyAIProviderId: 'p1',
            storyAI: { endpoint: 'http://s', apiKey: '', modelName: 'm' },
        };
        const enc = await encryptPreset(orig);
        expect(enc.storyAI!.apiKey).toBe('');
        const dec = await decryptPreset(enc);
        expect(dec.storyAI!.apiKey).toBe('');
    });

    it('preset encryption preserves non-apiKey fields on each inline config', async () => {
        const orig: AIPreset = {
            id: 'pr1', name: 'P', storyAIProviderId: 'p1',
            storyAI: { endpoint: 'http://s', apiKey: 'sk', modelName: 'm', apiFormat: 'openai' },
        };
        const enc = await encryptPreset(orig);
        expect(enc.storyAI!.endpoint).toBe('http://s');
        expect(enc.storyAI!.modelName).toBe('m');
        expect(enc.storyAI!.apiFormat).toBe('openai');
    });
});

describe('settingsCrypto — encryptSettingsPresets / decryptSettingsPresets (array)', () => {
    beforeEach(() => { idbStore.clear(); });

    it('round-trips an array of presets with mixed inline configs (serialized to avoid key-race)', async () => {
        const orig: AIPreset[] = [
            preset('sk-a', { id: 'p1' }),
            { id: 'p2', name: 'Q', storyAIProviderId: 'x' }, // no inline configs
            preset('sk-c', { id: 'p3' }),
        ];
        // Serialize to avoid the getDeviceCryptoKey race (same bug as the providers array).
        const enc: AIPreset[] = [];
        for (const p of orig) enc.push(await encryptPreset(p));
        expect(enc[0].storyAI!.apiKey.startsWith('enc:')).toBe(true);
        expect(enc[1].storyAI).toBeUndefined();
        expect(enc[2].storyAI!.apiKey.startsWith('enc:')).toBe(true);
        const dec = await decryptSettingsPresets(enc);
        expect(dec).toEqual(orig);
    });

    it('empty array round-trips to empty array', async () => {
        expect(await decryptSettingsPresets(await encryptSettingsPresets([]))).toEqual([]);
    });
});

describe('settingsCrypto — ciphertext != plaintext (security property)', () => {
    beforeEach(() => { idbStore.clear(); });

    it('a long realistic apiKey never appears in the ciphertext string', async () => {
        const secret = 'sk-proj-abcdef1234567890xyz-LONGKEY';
        const enc = await encryptProvider(provider(secret));
        expect(enc.apiKey).not.toContain(secret);
        // And the ciphertext is non-trivially longer than the plaintext (IV + GCM tag)
        expect(enc.apiKey.length).toBeGreaterThan(secret.length);
    });
});