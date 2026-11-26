/* eslint-disable @typescript-eslint/no-explicit-any */
// Image Gallery recall — orchestrator stage contract.
//
// The load-bearing invariant: an armed recall steers THIS turn only. It is
// appended to `finalInput` (what the model receives) but NOT to `historyInput`
// (what persists in durable chat history), exactly like `armedOneShot`. Without
// that, recalling a costume a dozen times across a campaign leaves a dozen
// copies compounding in every later payload.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveEngineRolls } from '../turnStages';
import { createTurnContext } from '../turnContext';
import type { TurnState, TurnCallbacks } from '../turnOrchestrator';
import type { ArmedGalleryRecall } from '../../../types';

// Neutralise the dice/surprise engines so the assertions see ONLY the gallery's
// contribution to the turn text.
vi.mock('../../engine/engineRolls', () => ({
    rollEngines: () => ({ appendToInput: '', updatedDCs: {} }),
    rollDiceFairness: () => '',
    resolveManualRoll: () => null,
}));

function makeCtx(input = 'I walk into the tavern.') {
    return createTurnContext({ input, displayInput: input, locationLedger: [], npcLedger: [] });
}

function makeState(armedGalleryRecall: ArmedGalleryRecall[] | null): TurnState {
    return {
        input: 'I walk into the tavern.',
        displayInput: 'I walk into the tavern.',
        context: {} as any,
        armedGalleryRecall,
    } as unknown as TurnState;
}

const callbacks = {
    setPipelinePhase: vi.fn(),
    updateContext: vi.fn(),
    setLoadingStatus: vi.fn(),
    addMessage: vi.fn(),
} as unknown as TurnCallbacks;

beforeEach(() => vi.clearAllMocks());

const COSTUME: ArmedGalleryRecall = {
    id: 'g1',
    title: 'Detective coat',
    caption: 'A long oilcloth coat over a grey waistcoat, collar turned up.',
};

describe('gallery recall injection', () => {
    it('hands the caption to the model on this turn', () => {
        const ctx = makeCtx();
        resolveEngineRolls(ctx, makeState([COSTUME]), callbacks);
        expect(ctx.finalInput).toContain('A long oilcloth coat');
        expect(ctx.finalInput).toContain('Detective coat');
    });

    it('does NOT leak into durable chat history', () => {
        const ctx = makeCtx();
        resolveEngineRolls(ctx, makeState([COSTUME]), callbacks);
        expect(ctx.historyInput).not.toContain('oilcloth');
        expect(ctx.historyInput).toBe('I walk into the tavern.');
    });

    it('shows the player a named reveal line', () => {
        const ctx = makeCtx();
        resolveEngineRolls(ctx, makeState([COSTUME]), callbacks);
        expect(ctx.displayInputFinal).toContain('Image recalled');
        expect(ctx.displayInputFinal).toContain('Detective coat');
    });

    it('arms several images at once, each with its own reveal line', () => {
        const ctx = makeCtx();
        const trinket: ArmedGalleryRecall = { id: 'g2', title: 'Weird trinket', caption: 'A brass octopus the size of a thumb.' };
        resolveEngineRolls(ctx, makeState([COSTUME, trinket]), callbacks);
        expect(ctx.finalInput).toContain('oilcloth coat');
        expect(ctx.finalInput).toContain('brass octopus');
        expect(ctx.displayInputFinal).toContain('Detective coat');
        expect(ctx.displayInputFinal).toContain('Weird trinket');
    });

    it('leaves the turn byte-identical when nothing is armed', () => {
        const armed = makeCtx();
        resolveEngineRolls(armed, makeState(null), callbacks);
        expect(armed.finalInput).toBe('I walk into the tavern.');
        expect(armed.displayInputFinal).toBe('I walk into the tavern.');
    });

    it('ignores an entry whose caption is blank rather than emitting an empty block', () => {
        const ctx = makeCtx();
        resolveEngineRolls(ctx, makeState([{ id: 'g3', title: 'Empty', caption: '   ' }]), callbacks);
        expect(ctx.finalInput).toBe('I walk into the tavern.');
        expect(ctx.displayInputFinal).not.toContain('Image recalled');
    });

    it('wraps each caption in a titled IMAGE block the model can attribute', () => {
        const ctx = makeCtx();
        resolveEngineRolls(ctx, makeState([COSTUME]), callbacks);
        expect(ctx.finalInput).toMatch(/\[IMAGE THE PLAYER IS SHOWING YOU — Detective coat\][\s\S]*\[\/IMAGE\]/);
    });
});
