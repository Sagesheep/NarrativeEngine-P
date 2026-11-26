import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    rerankCandidates: vi.fn(),
}));
vi.mock('../../retrieval/semanticReranker', () => ({
    rerankCandidates: mocks.rerankCandidates,
}));
// Every live turn runs under the host facade; the reranker must work there.
vi.mock('../../turn/hostFacade', () => ({
    hasHostModelRole: () => true,
}));

import { gatherSemanticCandidates, sceneRerankSummary, recentSceneText } from '../semanticCandidates';
import type { TurnState } from '../../turn/turnOrchestrator';
import type { HostFacade } from '../../turn/hostFacade';
import type { ArchiveIndexEntry } from '../../../types';

const sceneIds = ['101', '102', '103', '104', '105', '106'];
const archiveIndex = sceneIds.map(sceneId => ({
    sceneId,
    keywords: ['docks', 'lantern'],
    userSnippet: `player line ${sceneId}`,
    witnesses: ['Therese'],
    events: [{ eventType: 'deal', text: `event in ${sceneId}`, importance: 5 }],
})) as unknown as ArchiveIndexEntry[];

const LONG_INPUT = 'I walk back down to the docks and look for whoever was waiting there tonight';

function setup(input: string, moduleEnabled?: Record<string, boolean>) {
    const modelCall = vi.fn().mockResolvedValue({ content: '["ask Therese about the letter", "Therese letter of introduction"]' });
    const state = {
        input,
        settings: { aiTier: 'max', moduleEnabled },
        npcLedger: [{ name: 'Therese' }, { name: 'Kaiser Aldricht Voss' }],
        messages: [
            { role: 'user', content: 'I sit down across from Therese.' },
            { role: 'assistant', content: 'Therese slides the sealed letter across the desk.' },
        ],
        loreChunks: [],
        archiveIndex,
        activeCampaignId: 'c1',
    } as unknown as TurnState;
    const facade = {
        data: { input, npcLedger: state.npcLedger, messages: state.messages, loreChunks: [], archiveIndex, activeCampaignId: 'c1' },
        config: { aiTier: 'max' },
        model: { call: modelCall },
    } as unknown as HostFacade;
    return { state, facade, modelCall };
}

beforeEach(() => {
    mocks.rerankCandidates.mockReset().mockImplementation(async (_q: string, candidates: { id: string }[]) =>
        candidates.map(c => c.id).reverse());
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
        ok: true,
        json: async () => url.includes('/archive/') ? { sceneIds } : url.includes('/lore/') ? { loreIds: [] } : { ruleIds: [] },
    })));
});
afterEach(() => vi.unstubAllGlobals());

describe('gatherSemanticCandidates — reranker', () => {
    it('reranks scene candidates under the host facade', async () => {
        const { state, facade } = setup(LONG_INPUT);
        const result = await gatherSemanticCandidates(state, undefined, facade);

        expect(mocks.rerankCandidates).toHaveBeenCalledTimes(1);
        expect(result.semanticArchiveIds).toEqual([...sceneIds].reverse());
        const candidates = mocks.rerankCandidates.mock.calls[0][1] as { summary: string }[];
        expect(candidates[0].summary).toContain('event in 101');
    });

    it('a Block View "off" skips it', async () => {
        const { state, facade } = setup(LONG_INPUT, { reranker: false });
        const result = await gatherSemanticCandidates(state, undefined, facade);

        expect(mocks.rerankCandidates).not.toHaveBeenCalled();
        expect(result.semanticArchiveIds).toEqual(sceneIds);
    });
});

describe('gatherSemanticCandidates — query expansion', () => {
    it('expands a short message with thinking off', async () => {
        const { state, facade, modelCall } = setup('ask her about it', { expandQuery: true });
        await gatherSemanticCandidates(state, undefined, facade);

        const request = modelCall.mock.calls.find(([, r]) => r.trackingLabel === 'query-expansion')?.[1];
        expect(request).toBeDefined();
        expect(request.thinkingEffort).toBe('off');
        const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
        expect(body.queries).toEqual(['ask her about it', 'ask Therese about the letter', 'Therese letter of introduction']);
        // It sees the last exchange and only the NPCs named there, not the start of the ledger.
        expect(request.prompt).toContain('Therese slides the sealed letter');
        expect(request.prompt).toContain('CHARACTERS IN THE RECENT SCENE: Therese');
        expect(request.prompt).not.toContain('Kaiser');
    });
});

describe('sceneRerankSummary', () => {
    it('shows what happened and who was there, not just keywords', () => {
        const summary = sceneRerankSummary(archiveIndex[0]);
        expect(summary).toBe('event in 101 | present: Therese | player: player line 101');
    });

    it('falls back to keywords when the scene has no event tags', () => {
        const entry = { ...archiveIndex[0], events: undefined, witnesses: [] } as ArchiveIndexEntry;
        expect(sceneRerankSummary(entry)).toBe('docks, lantern | player: player line 101');
    });
});

describe('recentSceneText', () => {
    it('keeps the last player line and GM reply, skipping system messages', () => {
        const text = recentSceneText([
            { role: 'user', content: 'old' },
            { role: 'assistant', content: 'older reply' },
            { role: 'user', content: 'I nod.' },
            { role: 'system', content: 'note' },
            { role: 'assistant', content: 'She smiles.' },
        ] as never);
        expect(text).toBe('PLAYER: I nod.\n\nGM: She smiles.');
    });
});
