import { describe, expect, it, vi, beforeEach } from 'vitest';

type Send = { tools: unknown[] | undefined; onDone: (text: string, toolCall?: { id: string; name: string; arguments: string }) => void };
const sends: Send[] = [];

vi.mock('../../chatEngine', () => ({
    buildPayload: vi.fn(),
    sendMessage: vi.fn((_p: unknown, _m: unknown, _c: unknown, onDone: Send['onDone'], _e: unknown, tools: unknown[] | undefined) => {
        sends.push({ tools, onDone });
        return Promise.resolve();
    }),
}));

vi.mock('../pendingCommit', () => ({
    capturePendingTurnSnapshot: vi.fn(),
}));

import { runGenerationStage } from '../turnStages';
import { createTurnContext } from '../turnContext';
import type { TurnCallbacks, TurnState } from '../turnOrchestrator';
import type { ChatMessage, CombatProposal } from '../../../types';

function setup(combatToolAllowed: boolean) {
    const messages: ChatMessage[] = [];
    const staged: CombatProposal[] = [];
    const callbacks = {
        onCheckingNotes: vi.fn(),
        addMessage: vi.fn((m: ChatMessage) => { messages.push(m); }),
        updateLastAssistant: vi.fn(),
        updateLastMessage: vi.fn(),
        updateLastAssistantMessage: vi.fn(),
        updateContext: vi.fn(),
        setStreaming: vi.fn(),
        setPipelinePhase: vi.fn(),
        setLoadingStatus: vi.fn(),
        stageCombatProposal: vi.fn((p: CombatProposal) => { staged.push(p); }),
    } as unknown as TurnCallbacks;
    const state = {
        context: { diceFairnessActive: true, notebook: [] },
        loreChunks: [],
        npcLedger: [{ id: 'npc-9', name: 'Mira' }],
        provider: { endpoint: 'http://x', apiKey: '', modelName: 'm' },
        settings: { debugMode: false },
        getMessages: () => messages,
        activeCampaignId: 'c',
        displayInput: 'I draw my sword.',
        combatToolAllowed,
    } as unknown as TurnState;
    const ctx = createTurnContext({ input: 'I draw my sword.', displayInput: 'I draw my sword.', locationLedger: [], npcLedger: [] });
    ctx.payload = [{ role: 'user', content: 'x' }];
    return { messages, staged, callbacks, state, ctx };
}

const names = (tools: unknown[] | undefined) => (tools ?? []).map(t => (t as { function: { name: string } }).function.name);

beforeEach(() => { sends.length = 0; });

describe('Stage 7 and start_combat', () => {
    it('does not offer the tool when combat is not allowed', async () => {
        const { callbacks, state, ctx } = setup(false);
        await runGenerationStage(ctx, state, callbacks, new AbortController(), { liveTrace: [], pushToolTrace: vi.fn() });
        expect(names(sends[0].tools)).not.toContain('start_combat');
    });

    it('offers the tool last and stages a proposal tied to the GM message without touching anything else', async () => {
        const { messages, staged, callbacks, state, ctx } = setup(true);
        await runGenerationStage(ctx, state, callbacks, new AbortController(), { liveTrace: [], pushToolTrace: vi.fn() });
        const tools = names(sends[0].tools);
        expect(tools[tools.length - 1]).toBe('start_combat');
        sends[0].onDone('', { id: 'call-1', name: 'start_combat', arguments: JSON.stringify({ combatants: [{ name: 'Mira', npcName: 'Mira' }], reason: 'Mira attacks' }) });
        const gm = messages.find(m => m.role === 'assistant')!;
        expect(staged).toHaveLength(1);
        expect(staged[0]).toMatchObject({ messageId: gm.id, source: 'tool', reason: 'Mira attacks', combatants: [{ name: 'Mira', npcId: 'npc-9' }] });
        const toolMsg = messages.find(m => m.role === 'tool')!;
        expect(toolMsg.content).toMatch(/^Combat has been proposed to the player/);
        expect(vi.mocked(callbacks.updateContext)).not.toHaveBeenCalled();
    });
});
