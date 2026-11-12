import { describe, it, expect } from 'vitest';
import { buildHistory, detachTrailingEngineLog } from '../history';
import { buildPayload } from '../payloadBuilder';
import { createTraceCollector } from '../traceCollector';
import { countTokens } from '../../infrastructure/tokenizer';
import { beatHistory } from '../../combat/combatNarration';
import type { AppSettings, ChatMessage, GameContext } from '../../../types';
import type { OpenAIMessage } from '../../llm/llmService';

let n = 0;
const msg = (role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
    ({ id: `m${++n}`, role, content, timestamp: n, ...extra });
const log = (content: string) => msg('system', content, { name: 'combat-log' });
const result = (content: string) => msg('system', content, { name: 'combat-result' });
const beat = (content: string) => msg('assistant', content, { combatBeat: { sessionId: 's', fromSeq: 1, toSeq: 2 } });

function run(history: ChatMessage[]) {
    return buildHistory({
        history,
        userMessage: 'next',
        limit: 100000,
        stableTokens: 0,
        currentWorldTokens: 0,
        volatileTokens: 0,
        context: {} as GameContext,
        collector: createTraceCollector(false),
    });
}

function assertNoEngineRoleRepeats(out: ReturnType<typeof run>) {
    for (let i = 1; i < out.length; i++) {
        if (out[i].role === 'user' || out[i].role === 'assistant') expect(out[i].role).not.toBe(out[i - 1].role);
    }
}

describe('engine log rendering in history', () => {
    it('renders log lines as prefixed user turns without a name: log → beat → log → beat', () => {
        const out = run([msg('user', 'Attack!'), msg('assistant', 'Steel rings.'), log('Kira hits Bandit.'), beat('Kira strikes.'), log('Bandit misses.'), beat('The bandit whiffs.')]);
        expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
        expect(out[2]).toEqual({ role: 'user', content: '[Engine log]\nKira hits Bandit.' });
        expect(out[4].content).toBe('[Engine log]\nBandit misses.');
        expect(out.some(m => m.name)).toBe(false);
        assertNoEngineRoleRepeats(out);
    });

    it('merges adjacent log messages: log → log → beat', () => {
        const out = run([msg('user', 'Go'), msg('assistant', 'They come.'), log('Line 1'), log('Line 2'), beat('Prose.')]);
        expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
        expect(out[2].content).toBe('[Engine log]\nLine 1\n\n[Engine log]\nLine 2');
        assertNoEngineRoleRepeats(out);
    });

    it('folds a result into the next real user message, engine text first: result → normal user turn', () => {
        const out = run([msg('assistant', 'Final beat.', { combatBeat: { sessionId: 's', fromSeq: 1, toSeq: 9 } }), result('Combat ended: victory.'), msg('user', 'I loot the bodies.'), msg('assistant', 'You find coins.')]);
        expect(out.map(m => m.role)).toEqual(['assistant', 'user', 'assistant']);
        expect(out[1].content).toBe('[Engine log]\nCombat ended: victory.\n\nI loot the bodies.');
        assertNoEngineRoleRepeats(out);
    });

    it('merges back-to-back beats', () => {
        const out = run([log('A'), beat('One.'), beat('Two.')]);
        expect(out.map(m => m.role)).toEqual(['user', 'assistant']);
        expect(out[1].content).toBe('One.\n\nTwo.');
    });

    it('detachTrailingEngineLog returns the same history when nothing trails', () => {
        const fitted = run([msg('user', 'a'), msg('assistant', 'b'), msg('user', 'c')]);
        const split = detachTrailingEngineLog(fitted);
        expect(split.history).toBe(fitted);
        expect(split.engineText).toBeNull();
    });

    it('leaves travel system messages and ordinary history untouched', () => {
        const travel = msg('system', 'Day 2 on the road.', { name: 'travel-checkpoint' });
        const out = run([msg('user', 'a'), msg('assistant', 'b'), travel, msg('user', 'c')]);
        expect(out).toEqual([
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
            { role: 'system', content: 'Day 2 on the road.', name: 'travel-checkpoint' },
            { role: 'user', content: 'c' },
        ]);
    });
});

const payloadContext = (over: Partial<GameContext> = {}) => ({
    loreRaw: 'Lore text.', rulesRaw: '', canonState: '', headerIndex: '', starter: '', continuePrompt: '',
    inventory: '', inventoryLastScene: 'Never', characterProfile: '', characterProfileLastScene: 'Never',
    canonStateActive: false, headerIndexActive: false, starterActive: false, continuePromptActive: false,
    inventoryActive: false, characterProfileActive: false, surpriseEngineActive: false, encounterEngineActive: false,
    worldEngineActive: false, diceFairnessActive: false, sceneNote: '', sceneNoteActive: false, sceneNoteDepth: 3,
    worldVibe: '', notebook: [], notebookActive: false,
    worldEventConfig: { initialDC: 498, dcReduction: 2, who: [], where: [], why: [], what: [] },
    ...over,
} as unknown as GameContext);

function payload(history: ChatMessage[], opts: { debug?: boolean; userMessage?: string; engineCombatActive?: boolean; context?: GameContext } = {}) {
    return buildPayload({
        settings: { debugMode: !!opts.debug, contextLimit: 8192 } as unknown as AppSettings,
        context: opts.context ?? payloadContext(),
        history,
        userMessage: opts.userMessage ?? 'I loot the bodies.',
        engineCombatActive: opts.engineCombatActive,
    });
}

const markerIndexes = (messages: OpenAIMessage[]) => messages.flatMap((m, i) => (m.cache_control ? [i] : []));

function assertAlternates(messages: OpenAIMessage[]) {
    for (let i = 1; i < messages.length; i++) {
        if (messages[i].role === 'user' || messages[i].role === 'assistant') expect(messages[i].role).not.toBe(messages[i - 1].role);
    }
}

describe('trailing engine log on the first turn after a fight', () => {
    const fight = () => [msg('user', 'Attack!'), msg('assistant', 'They come.'), log('Kira hits Bandit.'), beat('Kira strikes.')];

    it('moves a trailing result into the final user message, engine text first', () => {
        const withResult = payload([...fight(), result('Combat ended: victory.')]).messages;
        const withoutResult = payload(fight()).messages;
        assertAlternates(withResult);
        const final = withResult[withResult.length - 1];
        const plainFinal = withoutResult[withoutResult.length - 1];
        expect(final.role).toBe('user');
        expect(final.content).toBe(`[Engine log]\nCombat ended: victory.\n\n${plainFinal.content as string}`);
        expect(withResult.slice(0, -1)).toEqual(withoutResult.slice(0, -1));
    });

    it('places cache markers by the same rule: the last remaining history message carries it', () => {
        const messages = payload([...fight(), result('Combat ended: victory.')]).messages;
        const reference = payload(fight()).messages;
        expect(markerIndexes(messages)).toEqual(markerIndexes(reference));
        const lastHistory = messages[messages.length - 2];
        expect(lastHistory.role).toBe('assistant');
        expect(lastHistory.content).toBe('Kira strikes.');
        expect(lastHistory.cache_control).toEqual({ type: 'ephemeral' });
        expect(messages[messages.length - 1].cache_control).toBeUndefined();
    });

    it('moves merged consecutive trailing logs as one block', () => {
        const messages = payload([...fight(), log('Bandit flees.'), result('Combat ended: victory.')]).messages;
        assertAlternates(messages);
        const final = messages[messages.length - 1].content as string;
        expect(final.startsWith('[Engine log]\nBandit flees.\n\n[Engine log]\nCombat ended: victory.\n\n')).toBe(true);
        expect(messages.filter(m => typeof m.content === 'string' && m.content.includes('Bandit flees.'))).toHaveLength(1);
    });

    it('still charges the moved log against the history budget', () => {
        const withResult = payload([...fight(), result('Combat ended: victory.')], { debug: true }).trace ?? [];
        const withoutResult = payload(fight(), { debug: true }).trace ?? [];
        const fittedTokens = (trace: typeof withResult) => trace.find(t => t.source === 'Fitted History')?.tokens ?? 0;
        expect(fittedTokens(withResult) - fittedTokens(withoutResult)).toBe(countTokens('[Engine log]\nCombat ended: victory.'));
    });

    it('leaves payloads without combat messages unchanged, including a history ending on a user message', () => {
        const histories = [
            [msg('user', 'a'), msg('assistant', 'b')],
            [msg('user', 'a'), msg('assistant', 'b'), msg('user', 'dangling')],
            [msg('user', 'a'), msg('assistant', 'b'), msg('system', 'Day 2.', { name: 'travel-checkpoint' })],
        ];
        for (const history of histories) {
            const fitted = run(history);
            const messages = payload(history).messages;
            expect(messages.slice(-1 - fitted.length, -1).map(m => ({ role: m.role, content: m.content }))).toEqual(fitted.map(m => ({ role: m.role, content: m.content })));
            expect((messages[messages.length - 1].content as string).startsWith('[Engine log]')).toBe(false);
            expect(markerIndexes(messages)).toContain(messages.length - 2);
        }
    });

    it('does not re-insert the log on the narration beat path', () => {
        const stored = [...fight(), log('Bandit falls.'), msg('assistant', '', { id: 'beat-next', combatBeat: { sessionId: 's', fromSeq: 3, toSeq: 3 } })];
        const viaBeat = payload(beatHistory(stored, 'beat-next'), { userMessage: 'BLOCK', engineCombatActive: true }).messages;
        const direct = payload(fight(), { userMessage: 'BLOCK', engineCombatActive: true }).messages;
        expect(viaBeat).toEqual(direct);
        expect(viaBeat.some(m => typeof m.content === 'string' && m.content.includes('Bandit falls.'))).toBe(false);
    });
});
