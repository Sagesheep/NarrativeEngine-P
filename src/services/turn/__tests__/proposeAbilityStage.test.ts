import { describe, expect, it, vi, beforeEach } from 'vitest';

type Send = { tools: unknown[] | undefined; onDone: (text: string, toolCall?: { id: string; name: string; arguments: string }) => Promise<void> | void };
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
import { getToolDefinitions, handleProposeAbilityTool } from '../toolHandlers';
import { TOOL_REGISTRY, validateToolRegistry } from '../toolRegistry';
import { isAbilityToolAllowed, parseAbilityArgs } from '../../combat/abilityProposalArgs';
import type { TurnCallbacks, TurnState } from '../turnOrchestrator';
import type { AbilityProposal, ChatMessage } from '../../../types';

const limits = { maxChainLength: 6, maxSummons: 2 };
const fireball = JSON.stringify({ name: 'Ember storm', description: 'A roaring bloom of flame.', damageType: 'fire', form: 'burst', effects: [{ effect: 'damage', augments: [] }] });

function setup(abilityToolAllowed: boolean) {
    const messages: ChatMessage[] = [];
    const staged: Array<Omit<AbilityProposal, 'campaignId'>> = [];
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
        stageAbilityProposal: vi.fn((p: Omit<AbilityProposal, 'campaignId'>) => { staged.push(p); }),
    } as unknown as TurnCallbacks;
    const state = {
        context: { diceFairnessActive: true, notebook: [], combatConfig: { maxChainLength: 6, maxSummons: 2 } },
        loreChunks: [],
        npcLedger: [],
        provider: { endpoint: 'http://x', apiKey: '', modelName: 'm' },
        settings: { debugMode: false },
        getMessages: () => messages,
        activeCampaignId: 'c',
        displayInput: 'I touch the shrine.',
        abilityToolAllowed,
    } as unknown as TurnState;
    const ctx = createTurnContext({ input: 'I touch the shrine.', displayInput: 'I touch the shrine.', locationLedger: [], npcLedger: [] });
    ctx.payload = [{ role: 'user', content: 'x' }];
    return { messages, staged, callbacks, state, ctx };
}

const names = (tools: unknown[] | undefined) => (tools ?? []).map(t => (t as { function: { name: string } }).function.name);

beforeEach(() => { sends.length = 0; });

describe('propose_ability tool (T6)', () => {
    it('is offered only when allowed, and is registered', () => {
        expect(names(getToolDefinitions({ allowDiceTool: false }))).not.toContain('propose_ability');
        expect(names(getToolDefinitions({ allowDiceTool: false, allowAbilityTool: true }))).toContain('propose_ability');
        expect(() => validateToolRegistry()).not.toThrow();
        expect(typeof TOOL_REGISTRY.propose_ability).toBe('function');
        const def = getToolDefinitions({ allowDiceTool: false, allowAbilityTool: true }).find(t => (t as { function: { name: string } }).function.name === 'propose_ability') as { function: { parameters: { properties: Record<string, { type: string }> } } };
        expect(Object.values(def.function.parameters.properties).some(p => p.type === 'number' || p.type === 'integer')).toBe(false);
    });

    it('is allowed only with combat on, a sheet, no fight and no pending proposal', () => {
        const sheet = { abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 }, budget: 'NORMAL' as const, level: 3, needsAllocation: false };
        expect(isAbilityToolAllowed({ combatModeActive: true, combatSheet: sheet }, null, null)).toBe(true);
        expect(isAbilityToolAllowed({ combatModeActive: false, combatSheet: sheet }, null, null)).toBe(false);
        expect(isAbilityToolAllowed({ combatModeActive: true }, null, null)).toBe(false);
        expect(isAbilityToolAllowed({ combatModeActive: true, combatSheet: sheet }, {} as never, null)).toBe(false);
        expect(isAbilityToolAllowed({ combatModeActive: true, combatSheet: sheet }, null, {} as never)).toBe(false);
    });

    it('parses enums leniently and refuses invalid chains with the validator reasons', () => {
        const ok = parseAbilityArgs({ name: 'Frost lance', form: 'Projectile', formAugments: ['pierce'], effects: [{ effect: 'DAMAGE' }, { effect: 'slow', augments: ['extend'] }] }, limits);
        expect(ok).toMatchObject({ ok: true, ability: { name: 'Frost lance', form: { id: 'projectile', augments: ['pierce'] }, effects: [{ id: 'damage', augments: [] }, { id: 'slow', augments: ['extend'] }], source: 'ai' } });
        const bad = parseAbilityArgs({ name: 'Self harm', form: 'self', effects: [{ effect: 'damage' }] }, limits);
        expect(bad).toEqual({ ok: false, reasons: ['the self form cannot carry damage'] });
        const unknown = parseAbilityArgs({ name: 'X', form: 'laser', effects: [{ effect: 'nuke' }] }, limits);
        expect(unknown.ok).toBe(false);
        expect((unknown as { reasons: string[] }).reasons.join(' ')).toMatch(/`form` must be one of.*"nuke" is not an effect/);
        const result = handleProposeAbilityTool(JSON.stringify({ name: 'Self harm', form: 'self', effects: [{ effect: 'damage' }] }), limits);
        expect(result.ability).toBeUndefined();
        expect(result.toolResult).toMatch(/^propose_ability was not accepted: the self form cannot carry damage\./);
    });

    it('refuses built-in-only glyphs and never takes a built-in id (5B-1)', () => {
        const def = getToolDefinitions({ allowDiceTool: false, allowAbilityTool: true }).find(t => (t as { function: { name: string } }).function.name === 'propose_ability') as { function: { parameters: { properties: { effects: { items: { properties: { effect: { enum: string[] } } } } } } } };
        const offered = def.function.parameters.properties.effects.items.properties.effect.enum;
        expect(offered).not.toContain('weapon');
        expect(offered).not.toContain('guard');
        for (const effect of ['sprint', 'leap', 'rally']) expect(offered).not.toContain(effect);
        for (const effect of ['weapon', 'guard', 'sprint', 'leap', 'rally']) {
            const parsed = parseAbilityArgs({ name: 'Cheat', form: effect === 'guard' || effect === 'sprint' || effect === 'leap' ? 'self' : 'touch', effects: [{ effect }] }, limits);
            expect(parsed.ok).toBe(false);
            expect((parsed as { reasons: string[] }).reasons.join(' ')).toContain(`"${effect}" is not an effect`);
            const result = handleProposeAbilityTool(JSON.stringify({ name: 'Cheat', form: 'touch', effects: [{ effect }] }), limits);
            expect(result.ability).toBeUndefined();
            expect(result.toolResult).toMatch(/^propose_ability was not accepted/);
        }
        const posing = parseAbilityArgs({ id: 'builtin:attack', name: 'Attack', form: 'touch', effects: [{ effect: 'damage' }] }, limits);
        expect(posing.ok).toBe(true);
        expect((posing as { ability: { id: string } }).ability.id.startsWith('builtin:')).toBe(false);
    });

    it('does not offer the tool when not allowed', async () => {
        const { callbacks, state, ctx } = setup(false);
        await runGenerationStage(ctx, state, callbacks, new AbortController(), { liveTrace: [], pushToolTrace: vi.fn() });
        expect(names(sends[0].tools)).not.toContain('propose_ability');
    });

    it('stages a valid proposal tied to the GM message, refuses a second one in the same turn, and stages nothing for an invalid one', async () => {
        const { messages, staged, callbacks, state, ctx } = setup(true);
        await runGenerationStage(ctx, state, callbacks, new AbortController(), { liveTrace: [], pushToolTrace: vi.fn() });
        expect(names(sends[0].tools)).toContain('propose_ability');
        await sends[0].onDone('', { id: 'call-1', name: 'propose_ability', arguments: JSON.stringify({ name: 'Bad', form: 'burst', effects: [{ effect: 'swap' }] }) });
        expect(staged).toHaveLength(0);
        expect(messages.filter(m => m.role === 'tool').pop()!.content).toMatch(/not accepted: the burst form cannot carry swap/);
        await sends[sends.length - 1].onDone('', { id: 'call-2', name: 'propose_ability', arguments: fireball });
        const gm = messages.find(m => m.role === 'assistant')!;
        expect(staged).toHaveLength(1);
        expect(staged[0]).toMatchObject({ messageId: gm.id, ability: { name: 'Ember storm', damageType: 'fire', form: { id: 'burst' } } });
        expect(messages.filter(m => m.role === 'tool').pop()!.content).toMatch(/offered to the player/);
        await sends[sends.length - 1].onDone('', { id: 'call-3', name: 'propose_ability', arguments: fireball });
        expect(staged).toHaveLength(1);
        expect(messages.filter(m => m.role === 'tool').pop()!.content).toMatch(/one ability proposal at a time/);
        expect(vi.mocked(callbacks.updateContext)).not.toHaveBeenCalled();
    });
});
