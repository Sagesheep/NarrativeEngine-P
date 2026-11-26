import { afterEach, describe, expect, it, vi } from 'vitest';
import { NPC_INTRO_DEFAULTS, NPC_INTRO_DIE, rollCharacterIntroEngine } from '../charIntroEngine';
import type { GameContext } from '../../../types';

// The roll uses mobile's scale: 1–200 against a DC that starts at 196.
const context = (npcIntroDC?: number) => ({
    npcIntroEngineActive: true,
    npcIntroDC,
    npcIntroConfig: { ...NPC_INTRO_DEFAULTS, characters: [{ name: 'Therese Soll', type: 'wandering' }] },
}) as unknown as GameContext;

const rollOf = (n: number) => (n - 1) / NPC_INTRO_DIE; // Math.random() value that rolls n

afterEach(() => vi.restoreAllMocks());

describe('rollCharacterIntroEngine — the roll', () => {
    it('a roll under the DC introduces no one and lowers the DC', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(rollOf(20));
        expect(await rollCharacterIntroEngine(context(), new Set(), [])).toEqual({ tag: '', newDC: 194 });
    });

    it('a roll at the DC introduces a candidate and resets the DC', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(rollOf(196));
        expect(await rollCharacterIntroEngine(context(), new Set(), [])).toEqual({ tag: '[INTRODUCE CHARACTER: Therese Soll]', newDC: 196 });
    });

    it('a 20 (a d20\'s best roll) introduces no one until the DC has fallen to 20', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(rollOf(20));
        expect((await rollCharacterIntroEngine(context(), new Set(), [])).tag).toBe('');
        expect((await rollCharacterIntroEngine(context(20), new Set(), [])).tag).toBe('[INTRODUCE CHARACTER: Therese Soll]');
    });

    it('skips a candidate already in the ledger', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(rollOf(200));
        expect((await rollCharacterIntroEngine(context(), new Set(['therese soll']), [])).tag).toBe('');
    });
});
