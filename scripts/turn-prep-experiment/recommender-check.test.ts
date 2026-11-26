/* eslint-disable @typescript-eslint/no-explicit-any */
// Turn Prep Experiment — does the Context Recommender pick better with thinking on?
// Runs recommendContext on each memory probe's turn (exp-c1-rebuilt, read-only), with the
// story endpoint's thinking left on (its effort, high) and with thinking off, N samples each.
// Prints the picks and timing. One model call per run; writes nothing.
//
//   EXP_SAMPLES=2 npx vitest run --config scripts/turn-prep-experiment/vitest.experiment.config.ts recommender-check
import fs from 'fs';
import path from 'path';
import { it, vi } from 'vitest';

const idbMemory = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
    get: async (k: string) => idbMemory.get(k),
    set: async (k: string, v: unknown) => { idbMemory.set(k, v); },
    del: async (k: string) => { idbMemory.delete(k); },
}));

const HERE = path.resolve('scripts/turn-prep-experiment');
const CAMPAIGN = 'exp-c1-rebuilt';
const SAMPLES = Number(process.env.EXP_SAMPLES ?? 2);
const out = (...a: unknown[]) => process.stdout.write(a.join(' ') + '\n');
const read = (f: string) => JSON.parse(fs.readFileSync(path.resolve('data/campaigns', `${CAMPAIGN}.${f}`), 'utf8'));

const PROBES: [string, string][] = [
    ['P2', 'I open the letter from the Soll household.'],
    ['P3', 'I tell Rin: "Therese is going to want what we promised her back at the Soll study."'],
    ['P5', 'On the way back from the market I spot Helena Broadmarsh across the square. I walk over.'],
    ['P6', 'I remind Rin how we pinned everything on Pell with that forged IOU, back in Marken.'],
];

it('recommender picks, thinking on vs off', async () => {
    const SERVER = 'http://localhost:3001';
    const realFetch = globalThis.fetch;
    let lastUsage = '';
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
        let url = typeof input === 'string' ? input : input?.url ?? String(input);
        if (url.startsWith('/')) url = SERVER + url;
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method !== 'GET' && !url.endsWith('/llm/proxy')) return new Response('{}', { status: 200 });
        const res = await realFetch(url, init);
        if (url.endsWith('/llm/proxy')) {
            try { const u = JSON.parse(await res.clone().text()).usage; lastUsage = u ? `out ${u.completion_tokens} (reasoning ${u.completion_tokens_details?.reasoning_tokens ?? 0})` : ''; } catch { lastUsage = ''; }
        }
        return res;
    }) as typeof fetch;

    const { useAppStore } = await import('../../src/store/useAppStore');
    const { recommendContext } = await import('../../src/services/turn/contextRecommender');
    const { llmCall } = await import('../../src/utils/llmCall');
    await useAppStore.getState().loadSettings();
    const provider = (useAppStore.getState().settings.providers ?? []).find(p => p.label === 'DS v4 Flash')!;
    provider.apiKey = JSON.parse(fs.readFileSync(path.join(HERE, '.keys.json'), 'utf8'))['DS v4 Flash'];

    const state = read('state.json');
    const npcs = read('npcs.json');
    const loreRaw = read('lore.json');
    const lore = Array.isArray(loreRaw) ? loreRaw : loreRaw.chunks ?? [];
    const messages = state.messages.slice(state.condenser.condensedUpToIndex + 1);
    const ctx = state.context ?? {};
    const loreHeader = new Map(lore.map((c: any) => [c.id, c.header]));

    for (const [probe, input] of PROBES) {
        for (const mode of ['on', 'off'] as const) {
            for (let s = 1; s <= SAMPLES; s++) {
                const t = Date.now();
                const result = await recommendContext(
                    undefined, npcs, lore, messages, input, undefined, undefined,
                    ctx.inventoryItems ?? [], ctx.characterProfileData, 120_000,
                    (req) => llmCall(provider, req.prompt, { ...req, thinkingEffort: mode === 'off' ? 'off' : undefined }).then(content => ({ content })),
                );
                const secs = ((Date.now() - t) / 1000).toFixed(1);
                out(`${probe} thinking ${mode.padEnd(3)} s${s} ${secs.padStart(5)}s ${lastUsage}`);
                out(`   npcs: ${result.relevantNPCNames.join(', ')}`);
                out(`   lore: ${result.relevantLoreIds.map(id => loreHeader.get(id) ?? id).join(' | ')}`);
                out(`   inventory: ${result.inventoryCategories.join(', ')}   profile: ${result.profileFields.join(', ')}`);
            }
        }
    }
}, 1_200_000);
