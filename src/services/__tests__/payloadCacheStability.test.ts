import { describe, it, expect } from 'vitest';
import { buildPayload } from '../payload/payloadBuilder';
import type {
    GameContext,
    AppSettings,
    NPCEntry,
    DivergenceRegister,
    DivergenceEntry,
} from '../../types';
import type { OpenAIMessage } from '../llm/llmService';

// ─────────────────────────────────────────────────────────────────────────────
// Phase 6 ORACLE — cast-aware divergence cache-prefix split.
//
// The cached prompt prefix (every message carrying cache_control: ephemeral —
// on desktop the stable preamble + the [ESTABLISHED FACTS] divergence block) MUST
// be byte-identical across turns whenever the on-stage cast changes. Public facts
// (knownBy === undefined) ride in the cached block; cast-scoped facts (knownBy
// defined) ride in the per-turn [FACTS KNOWN TO ON-STAGE CHARACTERS] world block
// below the cache boundary. A regression here busts the prompt cache silently —
// no other test catches it, so this is the gate.
// ─────────────────────────────────────────────────────────────────────────────

const baseContext = (): GameContext => ({
    loreRaw: '',
    rulesRaw: '',
    canonState: '',
    headerIndex: '',
    starter: '',
    continuePrompt: '',
    inventory: '',
    inventoryLastScene: 'Never',
    characterProfile: '',
    characterProfileLastScene: 'Never',
    canonStateActive: false,
    headerIndexActive: false,
    starterActive: false,
    continuePromptActive: false,
    inventoryActive: false,
    characterProfileActive: false,
    surpriseEngineActive: false,
    encounterEngineActive: true,
    worldEngineActive: true,
    diceFairnessActive: true,
    sceneNote: '',
    sceneNoteActive: false,
    sceneNoteDepth: 3,
    worldVibe: '',
    notebook: [],
    notebookActive: false,
    worldEventConfig: { initialDC: 498, dcReduction: 2, who: [], where: [], why: [], what: [] },
} as unknown as GameContext);

// Large context limit so nothing gets trimmed — we want the full split visible.
const baseSettings = (): AppSettings => ({ debugMode: false, contextLimit: 8192 } as unknown as AppSettings);

function makeNPC(id: string, name: string, faction = ''): NPCEntry {
    return {
        id, name, aliases: '', appearance: '', faction,
        storyRelevance: '', disposition: 'neutral', status: 'alive',
        goals: '', voice: '', personality: '', exampleOutput: '',
        affinity: 0, archived: false,
    } as NPCEntry;
}

function makeEntry(id: string, text: string, knownBy?: string[]): DivergenceEntry {
    return {
        id,
        chapterId: 'CH01',
        category: 'world_state',
        text,
        sceneRef: '001',
        npcIds: [],
        pinned: false,
        enabled: true,
        source: 'manual',
        knownBy,
    } as DivergenceEntry;
}

// One public fact (cached) + two cast-scoped facts (volatile, below cache boundary).
const PUBLIC_TEXT = 'The harbor district flooded after the storm.';
const SCOPED_A_TEXT = 'Aldric secretly betrayed the Crimson Guild.';
const SCOPED_C_TEXT = 'Cyra hides a stolen relic beneath the chapel.';

function makeRegister(): DivergenceRegister {
    return {
        entries: [
            makeEntry('pub1', PUBLIC_TEXT, undefined),          // public → cached
            makeEntry('scoA', SCOPED_A_TEXT, ['npc:npc_a']),    // scoped to A → volatile
            makeEntry('scoC', SCOPED_C_TEXT, ['npc:npc_c']),    // scoped to C → volatile
        ],
        chapterToggles: {},
        categoryToggles: {},
        lastUpdatedSceneId: '001',
        lastUpdatedAt: 0,
        version: 2,
    };
}

const NPCS = [makeNPC('npc_a', 'Aldric', 'Crimson Guild'), makeNPC('npc_b', 'Bella'), makeNPC('npc_c', 'Cyra')];

/** The cached prefix = every assembled message carrying cache_control: ephemeral. */
function cachedPrefix(messages: OpenAIMessage[]): string {
    return messages
        .filter(m => (m as unknown as { cache_control?: { type: string } }).cache_control?.type === 'ephemeral')
        .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join('\n----CACHE-BOUNDARY----\n');
}

/** Non-cached volatile content (where the volatile scoped-knowledge block lives).
 *  After the cache-layout fix, worldContent + volatileContent are folded into the
 *  final user message (below the cache boundary), not emitted as a system message. */
function volatileContent(messages: OpenAIMessage[]): string {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    return lastUser && typeof lastUser.content === 'string' ? lastUser.content : '';
}

function build(onStageNpcIds: string[]) {
    return buildPayload({
        settings: baseSettings(),
        context: baseContext(),
        history: [],
        userMessage: 'What happens next?',
        npcLedger: NPCS,
        divergenceRegister: makeRegister(),
        onStageNpcIds,
    });
}

describe('Phase 6 — divergence cache-prefix stability', () => {
    it('cached prefix is byte-identical across two SAME-cast turns', () => {
        const turnN = build(['npc_a', 'npc_b']);
        const turnN1 = build(['npc_a', 'npc_b']);
        expect(cachedPrefix(turnN1.messages)).toBe(cachedPrefix(turnN.messages));
    });

    it('cached prefix STAYS byte-identical when the on-stage cast CHANGES', () => {
        // This is the whole point of the split: cast-scoped facts moved out of the
        // cached block, so swapping B for C must not perturb the cached prefix.
        const turnN = build(['npc_a', 'npc_b']);
        const turnN2 = build(['npc_a', 'npc_c']);
        expect(cachedPrefix(turnN2.messages)).toBe(cachedPrefix(turnN.messages));
    });

    it('cached block carries the PUBLIC fact but NOT the cast-scoped facts', () => {
        const prefix = cachedPrefix(build(['npc_a', 'npc_b']).messages);
        expect(prefix).toContain(PUBLIC_TEXT);
        expect(prefix).not.toContain(SCOPED_A_TEXT);
        expect(prefix).not.toContain(SCOPED_C_TEXT);
    });

    it('cached divergence block is emitted with cache_control: ephemeral', () => {
        const { messages } = build(['npc_a', 'npc_b']);
        const divMsg = messages.find(
            m => m.role === 'system' && typeof m.content === 'string' && m.content.includes(PUBLIC_TEXT)
        );
        expect(divMsg).toBeDefined();
        expect((divMsg as unknown as { cache_control?: unknown }).cache_control).toEqual({ type: 'ephemeral' });
    });

    it('scoped facts surface in the VOLATILE block, bounded to the present cast', () => {
        // Turn N: A on-stage → A-scoped fact surfaces; C off-stage → C-scoped fact withheld.
        const volN = volatileContent(build(['npc_a', 'npc_b']).messages);
        expect(volN).toContain('[FACTS KNOWN TO ON-STAGE CHARACTERS]');
        expect(volN).toContain(SCOPED_A_TEXT);
        expect(volN).not.toContain(SCOPED_C_TEXT);

        // Turn N+2: A and C on-stage → both scoped facts surface.
        const volN2 = volatileContent(build(['npc_a', 'npc_c']).messages);
        expect(volN2).toContain(SCOPED_A_TEXT);
        expect(volN2).toContain(SCOPED_C_TEXT);

        // The volatile block MUST differ across the cast change (proof the cage is live).
        expect(volN2).not.toBe(volN);
    });

    it('a cast-scoped fact never leaks into the cached prefix even when its NPC is on-stage', () => {
        // A is on-stage here; its scoped fact appears volatile, never cached.
        const { messages } = build(['npc_a']);
        expect(cachedPrefix(messages)).not.toContain(SCOPED_A_TEXT);
        expect(volatileContent(messages)).toContain(SCOPED_A_TEXT);
    });

    it('history tail carries cache_control: ephemeral so history rides inside the cached prefix', () => {
        // Build with two history messages so the cache breakpoint lands on the last history entry,
        // NOT on the final volatile user message.
        const historyA: import('../../types').ChatMessage = {
            id: 'h1', role: 'user', content: 'First history user turn', timestamp: 1,
        };
        const historyB: import('../../types').ChatMessage = {
            id: 'h2', role: 'assistant', content: 'First history assistant reply', timestamp: 2,
        };
        const { messages } = buildPayload({ settings: baseSettings(), context: baseContext(), history: [historyA, historyB], userMessage: 'What happens next?', condensedUpToIndex: undefined, relevantLore: undefined, npcLedger: NPCS, archiveRecall: undefined, recommendedNPCNames: undefined, semanticFactText: undefined, archiveIndex: undefined, timelineEvents: undefined, inventoryCategories: undefined, profileFields: undefined, deepContextSummary: undefined, divergenceRegister: makeRegister(), chapters: undefined, onStageNpcIds: ['npc_a'] });

        // The last message carrying cache_control: ephemeral must be a history message
        // (its content matches one of our history entries), not the final volatile user message.
        const ephemeralMsgs = messages.filter(
            m => (m as unknown as { cache_control?: { type: string } }).cache_control?.type === 'ephemeral'
        );
        expect(ephemeralMsgs.length).toBeGreaterThan(0);
        const lastEphemeral = ephemeralMsgs[ephemeralMsgs.length - 1];
        // The last ephemeral message must be a history entry (user or assistant role with history content).
        expect(['user', 'assistant']).toContain(lastEphemeral.role);
        const content = typeof lastEphemeral.content === 'string' ? lastEphemeral.content : '';
        expect(
            content === historyA.content || content === historyB.content
        ).toBe(true);
    });
});
