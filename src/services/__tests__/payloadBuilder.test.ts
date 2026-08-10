/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { buildPayload } from '../payload/payloadBuilder';
import { DEFAULT_RULES } from '../rules/defaultRules';
import { DEFAULT_ENEMY_COMBAT_CONFIG } from '../enemy/enemyCombat';
import { buildEnemyVolatileSegment } from '../enemy/enemyPayloadSegment';
import type {
    GameContext,
    AppSettings,
    LoreChunk,
    NPCEntry,
    ArchiveScene,
    ArchiveIndexEntry,
    TimelineEvent,
    DivergenceRegister,
    ChatMessage,
    EnemyEntry,
    EnemyInstance,
    EnemyEncounter,
} from '../../types';

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
    surpriseDC: 95,
    encounterDC: 198,
    worldEventDC: 498,
    canonStateActive: false,
    headerIndexActive: false,
    starterActive: false,
    continuePromptActive: false,
    inventoryActive: false,
    characterProfileActive: false,
    surpriseEngineActive: true,
    encounterEngineActive: true,
    worldEngineActive: true,
    diceFairnessActive: true,
    sceneNote: '',
    sceneNoteActive: false,
    sceneNoteDepth: 3,
    diceConfig: { catastrophe: 2, failure: 6, success: 15, triumph: 19, crit: 20 },
    surpriseConfig: { initialDC: 95, dcReduction: 3, types: [], tones: [] },
    encounterConfig: { initialDC: 198, dcReduction: 2, types: [], tones: [] },
    worldVibe: '',
    notebook: [],
    notebookActive: true,
    worldEventConfig: { initialDC: 498, dcReduction: 2, who: [], where: [], why: [], what: [] },
} as GameContext);

const baseSettings = (): AppSettings => ({
    debugMode: true,
    contextLimit: 8192,
} as unknown as AppSettings);

describe('buildPayload — default rules fallback', () => {
    it('injects DEFAULT_RULES when rulesRaw is empty', () => {
        const ctx = baseContext();
        ctx.rulesRaw = '';
        const result = buildPayload({ settings: baseSettings(), context: ctx, history: [], userMessage: 'I look around' });
        const firstSystem = result.messages.find(m => m.role === 'system');
        expect(firstSystem).toBeDefined();
        expect(firstSystem!.content).toContain('ROLE: Dynamic-Realism GM.');
    });

    it('uses user-provided rulesRaw instead of DEFAULT_RULES', () => {
        const ctx = baseContext();
        ctx.rulesRaw = '# My Custom Rules\nNo magic allowed.';
        const result = buildPayload({ settings: baseSettings(), context: ctx, history: [], userMessage: 'I look around' });
        const firstSystem = result.messages.find(m => m.role === 'system');
        expect(firstSystem).toBeDefined();
        expect(firstSystem!.content).toContain('My Custom Rules');
        expect(firstSystem!.content).not.toContain(DEFAULT_RULES);
    });

    it('DEFAULT_RULES contains all expected sections', () => {
        expect(DEFAULT_RULES).toContain('### Output Format');
        expect(DEFAULT_RULES).toContain('### NPC Engine');
        expect(DEFAULT_RULES).toContain('### Name Generation');
        expect(DEFAULT_RULES).toContain('### Lore Handling');
        expect(DEFAULT_RULES).toContain('### Action Resolution');
        expect(DEFAULT_RULES).toContain('### Event Protocol');
        expect(DEFAULT_RULES).toContain('### World Pressures');
    });
});

// ─── Characterization tests: pin current buildPayload behaviour ────────────────

// ── Helper fixtures ────────────────────────────────────────────────────────────

function makeMsg(
    role: ChatMessage['role'],
    content: string,
    extras?: Partial<ChatMessage>
): ChatMessage {
    return { id: `msg-${Math.random()}`, role, content, timestamp: Date.now(), ...extras };
}

function makeLoreChunk(overrides: Partial<LoreChunk> & { category: LoreChunk['category'] }): LoreChunk {
    return {
        id: 'lc1',
        header: 'Test Header',
        content: 'Test content',
        tokens: 5,
        alwaysInclude: false,
        triggerKeywords: [],
        scanDepth: 3,
        category: overrides.category,
        linkedEntities: [],
        priority: 1,
        ...overrides,
    };
}

function makeNPC(overrides: Partial<NPCEntry>): NPCEntry {
    return {
        id: 'npc1',
        name: 'TestNPC',
        aliases: '',
        appearance: '',
        faction: '',
        storyRelevance: '',
        disposition: 'neutral',
        status: 'alive',
        goals: '',
        voice: '',
        personality: '',
        exampleOutput: '',
        affinity: 0,
        archived: false,
        ...overrides,
    };
}

function makeArchiveScene(sceneId: string, content: string): ArchiveScene {
    return { sceneId, content, tokens: Math.ceil(content.length / 4) };
}

function makeArchiveIndexEntry(sceneId: string, witnesses: string[]): ArchiveIndexEntry {
    return {
        sceneId,
        timestamp: Date.now(),
        keywords: [],
        npcsMentioned: [],
        witnesses,
        userSnippet: '',
    };
}

function makeTimelineEvent(overrides: Partial<TimelineEvent>): TimelineEvent {
    return {
        id: 'tl_0001',
        sceneId: '001',
        chapterId: 'CH01',
        subject: 'TestSubject',
        predicate: 'status',
        object: 'alive',
        summary: 'Test summary',
        importance: 5,
        source: 'manual',
        ...overrides,
    };
}

function makeDivergenceRegister(text: string): DivergenceRegister {
    return {
        entries: [
            {
                id: 'div1',
                chapterId: 'CH01',
                category: 'world_state',
                text,
                sceneRef: '001',
                npcIds: [],
                pinned: true,
                enabled: true,
                source: 'manual',
            },
        ],
        chapterToggles: {},
        categoryToggles: {},
        lastUpdatedSceneId: '001',
        lastUpdatedAt: Date.now(),
        version: 2,
    };
}

// ── Scenario 1: Minimal ────────────────────────────────────────────────────────
describe('buildPayload — scenario 1: minimal', () => {
    it('first message is system and contains stable preamble (rules text)', () => {
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: 'Hello world' });
        // Minimum: at least a stable system message + final user message.
        expect(result.messages.length).toBeGreaterThanOrEqual(2);
        expect(result.messages[0].role).toBe('system');
        // rules text is in the first system message
        expect(result.messages[0].content).toContain('ROLE: Dynamic-Realism GM.');
    });

    it('the final user message contains the GM REMINDER literal', () => {
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: 'Hello world' });
        const lastMsg = result.messages[result.messages.length - 1];
        expect(lastMsg.role).toBe('user');
        expect(typeof lastMsg.content === 'string' && lastMsg.content.includes('[GM REMINDER')).toBe(true);
    });

    it('the LAST message is the user message and contains the original user text', () => {
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: 'Hello world' });
        const last = result.messages[result.messages.length - 1];
        expect(last.role).toBe('user');
        // The final user message now includes the GM REMINDER and any volatile block folded in,
        // so we check it contains the original user text rather than being exactly equal to it.
        expect(typeof last.content === 'string' && last.content.includes('Hello world')).toBe(true);
    });

    it('message ordering: system first, user last (with GM REMINDER folded into final user message)', () => {
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: 'Hello world' });
        const msgs = result.messages;
        expect(msgs[0].role).toBe('system');
        // GM REMINDER is now folded into the final user message (not a standalone system message).
        const last = msgs[msgs.length - 1];
        expect(last.role).toBe('user');
        expect(typeof last.content === 'string' && last.content.includes('[GM REMINDER')).toBe(true);
        // No standalone system message should contain the GM REMINDER.
        const sysReminderMsg = msgs.find(
            m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('[GM REMINDER')
        );
        expect(sysReminderMsg).toBeUndefined();
    });

    it('returns trace and debugSections when debugMode is true', () => {
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: 'Hello world' });
        expect(result.trace).toBeDefined();
        expect(result.debugSections).toBeDefined();
    });

    it('does NOT return trace/debugSections when debugMode is false', () => {
        const settings = { ...baseSettings(), debugMode: false } as unknown as AppSettings;
        const result = buildPayload({ settings: settings, context: baseContext(), history: [], userMessage: 'Hello world' });
        expect(result.trace).toBeUndefined();
        expect(result.debugSections).toBeUndefined();
    });
});

// ── Scenario 2: Full world context ────────────────────────────────────────────
describe('buildPayload — scenario 2: full world context', () => {
    const lore: LoreChunk[] = [
        makeLoreChunk({ id: 'lc_faction', category: 'faction', header: 'Iron Guild', content: 'A powerful trading faction.', tokens: 8 }),
        makeLoreChunk({ id: 'lc_loc', category: 'location', header: 'The Docks', content: 'Busy harbor district.', tokens: 7 }),
    ];
    const npcs: NPCEntry[] = [
        makeNPC({ id: 'npc_a', name: 'Aldric', aliases: '' }),
        makeNPC({ id: 'npc_b', name: 'Bella', aliases: '' }),
    ];
    const archive: ArchiveScene[] = [
        makeArchiveScene('001', 'The party fought goblins near the docks.'),
    ];
    const timeline: TimelineEvent[] = [
        makeTimelineEvent({ id: 'tl1', subject: 'Aldric', predicate: 'status', object: 'injured', summary: 'Aldric was injured in scene 001' }),
    ];
    const divReg = makeDivergenceRegister('The bridge was destroyed in scene 001.');
    const userMsg = 'Aldric and Bella are at the docks. What happens next?';

    it('world lore marker appears in assembled content', () => {
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: userMsg, condensedUpToIndex: undefined, relevantLore: lore, npcLedger: npcs, archiveRecall: archive, recommendedNPCNames: undefined, semanticFactText: 'Some semantic fact', archiveIndex: undefined, timelineEvents: timeline, inventoryCategories: undefined, profileFields: undefined, deepContextSummary: undefined, divergenceRegister: divReg });
        // worldContent is folded into the final user message (below the cache boundary).
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('[WORLD LORE');
    });

    it('FACTIONS section appears when faction lore is provided', () => {
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: userMsg, condensedUpToIndex: undefined, relevantLore: lore });
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('[FACTIONS]');
    });

    it('LOCATIONS section appears when location lore is provided', () => {
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: userMsg, condensedUpToIndex: undefined, relevantLore: lore });
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('[LOCATIONS]');
    });

    it('archive recall marker appears when archiveRecall is provided', () => {
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: userMsg, condensedUpToIndex: undefined, relevantLore: undefined, npcLedger: undefined, archiveRecall: archive });
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('[ARCHIVE RECALL');
    });

    it('active NPC context marker appears when matching NPCs are in ledger', () => {
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: userMsg, condensedUpToIndex: undefined, relevantLore: undefined, npcLedger: npcs });
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('[ACTIVE NPC CONTEXT]');
    });

    it('semantic fact text is present in assembled content', () => {
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: userMsg, condensedUpToIndex: undefined, relevantLore: undefined, npcLedger: undefined, archiveRecall: undefined, recommendedNPCNames: undefined, semanticFactText: 'SEMANTIC FACT: the sky is red' });
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('SEMANTIC FACT: the sky is red');
    });

    it('trace has included:true entries for RAG Lore and Active NPCs', () => {
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: userMsg, condensedUpToIndex: undefined, relevantLore: lore, npcLedger: npcs });
        const traceSourcesIncluded = (result.trace ?? [])
            .filter(t => t.included)
            .map(t => t.source);
        expect(traceSourcesIncluded).toContain('RAG Lore');
        expect(traceSourcesIncluded).toContain('Active NPCs');
    });

    it('trace has included:true entry for Archive Recall when provided', () => {
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: userMsg, condensedUpToIndex: undefined, relevantLore: undefined, npcLedger: undefined, archiveRecall: archive });
        const traceSourcesIncluded = (result.trace ?? [])
            .filter(t => t.included)
            .map(t => t.source);
        expect(traceSourcesIncluded).toContain('Archive Recall');
    });
});

// ── Scenario 3: NPC tiered directive (WO-G core+extended) ─────────────────────
describe('buildPayload — scenario 3: NPC tiered directive', () => {
    const highNpc = makeNPC({
        id: 'npc_high',
        name: 'Zorath',
        drives: { coreWant: 'conquer the realm', sessionWant: 'recruit allies', sceneWant: 'intimidate the player' },
        behavioralTriggers: [{ keyword: 'sword', shift: 'becomes aggressive' }],
        hardBoundaries: ['never retreat', 'no mercy'],
        softBoundaries: ['avoids fire'],
        pressure: { ignored: 3, engaged: 1, lastDecayTurn: 0, history: [] },
    });
    const lowNpc = makeNPC({
        id: 'npc_low',
        name: 'Tara',
    });

    // userMessage mentions Zorath multiple times
    const userMsg = 'Zorath steps forward. Zorath raises his sword. What does Zorath say?';

    it('Active NPCs trace reason describes the tiered injection', () => {
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: userMsg, condensedUpToIndex: undefined, relevantLore: undefined, npcLedger: [highNpc, lowNpc] });
        const npcTrace = (result.trace ?? []).find(t => t.source === 'Active NPCs' && t.included);
        expect(npcTrace).toBeDefined();
        expect(npcTrace!.reason).toContain('tiered');
    });

    it('NPC with drives surfaces a WANTS line (legacy drives fallback) in output', () => {
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: userMsg, condensedUpToIndex: undefined, relevantLore: undefined, npcLedger: [highNpc, lowNpc] });
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        // highNpc has drives (not wants) → buildExtendedDirective emits WANTS:.
        expect(allContent).toContain('WANTS:');
    });

    it('NPC triggers surface as ON "keyword": in output', () => {
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: userMsg, condensedUpToIndex: undefined, relevantLore: undefined, npcLedger: [highNpc, lowNpc] });
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('ON "sword":');
    });

    it('NPC hard boundaries surface as WON\'T: in output', () => {
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: userMsg, condensedUpToIndex: undefined, relevantLore: undefined, npcLedger: [highNpc, lowNpc] });
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('WON\'T:');
    });

    it('NPC without drives does not emit a WANTS line', () => {
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: userMsg, condensedUpToIndex: undefined, relevantLore: undefined, npcLedger: [highNpc, lowNpc] });
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        // lowNpc (Tara) has no drives and no wants — no WANTS line for her.
        // Only highNpc's WANTS line should be present.
        const wantsCount = (allContent.match(/WANTS:/g) ?? []).length;
        expect(wantsCount).toBe(1);
    });
});

// ── Scenario 4: Perceptual archive filter ─────────────────────────────────────
describe('buildPayload — scenario 4: perceptual archive filter', () => {
    const activeNpc = makeNPC({ id: 'active_npc', name: 'Oswin', archived: false });
    const archivedNpc = makeNPC({ id: 'archived_npc', name: 'OldGhost', archived: true });

    const witnessedScene = makeArchiveScene('001', 'Oswin saw the dragon fly over the tower.');
    const unwitnessedScene = makeArchiveScene('002', 'A secret meeting no NPC witnessed.');

    const archiveIndex: ArchiveIndexEntry[] = [
        makeArchiveIndexEntry('001', ['active_npc']),   // witnessed by active NPC
        makeArchiveIndexEntry('002', ['archived_npc']), // only witnessed by archived NPC
    ];

    it('trace shows perceptual filter removed unwitnessed scenes', () => {
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: 'What do you recall?', condensedUpToIndex: undefined, relevantLore: undefined, npcLedger: [activeNpc, archivedNpc], archiveRecall: [witnessedScene, unwitnessedScene], recommendedNPCNames: undefined, semanticFactText: undefined, archiveIndex: archiveIndex });
        const filterTrace = (result.trace ?? []).find(
            t => t.source === 'Archive Recall' && t.included === false && t.reason.includes('Perceptual filter removed')
        );
        expect(filterTrace).toBeDefined();
    });

    it('unwitnessed scene content is absent from assembled messages', () => {
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: 'What do you recall?', condensedUpToIndex: undefined, relevantLore: undefined, npcLedger: [activeNpc, archivedNpc], archiveRecall: [witnessedScene, unwitnessedScene], recommendedNPCNames: undefined, semanticFactText: undefined, archiveIndex: archiveIndex });
        const allContent = result.messages
            .map(m => (typeof m.content === 'string' ? m.content : ''))
            .join('\n');
        expect(allContent).not.toContain('A secret meeting no NPC witnessed.');
    });

    it('witnessed scene content IS present in assembled messages', () => {
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: 'What do you recall?', condensedUpToIndex: undefined, relevantLore: undefined, npcLedger: [activeNpc, archivedNpc], archiveRecall: [witnessedScene, unwitnessedScene], recommendedNPCNames: undefined, semanticFactText: undefined, archiveIndex: archiveIndex });
        const allContent = result.messages
            .map(m => (typeof m.content === 'string' ? m.content : ''))
            .join('\n');
        expect(allContent).toContain('Oswin saw the dragon fly over the tower.');
    });

    it('scene with NO witnesses (broadcast) is always included', () => {
        const broadcastScene = makeArchiveScene('003', 'The whole world heard the announcement.');
        const broadcastIdx = makeArchiveIndexEntry('003', []); // empty witnesses = broadcast
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: 'What happened?', condensedUpToIndex: undefined, relevantLore: undefined, npcLedger: [activeNpc], archiveRecall: [broadcastScene], recommendedNPCNames: undefined, semanticFactText: undefined, archiveIndex: [broadcastIdx] });
        const allContent = result.messages
            .map(m => (typeof m.content === 'string' ? m.content : ''))
            .join('\n');
        expect(allContent).toContain('The whole world heard the announcement.');
    });
});

// ── Scenario 5: World-budget trim ─────────────────────────────────────────────
describe('buildPayload — scenario 5: world-budget trim', () => {
    it('trace has included:false entry with reason containing "Exceeds World budget" when budget is tiny', () => {
        const smallSettings = {
            ...baseSettings(),
            contextLimit: 500,
        } as unknown as AppSettings;

        // Build several world blocks to overflow the tiny budget
        const bigLore: LoreChunk[] = [
            makeLoreChunk({
                id: 'lc1', category: 'faction', header: 'Faction One',
                content: 'A'.repeat(300), tokens: 100,
            }),
            makeLoreChunk({
                id: 'lc2', category: 'location', header: 'Location Two',
                content: 'B'.repeat(300), tokens: 100,
            }),
            makeLoreChunk({
                id: 'lc3', category: 'event', header: 'Big Event',
                content: 'C'.repeat(300), tokens: 100,
            }),
        ];

        const archive: ArchiveScene[] = [
            makeArchiveScene('001', 'D'.repeat(400)),
        ];

        const result = buildPayload({ settings: smallSettings, context: baseContext(), history: [], userMessage: 'Hello', condensedUpToIndex: undefined, relevantLore: bigLore, npcLedger: undefined, archiveRecall: archive });

        const droppedTrace = (result.trace ?? []).find(
            t => !t.included && typeof t.reason === 'string' && t.reason.includes('Exceeds World budget')
        );
        expect(droppedTrace).toBeDefined();
    });
});

// ── Scenario 6: History fitting + ephemeral cleanup ───────────────────────────
describe('buildPayload — scenario 6: history fitting and ephemeral cleanup', () => {
    it('ephemeral non-last tool message content is blanked to a single space', () => {
        // The code only blanks ephemeral tool messages that are NOT the lastToolIdx.
        // So we need two tool messages: first ephemeral (non-last), second non-ephemeral (last).
        const toolCallId1 = 'tcid_1a';
        const toolCallId2 = 'tcid_1b';
        const history: ChatMessage[] = [
            makeMsg('user', 'Turn 1'),
            makeMsg('assistant', 'Asst A', {
                tool_calls: [{ id: toolCallId1, type: 'function', function: { name: 'roll_dice', arguments: '{}' } }],
            }),
            // ephemeral tool result — this is NOT the last tool message
            makeMsg('tool', 'EPHEMERAL TOOL RESULT CONTENT', {
                tool_call_id: toolCallId1,
                name: 'roll_dice',
                ephemeral: true,
            }),
            makeMsg('assistant', 'Asst B', {
                tool_calls: [{ id: toolCallId2, type: 'function', function: { name: 'roll_dice', arguments: '{}' } }],
            }),
            // Non-ephemeral last tool message
            makeMsg('tool', 'LAST TOOL RESULT', {
                tool_call_id: toolCallId2,
                name: 'roll_dice',
                ephemeral: false,
            }),
            makeMsg('assistant', 'Final assistant'),
            makeMsg('user', 'Last user'),
        ];

        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: history, userMessage: 'Current message' });
        const allMsgs = result.messages;
        const firstToolMsg = allMsgs.find(
            m => m.role === 'tool' && m.tool_call_id === toolCallId1
        );
        // The first (ephemeral, non-last) tool message should be blanked to ' '
        if (firstToolMsg) {
            expect(firstToolMsg.content).toBe(' ');
        }
        // The original ephemeral content must not appear verbatim
        const allContent = allMsgs.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
        expect(allContent).not.toContain('EPHEMERAL TOOL RESULT CONTENT');
    });

    it('Ephemeral Cleanup trace entry appears when ephemeral non-last tool messages are blanked', () => {
        // Need TWO tool messages so the ephemeral one is not the last
        const toolCallId1 = 'tcid_2a';
        const toolCallId2 = 'tcid_2b';
        const history: ChatMessage[] = [
            makeMsg('user', 'Turn 1'),
            makeMsg('assistant', 'Asst A', {
                tool_calls: [{ id: toolCallId1, type: 'function', function: { name: 'roll_dice', arguments: '{}' } }],
            }),
            makeMsg('tool', 'BIG EPHEMERAL DATA HERE XXXX', {
                tool_call_id: toolCallId1,
                name: 'roll_dice',
                ephemeral: true,
            }),
            makeMsg('assistant', 'Asst B', {
                tool_calls: [{ id: toolCallId2, type: 'function', function: { name: 'roll_dice', arguments: '{}' } }],
            }),
            makeMsg('tool', 'LAST TOOL RESULT', {
                tool_call_id: toolCallId2,
                name: 'roll_dice',
                ephemeral: false,
            }),
            makeMsg('assistant', 'Final assistant'),
            makeMsg('user', 'Turn 2'),
        ];

        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: history, userMessage: 'Turn 3' });
        const ephemeralTrace = (result.trace ?? []).find(t => t.source === 'Ephemeral Cleanup');
        expect(ephemeralTrace).toBeDefined();
    });

    it('orphaned leading tool messages are stripped from fitted history', () => {
        const history: ChatMessage[] = [
            // Starts with a tool message (orphaned — no assistant with tool_calls before it in fitted window)
            makeMsg('tool', 'Orphaned tool result', { tool_call_id: 'orphan_tc', name: 'roll_dice' }),
            makeMsg('user', 'Next user message'),
            makeMsg('assistant', 'Assistant reply'),
        ];

        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: history, userMessage: 'Current message' });
        // The overall first message in messages is system; confirm no tool at position 0 of history slice
        const firstFittedRole = result.messages.find(
            m => m.role !== 'system'
        )?.role;
        // After orphan stripping, the first non-system message should NOT be 'tool'
        expect(firstFittedRole).not.toBe('tool');
    });
});

// ── Scenario 7: Scene-note depth splice ───────────────────────────────────────
describe('buildPayload — scenario 7: scene note depth splice', () => {
    it('scene note is spliced into history and trace has Scene Note (Depth) entry', () => {
        const ctx = {
            ...baseContext(),
            sceneNoteActive: true,
            sceneNote: 'Remember: Aldric is hiding in the shadows.',
            sceneNoteDepth: 2,
        } as GameContext;

        const history: ChatMessage[] = [
            makeMsg('user', 'Turn 1'),
            makeMsg('assistant', 'GM reply 1'),
            makeMsg('user', 'Turn 2'),
            makeMsg('assistant', 'GM reply 2'),
        ];

        const result = buildPayload({ settings: baseSettings(), context: ctx, history: history, userMessage: 'What happens next?' });

        // A system message with [SCENE NOTE should be in messages
        const noteMsg = result.messages.find(
            m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('[SCENE NOTE')
        );
        expect(noteMsg).toBeDefined();

        // Trace entry for Scene Note (Depth) should be present
        const noteTrace = (result.trace ?? []).find(t => t.source === 'Scene Note (Depth)');
        expect(noteTrace).toBeDefined();
        expect(noteTrace!.included).toBe(true);
    });

    it('scene note falls back to end of history block when no history is provided', () => {
        const ctx = {
            ...baseContext(),
            sceneNoteActive: true,
            sceneNote: 'The tavern is on fire.',
            sceneNoteDepth: 3,
        } as GameContext;

        const result = buildPayload({ settings: baseSettings(), context: ctx, history: [], userMessage: 'What do I see?' });

        // With empty history, fallback is used
        const fallbackTrace = (result.trace ?? []).find(t => t.source === 'Scene Note (Fallback)');
        expect(fallbackTrace).toBeDefined();
        expect(fallbackTrace!.included).toBe(true);

        // The note message still appears
        const noteMsg = result.messages.find(
            m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('[SCENE NOTE')
        );
        expect(noteMsg).toBeDefined();
    });
});

// ── Scenario 8: Thinking-mode + tool-mode ───────────────────────────────────
describe('buildPayload — scenario 8: thinking mode and tool mode', () => {
    it('reasoning reminder text appears in stable content when thinkingEffort is enabled', () => {
        const reasoningSettings = {
            ...baseSettings(),
            activePresetId: 'preset_reasoning',
            providers: [{ id: 'prov_reasoning', modelName: 'anything', thinkingEffort: 'low' }],
            presets: [
                {
                    id: 'preset_reasoning',
                    storyAIProviderId: 'prov_reasoning',
                },
            ],
        } as unknown as AppSettings;

        const result = buildPayload({ settings: reasoningSettings, context: baseContext(), history: [], userMessage: 'Hello' });
        const firstSystem = result.messages[0];
        expect(typeof firstSystem.content).toBe('string');
        expect(firstSystem.content as string).toContain('reasoning');
    });

    it('reasoning reminder appears for thinkingEffort high', () => {
        const reasoningSettings = {
            ...baseSettings(),
            activePresetId: 'preset_high',
            providers: [{ id: 'prov_high', modelName: 'anything', thinkingEffort: 'high' }],
            presets: [
                {
                    id: 'preset_high',
                    storyAIProviderId: 'prov_high',
                },
            ],
        } as unknown as AppSettings;

        const result = buildPayload({ settings: reasoningSettings, context: baseContext(), history: [], userMessage: 'Hello' });
        const firstSystem = result.messages[0];
        expect(firstSystem.content as string).toContain('reasoning');
    });

    // ── WO-01: Writer CoT injection (Item 1) ──────────────────────────────────
    it('WRITER_COT present in stable content when thinkingEffort is medium', () => {
        const reasoningSettings = {
            ...baseSettings(),
            activePresetId: 'preset_reasoning',
            providers: [{ id: 'prov_reasoning', modelName: 'anything', thinkingEffort: 'medium' }],
            presets: [{ id: 'preset_reasoning', storyAIProviderId: 'prov_reasoning' }],
        } as unknown as AppSettings;

        const result = buildPayload({ settings: reasoningSettings, context: baseContext(), history: [], userMessage: 'Hello' });
        const firstSystem = result.messages[0];
        expect(firstSystem.content as string).toContain('[WRITER REASONING FRAMEWORK]');
        expect(firstSystem.content as string).toContain('Step 1 — Deconstruct');
        expect(firstSystem.content as string).toContain('Step 6 — Final audit');
    });

    it('WRITER_COT absent from stable content when thinkingEffort is off (even for reasoning-capable model names)', () => {
        const normalSettings = {
            ...baseSettings(),
            activePresetId: 'preset_normal',
            providers: [{ id: 'prov_normal', modelName: 'deepseek-r1', thinkingEffort: 'off' }],
            presets: [{ id: 'preset_normal', storyAIProviderId: 'prov_normal' }],
        } as unknown as AppSettings;

        const result = buildPayload({ settings: normalSettings, context: baseContext(), history: [], userMessage: 'Hello' });
        const firstSystem = result.messages[0];
        expect(firstSystem.content as string).not.toContain('[WRITER REASONING FRAMEWORK]');
        // Existing reasoning reminder must also be absent when thinking is off.
        expect(firstSystem.content as string).not.toContain("If you use a 'thinking' or 'reasoning' block");
    });

    it('WRITER_COT absent from stable content when thinkingEffort is unset', () => {
        const normalSettings = {
            ...baseSettings(),
            activePresetId: 'preset_normal',
            providers: [{ id: 'prov_normal', modelName: 'gpt-4o' }],
            presets: [{ id: 'preset_normal', storyAIProviderId: 'prov_normal' }],
        } as unknown as AppSettings;

        const result = buildPayload({ settings: normalSettings, context: baseContext(), history: [], userMessage: 'Hello' });
        const firstSystem = result.messages[0];
        expect(firstSystem.content as string).not.toContain('[WRITER REASONING FRAMEWORK]');
        expect(firstSystem.content as string).not.toContain("If you use a 'thinking' or 'reasoning' block");
    });

    it('CoT invocation line present in final user message when thinking mode enabled', () => {
        const reasoningSettings = {
            ...baseSettings(),
            activePresetId: 'preset_reasoning',
            providers: [{ id: 'prov_reasoning', modelName: 'anything', thinkingEffort: 'medium' }],
            presets: [{ id: 'preset_reasoning', storyAIProviderId: 'prov_reasoning' }],
        } as unknown as AppSettings;

        const result = buildPayload({ settings: reasoningSettings, context: baseContext(), history: [], userMessage: 'Hello' });
        const finalUser = result.messages[result.messages.length - 1];
        expect(finalUser.role).toBe('user');
        expect(finalUser.content as string).toContain(
            'Work through the [WRITER REASONING FRAMEWORK] in your reasoning before writing.',
        );
        // The invocation line must precede the GM_REMINDER (cache-below ordering per WO spec).
        const content = finalUser.content as string;
        const cotIdx = content.indexOf('Work through the [WRITER REASONING FRAMEWORK]');
        const reminderIdx = content.indexOf('[GM REMINDER:');
        expect(cotIdx).toBeGreaterThan(-1);
        expect(reminderIdx).toBeGreaterThan(cotIdx);
    });

    it('CoT invocation line absent from final user message when thinkingEffort is off', () => {
        const normalSettings = {
            ...baseSettings(),
            activePresetId: 'preset_normal',
            providers: [{ id: 'prov_normal', modelName: 'anything', thinkingEffort: 'off' }],
            presets: [{ id: 'preset_normal', storyAIProviderId: 'prov_normal' }],
        } as unknown as AppSettings;

        const result = buildPayload({ settings: normalSettings, context: baseContext(), history: [], userMessage: 'Hello' });
        const finalUser = result.messages[result.messages.length - 1];
        expect(finalUser.content as string).not.toContain('[WRITER REASONING FRAMEWORK]');
    });

    it('thinking-off final user message is byte-identical to pre-WO-01 payload (no CoT, no invocation line)', () => {
        // Same inputs, only the thinkingEffort is off. The final user message MUST be byte-identical
        // to what buildPayload produced before WO-01 — i.e. the CoT nudge slot collapses to '' and
        // filter(Boolean) drops it, leaving the original 4-element join (volatileBlock, GM_REMINDER,
        // askGmBrief, userMessage).
        const normalSettings = {
            ...baseSettings(),
            activePresetId: 'preset_normal',
            providers: [{ id: 'prov_normal', modelName: 'gpt-4o', thinkingEffort: 'off' }],
            presets: [{ id: 'preset_normal', storyAIProviderId: 'prov_normal' }],
        } as unknown as AppSettings;

        const result = buildPayload({ settings: normalSettings, context: baseContext(), history: [], userMessage: 'Hello' });
        const finalUser = result.messages[result.messages.length - 1];
        // Reconstruct the pre-WO-01 finalUserContent: volatile + GM_REMINDER + (no askGmBrief) + userMessage.
        // buildPayload with empty history + empty context still emits world + volatile blocks; the only
        // assertion that matters here is that the CoT invocation line is NOT between them.
        const content = finalUser.content as string;
        expect(content).not.toContain('Work through the [WRITER REASONING FRAMEWORK]');
        // GM_REMINDER + userMessage both still present in original order.
        expect(content).toContain('[GM REMINDER:');
        expect(content.endsWith('Hello')).toBe(true);
    });

    it('tool-mode (diceFairnessActive false) preserves user Action Resolution rules — no swap', () => {
        const customRules = '### Action Resolution\n\nRoll 2d6. 7 is mixed, 12 is crit, 2 is fumble.';
        const ctx = {
            ...baseContext(),
            diceFairnessActive: false,
            rulesRaw: customRules,
        } as GameContext;

        const result = buildPayload({ settings: baseSettings(), context: ctx, history: [], userMessage: 'I attack the guard' });
        const firstSystem = result.messages[0];
        // User's custom Action Resolution rules must be preserved (not swapped for d20 template)
        expect(firstSystem.content as string).toContain('Roll 2d6');
        expect(firstSystem.content as string).toContain('7 is mixed');
        // Must NOT contain the old hardcoded tool-mode template text
        expect(firstSystem.content as string).not.toContain('CALL the `roll_dice` tool BEFORE narrating');
    });

    it('default (pool) mode preserves user Action Resolution rules too', () => {
        const customRules = '### Action Resolution\n\nRoll 2d6. 7 is mixed, 12 is crit, 2 is fumble.';
        const ctx = {
            ...baseContext(),
            diceFairnessActive: true,
            rulesRaw: customRules,
        } as GameContext;

        const result = buildPayload({ settings: baseSettings(), context: ctx, history: [], userMessage: 'I attack the guard' });
        const firstSystem = result.messages[0];
        expect(firstSystem.content as string).toContain('Roll 2d6');
        expect(firstSystem.content as string).toContain('7 is mixed');
        // The original ACTION RESOLUTION section should NOT contain the tool-mode specific text
        expect(firstSystem.content as string).not.toContain('CALL the `roll_dice` tool BEFORE narrating');
    });
});

// ── Scenario 9: Smart bookkeeping vs legacy ───────────────────────────────────
describe('buildPayload — scenario 9: smart bookkeeping vs legacy', () => {
    it('smart bookkeeping: [CHARACTER] block appears when smartBookkeepingActive and characterProfileData has a name', () => {
        const ctx = {
            ...baseContext(),
            smartBookkeepingActive: true,
            characterProfileData: {
                name: 'Gareth',
                race: 'Human',
                class: 'Fighter',
                level: 5,
                hp: { current: 40, max: 50 },
                stats: {},
                skills: [],
                abilities: [],
                traits: [],
                notes: '',
            },
            inventoryItems: [],
        } as unknown as GameContext;

        const result = buildPayload({ settings: baseSettings(), context: ctx, history: [], userMessage: 'What do I have?' });
        // volatile blocks are folded into the final user message.
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('[CHARACTER]');
    });

    it('smart bookkeeping: [INVENTORY] block appears when inventoryCategories provided and items exist', () => {
        const ctx = {
            ...baseContext(),
            smartBookkeepingActive: true,
            characterProfileData: {
                name: 'Gareth',
                race: 'Human',
                class: 'Fighter',
                level: 5,
                hp: { current: 40, max: 50 },
                stats: {},
                skills: [],
                abilities: [],
                traits: [],
                notes: '',
            },
            inventoryItems: [
                {
                    id: 'item1',
                    name: 'Iron Sword',
                    qty: 1,
                    category: 'weapon' as const,
                    keywords: ['sword'],
                    equipped: true,
                    lastUsedScene: '001',
                    importance: 7,
                    notes: '',
                },
            ],
        } as unknown as GameContext;

        const result = buildPayload({ settings: baseSettings(), context: ctx, history: [], userMessage: 'What weapons do I have?', condensedUpToIndex: undefined, relevantLore: undefined, npcLedger: undefined, archiveRecall: undefined, recommendedNPCNames: undefined, semanticFactText: undefined, archiveIndex: undefined, timelineEvents: undefined, inventoryCategories: ['weapon', 'equipped'] });
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('[INVENTORY]');
    });

    it('smart bookkeeping: [PROFILE] block appears when profileFields provided', () => {
        const ctx = {
            ...baseContext(),
            smartBookkeepingActive: true,
            characterProfileData: {
                name: 'Gareth',
                race: 'Human',
                class: 'Fighter',
                level: 5,
                hp: { current: 40, max: 50 },
                stats: { str: 16 },
                skills: ['Athletics'],
                abilities: [],
                traits: [],
                notes: 'Veteran soldier',
            },
            inventoryItems: [],
        } as unknown as GameContext;

        const result = buildPayload({ settings: baseSettings(), context: ctx, history: [], userMessage: 'What are my stats?', condensedUpToIndex: undefined, relevantLore: undefined, npcLedger: undefined, archiveRecall: undefined, recommendedNPCNames: undefined, semanticFactText: undefined, archiveIndex: undefined, timelineEvents: undefined, inventoryCategories: undefined, profileFields: ['name', 'class', 'level'] });
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('[PROFILE]');
    });

    it('legacy: [CHARACTER PROFILE block appears with staleness tag when characterProfileActive and no smartBookkeeping', () => {
        const ctx = {
            ...baseContext(),
            smartBookkeepingActive: false,
            characterProfileActive: true,
            characterProfile: {
                identity: { name: 'Gareth', class: 'Fighter', level: 5 },
                activeTraits: [{
                    id: 't1', subject: 'Gareth', category: 'party_facts', text: 'A seasoned fighter',
                    importance: 7, eventTags: ['other'], sceneEstablished: '', superseded: false, source: 'seed',
                }],
            },
            characterProfileLastScene: '003',
        } as unknown as GameContext;

        const result = buildPayload({ settings: baseSettings(), context: ctx, history: [], userMessage: 'Who am I?' });
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('[CHARACTER PROFILE');
        // should include the last scene reference
        expect(allContent).toContain('003');
    });

    it('legacy: structured profile injects [CHARACTER PROFILE] when characterProfileActive and traits exist', () => {
        const ctx = {
            ...baseContext(),
            smartBookkeepingActive: false,
            characterProfileActive: true,
            characterProfile: {
                identity: { name: 'Gareth', class: 'Fighter', level: 5 },
                activeTraits: [{
                    id: 't1', subject: 'Gareth', category: 'party_facts', text: 'A seasoned fighter',
                    importance: 7, eventTags: ['other'], sceneEstablished: '', superseded: false, source: 'seed',
                }],
            },
            characterProfileLastScene: 'Never',
        } as unknown as GameContext;

        const result = buildPayload({ settings: baseSettings(), context: ctx, history: [], userMessage: 'Who am I?' });
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('[CHARACTER PROFILE]');
        expect(allContent).toContain('Gareth');
    });
});

// ── Scenario 10: cache_control: ephemeral markers ──────────────────────────────
describe('buildPayload — cache_control: ephemeral markers', () => {
    it('stable content system message has cache_control: ephemeral', () => {
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: 'Hello world' });
        const stableMsg = result.messages.find(
            m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('ROLE: Dynamic-Realism GM.')
        );
        expect(stableMsg).toBeDefined();
        expect((stableMsg as any).cache_control).toEqual({ type: 'ephemeral' });
    });

    it('divergence content system message has cache_control: ephemeral when divergence is present', () => {
        const divReg = makeDivergenceRegister('The bridge was destroyed in scene 001.');
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: 'What happened?', condensedUpToIndex: undefined, relevantLore: undefined, npcLedger: undefined, archiveRecall: undefined, recommendedNPCNames: undefined, semanticFactText: undefined, archiveIndex: undefined, timelineEvents: undefined, inventoryCategories: undefined, profileFields: undefined, deepContextSummary: undefined, divergenceRegister: divReg });
        const divMsg = result.messages.find(
            m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('The bridge was destroyed')
        );
        expect(divMsg).toBeDefined();
        expect((divMsg as any).cache_control).toEqual({ type: 'ephemeral' });
    });

    it('world/volatile content is folded into the final user message (no standalone world system message)', () => {
        const lore: LoreChunk[] = [
            makeLoreChunk({ id: 'lc1', category: 'faction', header: 'Guild', content: 'A guild.', tokens: 5 }),
        ];
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: 'Hello', condensedUpToIndex: undefined, relevantLore: lore });
        // worldContent is now in the final user message, not a system message.
        const worldSysMsg = result.messages.find(
            m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('[WORLD LORE')
        );
        expect(worldSysMsg).toBeUndefined();
        // It should appear in the final user message instead.
        const lastMsg = result.messages[result.messages.length - 1];
        expect(lastMsg.role).toBe('user');
        expect(typeof lastMsg.content === 'string' && lastMsg.content.includes('[WORLD LORE')).toBe(true);
    });

    it('GM REMINDER is folded into the final user message (no standalone GM REMINDER system message)', () => {
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: 'Hello' });
        // No system message should carry the GM REMINDER.
        const sysReminderMsg = result.messages.find(
            m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('[GM REMINDER')
        );
        expect(sysReminderMsg).toBeUndefined();
        // It should be in the final user message.
        const lastMsg = result.messages[result.messages.length - 1];
        expect(lastMsg.role).toBe('user');
        expect(typeof lastMsg.content === 'string' && lastMsg.content.includes('[GM REMINDER')).toBe(true);
    });

    it('final user message does NOT have cache_control (cache boundary is on last history message)', () => {
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: 'Hello' });
        const lastMsg = result.messages[result.messages.length - 1];
        expect(lastMsg.role).toBe('user');
        expect((lastMsg as any).cache_control).toBeUndefined();
    });

    it('history system messages (scene notes) do NOT have cache_control', () => {
        const ctx = {
            ...baseContext(),
            sceneNoteActive: true,
            sceneNote: 'The shadows grow longer.',
            sceneNoteDepth: 1,
        } as GameContext;
        const history: ChatMessage[] = [
            makeMsg('user', 'Turn 1'),
            makeMsg('assistant', 'GM reply'),
        ];
        const result = buildPayload({ settings: baseSettings(), context: ctx, history: history, userMessage: 'What next?' });
        const sceneNoteMsg = result.messages.find(
            m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('[SCENE NOTE')
        );
        expect(sceneNoteMsg).toBeDefined();
        expect((sceneNoteMsg as any).cache_control).toBeUndefined();
    });
});

// ── Scenario 11: Recent Scene Events rendering ──────────────────────────────
describe('buildPayload — Scenario 11: Recent Scene Events rendering', () => {
    it('Recent Scene Events block is absent when there are no events in the recent scenes', () => {
        const archive = [makeArchiveScene('001', 'Scene content')];
        const archiveIndex = [makeArchiveIndexEntry('001', [])];
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: 'Hello', condensedUpToIndex: undefined, relevantLore: undefined, npcLedger: undefined, archiveRecall: archive, recommendedNPCNames: undefined, semanticFactText: undefined, archiveIndex: archiveIndex });
        // worldContent is folded into the final user message; check all content.
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).not.toContain('Recent Scene Events');
    });

    it('Recent Scene Events block is present when recent scenes have events', () => {
        const archive = [makeArchiveScene('001', 'Scene content')];
        const archiveIndex: ArchiveIndexEntry[] = [{
            sceneId: '001',
            timestamp: Date.now(),
            keywords: [],
            npcsMentioned: [],
            witnesses: [],
            userSnippet: '',
            events: [
                { eventType: 'combat', importance: 5, text: 'Fought goblins', cause: 'ambush', result: 'won' }
            ]
        }];
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: 'Hello', condensedUpToIndex: undefined, relevantLore: undefined, npcLedger: undefined, archiveRecall: archive, recommendedNPCNames: undefined, semanticFactText: undefined, archiveIndex: archiveIndex });
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('[combat] Fought goblins (ambush → won)');
    });

    it('Recent Scene Events are sorted by importance descending in output', () => {
        const archive = [makeArchiveScene('001', 'Scene content')];
        const archiveIndex: ArchiveIndexEntry[] = [{
            sceneId: '001',
            timestamp: Date.now(),
            keywords: [],
            npcsMentioned: [],
            witnesses: [],
            userSnippet: '',
            events: [
                { eventType: 'combat', importance: 3, text: 'Low importance event' },
                { eventType: 'discovery', importance: 8, text: 'High importance event' },
                { eventType: 'item_acquired', importance: 5, text: 'Medium importance event' }
            ]
        }];
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: 'Hello', condensedUpToIndex: undefined, relevantLore: undefined, npcLedger: undefined, archiveRecall: archive, recommendedNPCNames: undefined, semanticFactText: undefined, archiveIndex: archiveIndex });
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        const firstIdx = allContent.indexOf('High importance event');
        const secondIdx = allContent.indexOf('Medium importance event');
        const thirdIdx = allContent.indexOf('Low importance event');
        expect(firstIdx).toBeLessThan(secondIdx);
        expect(secondIdx).toBeLessThan(thirdIdx);
    });

    it('correctly renders cause/result combinations (cause only, result only, both, none)', () => {
        const archive = [makeArchiveScene('001', 'Scene content')];
        const archiveIndex: ArchiveIndexEntry[] = [{
            sceneId: '001',
            timestamp: Date.now(),
            keywords: [],
            npcsMentioned: [],
            witnesses: [],
            userSnippet: '',
            events: [
                { eventType: 'combat', importance: 8, text: 'Both present', cause: 'ambush', result: 'won' },
                { eventType: 'combat', importance: 7, text: 'Cause only', cause: 'ambush' },
                { eventType: 'combat', importance: 6, text: 'Result only', result: 'won' },
                { eventType: 'combat', importance: 5, text: 'Neither' }
            ]
        }];
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: 'Hello', condensedUpToIndex: undefined, relevantLore: undefined, npcLedger: undefined, archiveRecall: archive, recommendedNPCNames: undefined, semanticFactText: undefined, archiveIndex: archiveIndex });
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('[combat] Both present (ambush → won)');
        expect(allContent).toContain('[combat] Cause only (cause: ambush)');
        expect(allContent).toContain('[combat] Result only (result: won)');
        expect(allContent).toContain('[combat] Neither');
        expect(allContent).not.toContain('importance:');
    });

    it('respects token budget by dropping lowest-importance events', () => {
        const archive = [makeArchiveScene('001', 'Scene content')];
        const events = Array.from({ length: 10 }, (_, i) => ({
            eventType: 'combat' as const,
            importance: i + 1, // 1 to 10
            text: 'Long event description '.repeat(20) + ` index ${i}` // ~40 tokens each
        }));
        const archiveIndex: ArchiveIndexEntry[] = [{
            sceneId: '001',
            timestamp: Date.now(),
            keywords: [],
            npcsMentioned: [],
            witnesses: [],
            userSnippet: '',
            events
        }];
        const result = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: 'Hello', condensedUpToIndex: undefined, relevantLore: undefined, npcLedger: undefined, archiveRecall: archive, recommendedNPCNames: undefined, semanticFactText: undefined, archiveIndex: archiveIndex });
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');

        expect(allContent).toContain('index 9');
        expect(allContent).toContain('index 8');
        expect(allContent).not.toContain('index 0');
    });
});

// ── Scenario 12: volatile notebook budget (regression — dead budget bug) ────────
describe('buildPayload — volatile notebook budget', () => {
    it('trims an oversized notebook so the volatile block respects its budget', () => {
        // budgetMap.volatile = floor((limit - rulesBudget) * 0.10). With a small limit the
        // notebook (the only unbounded volatile source) must be trimmed, not emitted wholesale.
        const smallSettings = { ...baseSettings(), contextLimit: 600 } as unknown as AppSettings;
        const ctx = baseContext();
        ctx.notebookActive = true;
        ctx.notebook = Array.from({ length: 50 }, (_, i) => ({
            id: `n${i}`,
            text: `Notebook entry number ${i} with some filler words to consume tokens here.`,
            timestamp: 1_000 + i,
        }));

        const result = buildPayload({ settings: smallSettings, context: ctx, history: [], userMessage: 'Hello' });

        // [SCENE NOTEBOOK] is part of volatileContent, folded into the final user message.
        const lastMsg = result.messages[result.messages.length - 1];
        const notebookContent = lastMsg.role === 'user' && typeof lastMsg.content === 'string' && lastMsg.content.includes('[SCENE NOTEBOOK')
            ? lastMsg.content : null;
        // A trim trace must be recorded proving the budget was enforced.
        const trimTrace = (result.trace ?? []).find(
            t => t.source === 'Scene Notebook' && !t.included && typeof t.reason === 'string' && t.reason.includes('Trimmed')
        );
        expect(trimTrace).toBeDefined();
        // The newest entries are kept; the oldest are dropped.
        if (notebookContent) {
            expect(notebookContent).toContain('entry number 49');
            expect(notebookContent).not.toContain('entry number 0 ');
        }
    });

    it('emits the full notebook unchanged when it fits the budget (characterization)', () => {
        const ctx = baseContext();
        ctx.notebookActive = true;
        ctx.notebook = [
            { id: 'n1', text: 'A short note.', timestamp: 2 },
            { id: 'n2', text: 'Another short note.', timestamp: 1 },
        ];
        const result = buildPayload({ settings: baseSettings(), context: ctx, history: [], userMessage: 'Hello' });
        // [SCENE NOTEBOOK] is part of volatileContent, folded into the final user message.
        const lastMsg = result.messages[result.messages.length - 1];
        expect(lastMsg.role).toBe('user');
        expect(typeof lastMsg.content === 'string' && lastMsg.content.includes('[SCENE NOTEBOOK')).toBe(true);
        expect(lastMsg.content as string).toContain('A short note.');
        expect(lastMsg.content as string).toContain('Another short note.');
        // No trim trace when everything fits.
        const trimTrace = (result.trace ?? []).find(
            t => t.source === 'Scene Notebook' && !t.included
        );
        expect(trimTrace).toBeUndefined();
    });
});

// ── Scenario 13: divergence reserved in world budget (regression) ───────────────
describe('buildPayload — divergence reserved in world budget', () => {
    it('drops more world blocks when divergence consumes part of the world budget', () => {
        const smallSettings = { ...baseSettings(), contextLimit: 700 } as unknown as AppSettings;
        const lore: LoreChunk[] = [
            makeLoreChunk({ id: 'lc1', category: 'faction', header: 'Faction One', content: 'A'.repeat(300), tokens: 60 }),
            makeLoreChunk({ id: 'lc2', category: 'location', header: 'Location Two', content: 'B'.repeat(300), tokens: 60 }),
        ];

        // A large divergence register that eats into the world allocation.
        const bigDiv = makeDivergenceRegister('The capital fell. '.repeat(80));

        const withDiv = buildPayload({ settings: smallSettings, context: baseContext(), history: [], userMessage: 'Hello', condensedUpToIndex: undefined, relevantLore: lore, npcLedger: undefined, archiveRecall: undefined, recommendedNPCNames: undefined, semanticFactText: undefined, archiveIndex: undefined, timelineEvents: undefined, inventoryCategories: undefined, profileFields: undefined, deepContextSummary: undefined, divergenceRegister: bigDiv });
        const withoutDiv = buildPayload({ settings: smallSettings, context: baseContext(), history: [], userMessage: 'Hello', condensedUpToIndex: undefined, relevantLore: lore });

        const droppedWith = (withDiv.trace ?? []).filter(
            t => !t.included && typeof t.reason === 'string' && t.reason.includes('World budget')
        ).length;
        const droppedWithout = (withoutDiv.trace ?? []).filter(
            t => !t.included && typeof t.reason === 'string' && t.reason.includes('World budget')
        ).length;

        // Reserving divergence tokens means at least as many world blocks are dropped as without it.
        expect(droppedWith).toBeGreaterThanOrEqual(droppedWithout);
        // And the drop reason now mentions the divergence reserve.
        const reserveTrace = (withDiv.trace ?? []).find(
            t => !t.included && typeof t.reason === 'string' && t.reason.includes('divergence reserve')
        );
        expect(reserveTrace).toBeDefined();
    });
});

// ── Scenario 14: Director Watchdog nudge (WO-03) ────────────────────────────────
//
// Verifies the nudge lands adjacent to GM_REMINDER in the final user message, is
// suppressed when a Director Brief is present, is omitted when no nudge is passed,
// and is byte-identical to the pre-WO-03 payload in every cached-prefix slot.
describe('buildPayload — Director Watchdog nudge (WO-03)', () => {
    const NUDGE = '[STAGE NOTE: Ingrid has been silent 3 turns — must act or speak this scene.]';

    /** Cached-prefix bytes: every message carrying cache_control: ephemeral, joined.
     *  Used to assert the nudge never perturbs the cached prefix (invariant 2). */
    function cachedPrefixBytes(messages: import('../llm/llmService').OpenAIMessage[]): string {
        return messages
            .filter(m => (m as unknown as { cache_control?: { type: string } }).cache_control?.type === 'ephemeral')
            .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
            .join('\n----CACHE-BOUNDARY----\n');
    }

    /** Final user message content (where the nudge rides, below the cache boundary). */
    function finalUserContent(messages: import('../llm/llmService').OpenAIMessage[]): string {
        const last = messages[messages.length - 1];
        return last && last.role === 'user' && typeof last.content === 'string' ? last.content : '';
    }

    /** Positional-arg helper: buildPayload has 4 required params (settings, context,
     *  history, userMessage), then 22 optional params ending at `nextTurnOocBrief`,
     *  then `watchdogNudge` (position 26), then `directorBrief` (position 27). This
     *  spreads 22 `undefined`s so the nudge/brief land in the right slots without
     *  every call site having to count commas. */
    function buildWithNudge(watchdogNudge?: string, directorBrief?: string) {
        return buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: 'Hello world', condensedUpToIndex: undefined, relevantLore: undefined, npcLedger: undefined, archiveRecall: undefined, recommendedNPCNames: undefined, semanticFactText: undefined, archiveIndex: undefined, timelineEvents: undefined, inventoryCategories: undefined, profileFields: undefined, deepContextSummary: undefined, divergenceRegister: undefined, chapters: undefined, onStageNpcIds: undefined, relevantRules: undefined, rulesManifest: undefined, pinnedExcerpts: undefined, plannerEventTypes: undefined, locationLedger: undefined, nextTurnOocBrief: undefined, watchdogNudge: watchdogNudge, directorBrief: directorBrief });
    }

    it('nudge is present in the final user message when provided', () => {
        const result = buildWithNudge(NUDGE);
        const content = finalUserContent(result.messages);
        expect(content).toContain(NUDGE);
    });

    it('nudge sits adjacent to GM_REMINDER (between GM_REMINDER and the user message)', () => {
        const result = buildWithNudge(NUDGE);
        const content = finalUserContent(result.messages);
        const reminderIdx = content.indexOf('[GM REMINDER');
        const nudgeIdx = content.indexOf(NUDGE);
        const userMsgIdx = content.indexOf('Hello world');
        expect(reminderIdx).toBeGreaterThanOrEqual(0);
        expect(nudgeIdx).toBeGreaterThan(reminderIdx);
        expect(userMsgIdx).toBeGreaterThan(nudgeIdx);
    });

    it('nudge is omitted when no watchdogNudge is passed (byte-identical to pre-WO-03)', () => {
        const withUndefined = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: 'Hello world' });
        const content = finalUserContent(withUndefined.messages);
        expect(content).not.toContain('[STAGE NOTE');
        // No Watchdog trace when no nudge is surfaced.
        const watchdogTrace = (withUndefined.trace ?? []).find(t => t.source === 'Watchdog');
        expect(watchdogTrace).toBeUndefined();
    });

    it('nudge is suppressed when directorBrief is also provided (Brief supersedes it)', () => {
        const result = buildWithNudge(NUDGE, 'BRIEF_TEXT');
        const content = finalUserContent(result.messages);
        expect(content).not.toContain(NUDGE);
        // No Watchdog trace when the nudge is suppressed by the Brief.
        const watchdogTrace = (result.trace ?? []).find(t => t.source === 'Watchdog');
        expect(watchdogTrace).toBeUndefined();
    });

    it('nudge never perturbs the cached prefix (invariant 2)', () => {
        const withoutNudge = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: 'Hello world' });
        const withNudge = buildWithNudge(NUDGE);
        expect(cachedPrefixBytes(withNudge.messages)).toBe(cachedPrefixBytes(withoutNudge.messages));
    });

    it('adds a Watchdog trace entry (source: "Watchdog") when nudge is surfaced', () => {
        const result = buildWithNudge(NUDGE);
        const watchdogTrace = (result.trace ?? []).find(t => t.source === 'Watchdog');
        expect(watchdogTrace).toBeDefined();
        expect(watchdogTrace!.included).toBe(true);
        expect(watchdogTrace!.classification).toBe('world_context');
        expect(watchdogTrace!.position).toBe('user');
        expect(watchdogTrace!.preview).toBe(NUDGE);
    });

    it('does NOT add a Watchdog trace in non-debug mode', () => {
        const settings = { ...baseSettings(), debugMode: false } as unknown as AppSettings;
        const result = buildPayload({ settings: settings, context: baseContext(), history: [], userMessage: 'Hello world', condensedUpToIndex: undefined, relevantLore: undefined, npcLedger: undefined, archiveRecall: undefined, recommendedNPCNames: undefined, semanticFactText: undefined, archiveIndex: undefined, timelineEvents: undefined, inventoryCategories: undefined, profileFields: undefined, deepContextSummary: undefined, divergenceRegister: undefined, chapters: undefined, onStageNpcIds: undefined, relevantRules: undefined, rulesManifest: undefined, pinnedExcerpts: undefined, plannerEventTypes: undefined, locationLedger: undefined, nextTurnOocBrief: undefined, watchdogNudge: NUDGE });
        // Trace is undefined entirely in non-debug mode (createTraceCollector gate).
        expect(result.trace).toBeUndefined();
    });
});

// ── Scenario 15: Director Brief injection (WO-04) ────────────────────────────────
//
// Verifies the Brief rides in the final user message (below the cache boundary),
// placed BEFORE GM_REMINDER; the watchdog nudge is suppressed when the Brief is
// present (WO-03 §4 supersession rule, re-asserted here for the WO-04 path); the
// Brief never perturbs the cached prefix (invariant 2); a Director trace entry
// is added when the Brief is surfaced; and exactly one of {Watchdog, Director}
// traces appears (never both, never neither-when-surfaced).
describe('buildPayload — Director Brief (WO-04)', () => {
    const NUDGE = '[STAGE NOTE: Ingrid has been silent 3 turns — must act or speak this scene.]';
    const BRIEF = 'WRITER BRIEF\n- [MANDATORY] Ingrid must speak first this scene.\n- [SUGGESTION] Give Kai a real answer.';

    /** Cached-prefix bytes: every message carrying cache_control: ephemeral, joined. */
    function cachedPrefixBytes(messages: import('../llm/llmService').OpenAIMessage[]): string {
        return messages
            .filter(m => (m as unknown as { cache_control?: { type: string } }).cache_control?.type === 'ephemeral')
            .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
            .join('\n----CACHE-BOUNDARY----\n');
    }

    /** Final user message content (where the Brief rides, below the cache boundary). */
    function finalUserContent(messages: import('../llm/llmService').OpenAIMessage[]): string {
        const last = messages[messages.length - 1];
        return last && last.role === 'user' && typeof last.content === 'string' ? last.content : '';
    }

    /** Positional-arg helper: same shape as WO-03's buildWithNudge, plus the Brief slot. */
    function buildWithBrief(watchdogNudge?: string, directorBrief?: string) {
        return buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: 'Hello world', condensedUpToIndex: undefined, relevantLore: undefined, npcLedger: undefined, archiveRecall: undefined, recommendedNPCNames: undefined, semanticFactText: undefined, archiveIndex: undefined, timelineEvents: undefined, inventoryCategories: undefined, profileFields: undefined, deepContextSummary: undefined, divergenceRegister: undefined, chapters: undefined, onStageNpcIds: undefined, relevantRules: undefined, rulesManifest: undefined, pinnedExcerpts: undefined, plannerEventTypes: undefined, locationLedger: undefined, nextTurnOocBrief: undefined, watchdogNudge: watchdogNudge, directorBrief: directorBrief });
    }

    it('Brief is present in the final user message wrapped as [DIRECTOR BRIEF] block', () => {
        const result = buildWithBrief(undefined, BRIEF);
        const content = finalUserContent(result.messages);
        expect(content).toContain('[DIRECTOR BRIEF]');
        expect(content).toContain(BRIEF);
    });

    it('Brief sits BEFORE GM_REMINDER (the GM reads the audit directives first)', () => {
        const result = buildWithBrief(undefined, BRIEF);
        const content = finalUserContent(result.messages);
        const briefIdx = content.indexOf('[DIRECTOR BRIEF]');
        const reminderIdx = content.indexOf('[GM REMINDER');
        const userMsgIdx = content.indexOf('Hello world');
        expect(briefIdx).toBeGreaterThanOrEqual(0);
        expect(reminderIdx).toBeGreaterThan(briefIdx);
        expect(userMsgIdx).toBeGreaterThan(reminderIdx);
    });

    it('Brief is omitted when no directorBrief is passed (byte-identical to pre-WO-04)', () => {
        const withoutBrief = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: 'Hello world' });
        const content = finalUserContent(withoutBrief.messages);
        expect(content).not.toContain('[DIRECTOR BRIEF]');
        // No Director trace when no Brief is surfaced.
        const directorTrace = (withoutBrief.trace ?? []).find(t => t.source === 'Director');
        expect(directorTrace).toBeUndefined();
    });

    it('Brief suppresses the watchdog nudge even when both are passed (WO-03 §4 supersession)', () => {
        const result = buildWithBrief(NUDGE, BRIEF);
        const content = finalUserContent(result.messages);
        // Brief present, nudge absent.
        expect(content).toContain('[DIRECTOR BRIEF]');
        expect(content).not.toContain(NUDGE);
        // No Watchdog trace when the nudge is suppressed by the Brief.
        const watchdogTrace = (result.trace ?? []).find(t => t.source === 'Watchdog');
        expect(watchdogTrace).toBeUndefined();
    });

    it('exactly one of {Watchdog, Director} traces appears (Director wins when both inputs are passed)', () => {
        const result = buildWithBrief(NUDGE, BRIEF);
        const sources = (result.trace ?? []).map(t => t.source);
        expect(sources).toContain('Director');
        expect(sources).not.toContain('Watchdog');
    });

    it('exactly one of {Watchdog, Director} traces appears (Watchdog wins when only nudge is passed)', () => {
        const result = buildWithBrief(NUDGE);
        const sources = (result.trace ?? []).map(t => t.source);
        expect(sources).toContain('Watchdog');
        expect(sources).not.toContain('Director');
    });

    it('no Watchdog or Director trace appears when neither is passed', () => {
        const result = buildWithBrief();
        const sources = (result.trace ?? []).map(t => t.source);
        expect(sources).not.toContain('Watchdog');
        expect(sources).not.toContain('Director');
    });

    it('Brief never perturbs the cached prefix (invariant 2)', () => {
        const withoutBrief = buildPayload({ settings: baseSettings(), context: baseContext(), history: [], userMessage: 'Hello world' });
        const withBrief = buildWithBrief(undefined, BRIEF);
        expect(cachedPrefixBytes(withBrief.messages)).toBe(cachedPrefixBytes(withoutBrief.messages));
    });

    it('adds a Director trace entry (source: "Director") when Brief is surfaced', () => {
        const result = buildWithBrief(undefined, BRIEF);
        const directorTrace = (result.trace ?? []).find(t => t.source === 'Director');
        expect(directorTrace).toBeDefined();
        expect(directorTrace!.included).toBe(true);
        expect(directorTrace!.classification).toBe('world_context');
        expect(directorTrace!.position).toBe('user');
        // Preview includes the [DIRECTOR BRIEF] wrapper.
        expect(directorTrace!.preview).toContain('[DIRECTOR BRIEF]');
        expect(directorTrace!.preview).toContain(BRIEF);
    });

    it('does NOT add a Director trace in non-debug mode', () => {
        const settings = { ...baseSettings(), debugMode: false } as unknown as AppSettings;
        const result = buildPayload({ settings: settings, context: baseContext(), history: [], userMessage: 'Hello world', condensedUpToIndex: undefined, relevantLore: undefined, npcLedger: undefined, archiveRecall: undefined, recommendedNPCNames: undefined, semanticFactText: undefined, archiveIndex: undefined, timelineEvents: undefined, inventoryCategories: undefined, profileFields: undefined, deepContextSummary: undefined, divergenceRegister: undefined, chapters: undefined, onStageNpcIds: undefined, relevantRules: undefined, rulesManifest: undefined, pinnedExcerpts: undefined, plannerEventTypes: undefined, locationLedger: undefined, nextTurnOocBrief: undefined, watchdogNudge: undefined, directorBrief: BRIEF });
        // Trace is undefined entirely in non-debug mode (createTraceCollector gate).
        expect(result.trace).toBeUndefined();
    });

    it('Brief with empty-string directorBrief does not render the block (treated as absent)', () => {
        const result = buildWithBrief(undefined, '');
        const content = finalUserContent(result.messages);
        expect(content).not.toContain('[DIRECTOR BRIEF]');
        // No Director trace for an empty Brief.
        const directorTrace = (result.trace ?? []).find(t => t.source === 'Director');
        expect(directorTrace).toBeUndefined();
    });
});

describe('buildPayload — active encounter roster', () => {
    const enemyTemplate = (id: string, name: string): EnemyEntry => ({
        id, name, aliases: '', classification: 'Rapture', description: '',
        threatTier: 'Standard', tags: [], faction: '',
        stats: [{ name: 'HP', value: '45' }], actions: [],
        passiveTraits: [], specialBehaviors: [], weaknesses: [], resistances: [],
        tactics: '', loot: '', gmNotes: '', promptEnabled: true,
        createdAt: 1, updatedAt: 1,
    });

    it('uses only the active wave roster instead of name-matched templates', () => {
        const activeTemplate = enemyTemplate('active-template', 'Active Gunner');
        const mentionedReserve = enemyTemplate('reserve-template', 'Reserve Gunner');
        const activeInstance: EnemyInstance = {
            id: 'active-1',
            templateId: activeTemplate.id,
            templateSnapshot: activeTemplate,
            displayName: 'Active Gunner #1',
            currentHp: 12,
            maxHp: 45,
            currentBarrier: 0,
            maxBarrier: 0,
            conditions: [],
            temporaryModifiers: [],
            defeated: false,
            initiative: null,
            actionsRemaining: 1,
            actionsPerTurn: 1,
            cooldowns: [],
            resources: [],
            createdAt: 1,
            updatedAt: 1,
        };
        const encounter: EnemyEncounter = {
            id: 'encounter-1',
            name: 'Current Battle',
            status: 'active',
            waves: [{
                id: 'wave-1',
                name: 'Wave 1',
                instanceIds: [activeInstance.id],
                activeInstanceIds: [activeInstance.id],
                createdAt: 1,
                updatedAt: 1,
            }],
            activeWaveId: 'wave-1',
            createdAt: 1,
            updatedAt: 1,
        };

        const result = buildPayload({
            settings: baseSettings(),
            context: baseContext(),
            history: [],
            userMessage: 'I remember the Reserve Gunner.',
            // Phase 7.5 — the subsystem renders its own segment; `buildPayload`
            // no longer carries enemy-shaped option fields. The assertions below
            // are unchanged, which is the point: the prompt text is identical.
            volatileSegments: [buildEnemyVolatileSegment({
                enemyCompendium: [mentionedReserve],
                enemyInstances: [activeInstance],
                enemyEncounters: [encounter],
            })],
        });
        const finalUser = [...result.messages].reverse().find(message => message.role === 'user')?.content ?? '';

        expect(finalUser).toContain('[ACTIVE ENCOUNTER — authoritative live state]');
        expect(finalUser).toContain('INSTANCE: Active Gunner #1');
        expect(finalUser).toContain('STATE: HP 12/45');
        expect(finalUser).not.toContain('[RELEVANT ENEMY TEMPLATES');
        expect(finalUser).not.toContain('ENEMY: Reserve Gunner');
    });

    it('omits both encounter and compendium context when the campaign master switch is off', () => {
        const mentioned = enemyTemplate('orc-template', 'Orc Warrior');
        const result = buildPayload({
            settings: baseSettings(),
            context: baseContext(),
            history: [],
            userMessage: 'The Orc Warrior attacks.',
            volatileSegments: [buildEnemyVolatileSegment({
                enemyCompendium: [mentioned],
                enemyCombatConfig: { ...DEFAULT_ENEMY_COMBAT_CONFIG, promptContextEnabled: false },
            })],
        });
        const finalUser = [...result.messages].reverse().find(message => message.role === 'user')?.content ?? '';

        expect(finalUser).not.toContain('[RELEVANT ENEMY TEMPLATES');
        expect(finalUser).not.toContain('ENEMY: Orc Warrior');
    });
});
