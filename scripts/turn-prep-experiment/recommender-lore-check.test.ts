/* eslint-disable @typescript-eslint/no-explicit-any */
// Turn Prep Experiment — D3: do the Context Recommender's lore picks add anything?
//
// The recommender returns lore ids every turn, but nothing consumes them; the prompt's lore
// comes from retrieveRelevantLore (keywords + meaning search, reranked). For each probe this
// prints: the lore the prompt gets today, the recommender's picks (thinking off), and the
// picks the prompt is MISSING, so they can be judged by hand. Also prints how big the lore
// index sent to the recommender is. exp-c1-rebuilt, read-only. Needs the backend on :3001.
//
//   npx vitest run --config scripts/turn-prep-experiment/vitest.experiment.config.ts recommender-lore-check

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
const out = (...a: unknown[]) => process.stdout.write(a.join(' ') + '\n');
const read = (f: string) => JSON.parse(fs.readFileSync(path.resolve('data/campaigns', `${CAMPAIGN}.${f}`), 'utf8'));

const PROBES: [string, string][] = [
    ['P2', 'I open the letter from the Soll household.'],
    ['P3', 'I tell Rin: "Therese is going to want what we promised her back at the Soll study."'],
    ['P5', 'On the way back from the market I spot Helena Broadmarsh across the square. I walk over.'],
    ['P6', 'I remind Rin how we pinned everything on Pell with that forged IOU, back in Marken.'],
    ['S3', 'What did we promise Therese?'],
    ['S6', 'Tell Rin about the Pell job.'],
];

it('recommender lore picks vs the lore the prompt gets', async () => {
    const SERVER = 'http://localhost:3001';
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
        let url = typeof input === 'string' ? input : input?.url ?? String(input);
        if (url.startsWith('/')) url = SERVER + url;
        return realFetch(url, init);
    }) as typeof fetch;

    const { useAppStore } = await import('../../src/store/useAppStore');
    const { recommendContext } = await import('../../src/services/turn/contextRecommender');
    const { gatherSemanticCandidates } = await import('../../src/services/context-gatherer/semanticCandidates');
    const { retrieveRelevantLore } = await import('../../src/services/lore/loreRetriever');
    const { countTokens } = await import('../../src/services/infrastructure/tokenizer');
    const { llmCall } = await import('../../src/utils/llmCall');

    await useAppStore.getState().loadSettings();
    const provider = (useAppStore.getState().settings.providers ?? []).find(p => p.label === 'DS v4 Flash')!;
    provider.apiKey = JSON.parse(fs.readFileSync(path.join(HERE, '.keys.json'), 'utf8'))['DS v4 Flash'];

    const saved = read('state.json');
    const npcs = read('npcs.json');
    const loreRaw = read('lore.json');
    const lore: any[] = Array.isArray(loreRaw) ? loreRaw : loreRaw.chunks ?? [];
    const archiveIndex = read('archive.index.json');
    const ctx = saved.context ?? {};
    const messages = saved.messages.slice((saved.condenser?.condensedUpToIndex ?? -1) + 1);
    const header = new Map(lore.map(c => [c.id, c.header as string]));
    const pickable = lore.filter(c => !c.alwaysInclude);
    const indexTokens = countTokens(pickable.map(c => `${c.id}: ${c.header}${c.summary ? ` — ${c.summary}` : ''}`).join('\n'));
    out(`lore chunks: ${lore.length} (${pickable.length} pickable, ${lore.length - pickable.length} always-included); lore index ≈ ${indexTokens} tokens per recommender call`);

    for (const [id, input] of PROBES) {
        const state: any = {
            input, messages: saved.messages, condenser: saved.condenser, context: ctx,
            npcLedger: npcs, loreChunks: lore, archiveIndex, activeCampaignId: CAMPAIGN,
            settings: { aiTier: 'max', moduleEnabled: {} },
            getUtilityEndpoint: () => provider,
        };
        const semantic = await gatherSemanticCandidates(state);
        const inPrompt = (retrieveRelevantLore(lore, ctx.canonState, ctx.headerIndex, input, 1200, saved.messages, semantic.semanticLoreIds, 'idf-rrf') ?? [])
            .map((c: any) => c.id as string);
        const rec = await recommendContext(
            undefined, npcs, lore, messages, input, undefined, undefined,
            ctx.inventoryItems ?? [], ctx.characterProfileData, 120_000,
            req => llmCall(provider, req.prompt, { ...req, thinkingEffort: 'off' }).then(content => ({ content })),
        );
        const picks = rec.relevantLoreIds;
        const missing = picks.filter(p => !inPrompt.includes(p));
        out(`\n== ${id} "${input}"`);
        out(`  prompt lore (${inPrompt.length}): ${inPrompt.map(l => header.get(l)).join(' | ')}`);
        out(`  recommender picks (${picks.length}): ${picks.map(l => header.get(l) ?? l).join(' | ')}`);
        out(`  picks the prompt MISSES (${missing.length}):`);
        for (const m of missing) {
            const chunk = lore.find(c => c.id === m);
            out(`    - ${header.get(m) ?? m}: ${String(chunk?.summary || chunk?.content || '').replace(/\s+/g, ' ').slice(0, 160)}`);
        }
    }
}, 900_000);
