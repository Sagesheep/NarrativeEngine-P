import { describe, it, expect, vi, afterEach } from 'vitest';
import { rollEngines, rollDiceFairness, resolveManualRoll, executeGateRoll, parseDiceExpr } from '../engineRolls';
import {
    DEFAULT_WORLD_WHAT, DEFAULT_WORLD_WHERE,
    DEFAULT_WORLD_WHO, DEFAULT_WORLD_WHY,
} from '../../../store/slices/settingsHelpers';
import type { GameContext, DieType } from '../../../types';

// Behavior lock for the @narrative/engine extraction (Monorepo WO-02).
// Written BEFORE the move; must pass UNCHANGED after it. A constant-value
// Math.random stub is used (not a sequence) so the assertions are immune to
// internal draw-order differences while still locking formats, list wiring,
// DC arithmetic, and tier mapping.

const stubRandom = (v: number) => vi.spyOn(Math, 'random').mockReturnValue(v);

afterEach(() => {
    vi.restoreAllMocks();
});

const ctx = (overrides: Record<string, unknown>): GameContext =>
    ({
        surpriseEngineActive: true,
        encounterEngineActive: true,
        worldEngineActive: true,
        ...overrides,
    }) as unknown as GameContext;

describe('behavior lock: rollEngines', () => {
    it('all three engines trigger with custom tag lists (exact output)', () => {
        stubRandom(0.5);
        const result = rollEngines(ctx({
            surpriseDC: 1, encounterDC: 1, worldEventDC: 1,
            surpriseConfig: { initialDC: 77, dcReduction: 3, types: ['T0', 'T1', 'T2', 'T3'], tones: ['N0', 'N1', 'N2', 'N3'] },
            encounterConfig: { initialDC: 155, dcReduction: 2, types: ['E0', 'E1', 'E2', 'E3'], tones: ['O0', 'O1', 'O2', 'O3'] },
            worldEventConfig: { initialDC: 444, dcReduction: 2, who: ['W0', 'W1', 'W2', 'W3'], what: ['A0', 'A1', 'A2', 'A3'], where: ['R0', 'R1', 'R2', 'R3'], why: ['Y0', 'Y1', 'Y2', 'Y3'] },
        }));
        expect(result.appendToInput).toBe(
            '\n[SURPRISE EVENT: T2 (N2)]' +
            '\n[ENCOUNTER EVENT: E2 (O2)]' +
            '\n[WORLD_EVENT: W2 A2 Y2 R2]'
        );
        expect(result.updatedDCs).toEqual({ surpriseDC: 77, encounterDC: 155, worldEventDC: 444 });
    });

    it('no engine triggers: DCs decrement by default reductions (3/2/2)', () => {
        stubRandom(0);
        const result = rollEngines(ctx({ surpriseDC: 95, encounterDC: 198, worldEventDC: 498 }));
        expect(result.appendToInput).toBe('');
        expect(result.updatedDCs).toEqual({ surpriseDC: 92, encounterDC: 196, worldEventDC: 496 });
    });

    it('world engine uses the app default lists when no custom tags are configured', () => {
        stubRandom(0.5);
        const pick = (list: string[]) => list[Math.floor(0.5 * list.length)];
        const result = rollEngines(ctx({
            surpriseEngineActive: false, encounterEngineActive: false,
            worldEventDC: 1,
        }));
        expect(result.appendToInput).toBe(
            `\n[WORLD_EVENT: ${pick(DEFAULT_WORLD_WHO)} ${pick(DEFAULT_WORLD_WHAT)} ${pick(DEFAULT_WORLD_WHY)} ${pick(DEFAULT_WORLD_WHERE)}]`
        );
    });
});

describe('behavior lock: rollDiceFairness', () => {
    it('legacy d20 pool (no diceSystem) produces the exact 7-category block', () => {
        stubRandom(0.5); // every d20 roll = 11 → 'Success' band
        const result = rollDiceFairness(ctx({
            diceFairnessActive: true,
            diceConfig: { catastrophe: 2, failure: 6, success: 15, triumph: 19, crit: 20 },
        }));
        const pool = 'Disadvantage: Success, Normal: Success, Advantage: Success';
        expect(result).toBe(
            `\n[DICE OUTCOMES: COMBAT=(${pool}) | PERCEPTION=(${pool}) | STEALTH=(${pool}) | SOCIAL=(${pool}) | MOVEMENT=(${pool}) | KNOWLEDGE=(${pool}) | MUNDANE=(Narrative Boon)]`
        );
    });

    it('generalized pool rolls each category die and maps its band', () => {
        stubRandom(0.5); // d10 roll = 6 → 'Mid'
        const result = rollDiceFairness(ctx({
            diceFairnessActive: true,
            diceSystem: {
                dieTypes: [{
                    id: 'd10', name: 'd10', faces: 10,
                    bands: [
                        { id: 'b1', label: 'Low', min: 1, max: 3 },
                        { id: 'b2', label: 'Mid', min: 4, max: 7 },
                        { id: 'b3', label: 'High', min: 8, max: 10 },
                    ],
                }],
                categories: [{ id: 'c1', name: 'Combat', dieTypeId: 'd10' }],
            },
        }));
        expect(result).toBe('\n[DICE OUTCOMES: COMBAT=(6 → Mid)]');
    });

    it('returns empty string when dice fairness is off', () => {
        expect(rollDiceFairness(ctx({ diceFairnessActive: false }))).toBe('');
    });
});

describe('behavior lock: gate rolls and manual rolls', () => {
    const d20: DieType = {
        id: 'd20', name: 'd20', faces: 20,
        bands: [
            { id: 'l1', label: 'Catastrophe', min: 1, max: 2 },
            { id: 'l2', label: 'Failure', min: 3, max: 6 },
            { id: 'l3', label: 'Success', min: 7, max: 15 },
            { id: 'l4', label: 'Triumph', min: 16, max: 19 },
            { id: 'l5', label: 'Narrative Boon', min: 20, max: 20 },
        ],
    };

    it('executeGateRoll: advantage pick_one keeps highest with detail label', () => {
        stubRandom(0.5);
        const r = executeGateRoll(d20, { modifier: 'adv', count: 3, aggregation: 'pick_one' });
        expect(r).toEqual({ value: 11, rolls: [11, 11, 11], detail: '3d20 advantage (highest)' });
    });

    it('executeGateRoll: total_all sums every die', () => {
        stubRandom(0.5);
        const r = executeGateRoll(d20, { modifier: 'none', count: 2, aggregation: 'total_all' });
        expect(r).toEqual({ value: 22, rolls: [11, 11], detail: '2d20 total' });
    });

    it('resolveManualRoll: legacy adv string migrates to a 2-die d20 roll', () => {
        stubRandom(0.5);
        const r = resolveManualRoll('adv', null);
        expect(r).toEqual({ tier: 'Success', faceValue: 11, detail: 'Advantage', rolls: [11, 11] });
    });

    it('parseDiceExpr round-trips 2d6+1 and rejects junk', () => {
        expect(parseDiceExpr('2d6+1')).toEqual({ count: 2, faces: 6, modifier: 1 });
        expect(parseDiceExpr('not dice')).toBeNull();
    });
});
