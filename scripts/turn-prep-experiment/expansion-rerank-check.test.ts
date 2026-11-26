/* eslint-disable @typescript-eslint/no-explicit-any */
// Turn Prep Experiment — do Query Expansion and the Reranker help recall on SHORT messages?
//
// Runs the real retrieval path (gatherSemanticCandidates → selectMemoryRecallIds, the flat
// hybrid recall Max uses since 5bf613a) on short versions of the memory probes, exp-c1-rebuilt,
// read-only. Four modes: plain, +expansion, +reranker, +both; EXP_SAMPLES samples each.
// Needs the backend on :3001 (meaning search). Utility calls go to DS v4 Flash, thinking off.
//
//   EXP_SAMPLES=2 npx vitest run --config scripts/turn-prep-experiment/vitest.experiment.config.ts expansion-rerank-check

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
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => String(a + i).padStart(3, '0'));

// Short messages (< 8 words, so expansion fires) and the scenes that hold the answer
// (probes.json criteria).
const PROBES: { id: string; input: string; targets: string[] }[] = [
    { id: 'P2', input: 'I open the Soll letter.', targets: range(533, 534) },
    { id: 'P3', input: 'What did we promise Therese?', targets: range(533, 534) },
    { id: 'P5', input: 'I walk over to Helena.', targets: ['282', ...range(144, 145)] },
    { id: 'P6', input: 'Remember the IOU we planted?', targets: range(113, 119) },
    { id: 'P6b', input: 'Tell Rin about the Pell job.', targets: range(113, 119) },
];
const MODES = [
    { name: 'plain', expandQuery: false, reranker: false },
    { name: '+expand', expandQuery: true, reranker: false },
    { name: '+rerank', expandQuery: false, reranker: true },
    { name: '+both', expandQuery: true, reranker: true },
];

it('expansion and reranker on short messages', async () => {
    const SERVER = 'http://localhost:3001';
    const realFetch = globalThis.fetch;
    let lastQueries: string[] = [];
    let rerankLog: string[] = [];
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
        let url = typeof input === 'string' ? input : input?.url ?? String(input);
        if (url.startsWith('/')) url = SERVER + url;
        if (url.includes('/archive/semantic-candidates') && init?.body) {
            const body = JSON.parse(String(init.body));
            lastQueries = body.queries ?? [body.query];
        }
        const res = await realFetch(url, init);
        if (init?.body && String(init.body).includes('filtering memory candidates')) {
            try {
                const j = JSON.parse(await res.clone().text());
                const content = j.choices?.[0]?.message?.content ?? j.content ?? JSON.stringify(j).slice(0, 200);
                const n = (String(init.body).match(/\nd{3}: /g) ?? []).length;
                rerankLog.push(`${n} scene cands → ${String(content).replace(/s+/g, ' ').slice(0, 160)}`);
            } catch { rerankLog.push('unparsed'); }
        }
        return res;
    }) as typeof fetch;

    const { useAppStore } = await import('../../src/store/useAppStore');
    const { gatherSemanticCandidates } = await import('../../src/services/context-gatherer/semanticCandidates');
    const { selectMemoryRecallIds, toMemoryRecallChapters, buildExcludeSceneIds } = await import('../../src/services/context-gatherer/archiveRecall');
    const { getDivergenceSceneIds, EMPTY_REGISTER } = await import('../../src/services/campaign-state/divergenceRegister');

    await useAppStore.getState().loadSettings();
    const provider = (useAppStore.getState().settings.providers ?? []).find(p => p.label === 'DS v4 Flash')!;
    provider.apiKey = JSON.parse(fs.readFileSync(path.join(HERE, '.keys.json'), 'utf8'))['DS v4 Flash'];

    const saved = read('state.json');
    const npcLedger = read('npcs.json');
    const loreRaw = read('lore.json');
    const loreChunks = Array.isArray(loreRaw) ? loreRaw : loreRaw.chunks ?? [];
    const archiveIndex = read('archive.index.json');
    const chapters = read('archive.chapters.json');
    let divergence: any = EMPTY_REGISTER;
    try { divergence = read('divergence.json'); } catch { /* none */ }

    for (const probe of PROBES) {
        out(`\n== ${probe.id} "${probe.input}"   targets ${probe.targets[0]}${probe.targets.length > 1 ? `–${probe.targets[probe.targets.length - 1]}` : ''}`);
        for (const mode of MODES) {
            for (let s = 1; s <= (mode.name === 'plain' ? 1 : SAMPLES); s++) {
                const state: any = {
                    input: probe.input,
                    messages: saved.messages,
                    condenser: saved.condenser,
                    context: saved.context ?? {},
                    npcLedger, loreChunks, archiveIndex,
                    activeCampaignId: CAMPAIGN,
                    settings: { aiTier: 'max', moduleEnabled: { expandQuery: mode.expandQuery, reranker: mode.reranker } },
                    getUtilityEndpoint: () => provider,
                };
                lastQueries = [];
                rerankLog = [];
                const t = Date.now();
                const semantic = await gatherSemanticCandidates(state);
                const exclude = buildExcludeSceneIds(state);
                const ids = await selectMemoryRecallIds({
                    campaignId: CAMPAIGN,
                    query: probe.input,
                    messages: state.messages.slice((saved.condenser?.condensedUpToIndex ?? -1) + 1),
                    archiveIndex,
                    chapters: toMemoryRecallChapters(chapters),
                    npcLedger,
                    semanticFacts: [],
                    candidateSceneIds: semantic.semanticArchiveIds,
                    plannerSceneIds: undefined,
                    excludeSceneIds: [...(exclude ?? [])],
                    divergenceSceneIds: [...getDivergenceSceneIds(divergence)],
                    depth: 'standard',
                    tokenBudget: 3000,
                }, { chapters, aiTier: 'max', moduleEnabled: {} }) ?? [];
                const secs = ((Date.now() - t) / 1000).toFixed(1);
                const semTop = (semantic.semanticArchiveIds ?? []).slice(0, 12);
                const mark = (list: string[]) => list.map(id => (probe.targets.includes(id) ? `*${id}*` : id)).join(',');
                const recallHits = ids.slice(0, 6).filter(id => probe.targets.includes(id)).length;
                out(`  ${mode.name.padEnd(8)} s${s} ${secs.padStart(5)}s  recall top6 hits ${recallHits}  recall [${mark(ids.slice(0, 8))}]`);
                out(`           meaning top12 [${mark(semTop)}]`);
                for (const r of rerankLog) out(`           rerank: ${r}`);
                if (mode.expandQuery && lastQueries.length > 1) out(`           queries: ${lastQueries.slice(1).map(q => `"${q}"`).join(' | ')}`);
            }
        }
    }
}, 1_800_000);
