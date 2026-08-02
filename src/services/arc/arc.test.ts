import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
    ArcRecord,
    ArcType,
    ArcStance,
    NPCPressure,
    EndpointConfig,
} from '../../types';
import { bandFromMargin } from '../npc/agency/agencyDice';
// WO-P5-12 §7 Step 3 — the pure Arc helpers moved from src/services/arc/ into
// the compute mod (mods/arc.compute.js). The test imports them from the mod
// so the oracle asserts the MOD's behaviour, not the (deleted) in-tree copy.
// Constants stay host-side (arcSpawn.ts needs them); spawnArc stays host-side
// (the ArcInjectorButton path, §2b). Every expectation below is byte-identical
// to the in-tree version — only the import paths changed.
import {
    rollArcTick,
    rollArcOutcome,
    advanceRung,
    arcSurfaceLine,
    scanArcStance,
    arcWorldState,
} from '../../../mods/arc.compute.js';
import {
    ARC_TICK_DC,
    ARC_BAND_RUNG_DELTA,
    ARC_STANCE_MOD,
    LADDER_MIN,
    LADDER_MAX,
    MAX_ACTIVE_ARCS,
    TYPE_COOLDOWN_SEAMS,
    ARC_LIVE_RECENCY,
} from './arcConstants';

vi.mock('../../utils/llmCall', () => ({
    llmCall: vi.fn()
}));

import { llmCall } from '../../utils/llmCall';
import { spawnArc } from './arcSpawn';

const mockLlmCall = vi.mocked(llmCall);

// ── helpers ────────────────────────────────────────────────────────────────
const fixedTickRoll = (n: number) => () => (n - 0.5) / 100;
const fixedNat = (n: number) => () => (n - 0.5) / 20;

function mockArc(overrides: Partial<ArcRecord> = {}): ArcRecord {
    return {
        id: 'arc-123',
        type: 'economic',
        title: 'Grain Crisis',
        seed: 'Seed text',
        ladder: [
            { label: 'Rung 0', surface: 'ambient' },
            { label: 'Rung 1', surface: 'ambient' },
            { label: 'Rung 2', surface: 'rumor' },
            { label: 'Rung 3', surface: 'rumor' },
            { label: 'Rung 4', surface: 'direct' },
        ],
        currentRung: 1,
        tickDC: 35,
        stance: 'unaware',
        status: 'active',
        bornScene: 'scene-1',
        lastTickScene: 'scene-1',
        ...overrides,
    };
}

describe('Arc Engine Constants', () => {
    it('should assert against the locked constant values', () => {
        expect(ARC_TICK_DC).toEqual({ initial: 35, reduction: 5, floor: 5 });
        expect(ARC_BAND_RUNG_DELTA).toEqual({
            critSuccess: +2,
            success: +1,
            successBut: +1,
            failBut: 0,
            fail: 0,
            critFail: -1,
        });
        expect(ARC_STANCE_MOD).toEqual({
            opposed: -8,
            aided: +6,
            fled: +3,
            ignored: 0,
            unaware: 0,
        });
        expect(LADDER_MIN).toBe(5);
        expect(LADDER_MAX).toBe(12);
        expect(MAX_ACTIVE_ARCS).toBe(3);
        expect(TYPE_COOLDOWN_SEAMS).toBe(6);
        expect(ARC_LIVE_RECENCY).toBe(3);
    });
});

describe('rollArcTick', () => {
    it('fires when roll >= tickDC', () => {
        const arc = { tickDC: 35 };
        const resultBoundary = rollArcTick(arc, fixedTickRoll(35));
        expect(resultBoundary).toEqual({ fired: true, nextDc: 35 });

        const resultAbove = rollArcTick(arc, fixedTickRoll(50));
        expect(resultAbove).toEqual({ fired: true, nextDc: 35 });
    });

    it('misses when roll < tickDC', () => {
        const arc = { tickDC: 35 };
        const result = rollArcTick(arc, fixedTickRoll(34));
        expect(result).toEqual({ fired: false, nextDc: 30 });
    });

    it('clamps to floor and never goes below floor 5', () => {
        const arc1 = { tickDC: 7 };
        const result1 = rollArcTick(arc1, fixedTickRoll(6));
        expect(result1).toEqual({ fired: false, nextDc: 5 });

        const arc2 = { tickDC: 5 };
        const result2 = rollArcTick(arc2, fixedTickRoll(4));
        expect(result2).toEqual({ fired: false, nextDc: 5 });
    });
});

describe('rollArcOutcome', () => {
    it('ignored / unaware: mod 0, matches bandFromMargin expectation', () => {
        const arcIgnored = { stance: 'ignored' as ArcStance };
        for (let nat = 2; nat <= 19; nat++) {
            const result = rollArcOutcome(arcIgnored, fixedNat(nat));
            const margin = nat - 10;
            const expectedBand = bandFromMargin(nat, margin);
            expect(result.band).toBe(expectedBand);
        }

        const arcUnaware = { stance: 'unaware' as ArcStance };
        const resultUnaware = rollArcOutcome(arcUnaware, fixedNat(12));
        expect(resultUnaware.band).toBe(bandFromMargin(12, 12 - 10));
    });

    it('opposed: mod -8, drag leads to fail/critFail for a mid nat', () => {
        const arcOpposed = { stance: 'opposed' as ArcStance };

        const result10 = rollArcOutcome(arcOpposed, fixedNat(10));
        expect(result10.band).toBe('fail');

        const result12 = rollArcOutcome(arcOpposed, fixedNat(12));
        expect(result12.band).toBe('fail');

        const result15 = rollArcOutcome(arcOpposed, fixedNat(15));
        expect(result15.band).toBe('failBut');
    });

    it('aided/fled: positive mod, better band than ignored for the same nat', () => {
        const nat = 10;
        const arcIgnored = { stance: 'ignored' as ArcStance };
        const arcAided = { stance: 'aided' as ArcStance };
        const arcFled = { stance: 'fled' as ArcStance };

        const bandIgnored = rollArcOutcome(arcIgnored, fixedNat(nat)).band;
        const bandAided = rollArcOutcome(arcAided, fixedNat(nat)).band;
        const bandFled = rollArcOutcome(arcFled, fixedNat(nat)).band;

        expect(bandIgnored).toBe('successBut');
        expect(bandAided).toBe('success');
        expect(bandFled).toBe('success');
    });

    it('nat 20 and nat 1 overrides still apply', () => {
        const arcOpposed = { stance: 'opposed' as ArcStance };
        const result20 = rollArcOutcome(arcOpposed, fixedNat(20));
        expect(result20.band).toBe('critSuccess');

        const arcAided = { stance: 'aided' as ArcStance };
        const result1 = rollArcOutcome(arcAided, fixedNat(1));
        expect(result1.band).toBe('critFail');
    });
});

describe('advanceRung', () => {
    it('success on a mid rung advances currentRung by 1 and status remains active', () => {
        const arc = mockArc({ currentRung: 1 });
        const result = advanceRung(arc, 'success');
        expect(result.currentRung).toBe(2);
        expect(result.status).toBe('active');
    });

    it('critSuccess on a mid rung advances currentRung by 2', () => {
        const arc = mockArc({ currentRung: 1 });
        const result = advanceRung(arc, 'critSuccess');
        expect(result.currentRung).toBe(3);
        expect(result.status).toBe('active');
    });

    it('fail/failBut results in stall (no rung change), status active', () => {
        const arc = mockArc({ currentRung: 1 });
        const resultFail = advanceRung(arc, 'fail');
        expect(resultFail.currentRung).toBe(1);
        expect(resultFail.status).toBe('active');

        const resultFailBut = advanceRung(arc, 'failBut');
        expect(resultFailBut.currentRung).toBe(1);
        expect(resultFailBut.status).toBe('active');
    });

    it('critFail mid-ladder regresses currentRung by 1', () => {
        const arc = mockArc({ currentRung: 2 });
        const result = advanceRung(arc, 'critFail');
        expect(result.currentRung).toBe(1);
        expect(result.status).toBe('active');
    });

    it('critFail at rung 0 clamps to 0 and does not go negative', () => {
        const arc = mockArc({ currentRung: 0 });
        const result = advanceRung(arc, 'critFail');
        expect(result.currentRung).toBe(0);
        expect(result.status).toBe('active');
    });

    it('climb that reaches or passes top rung lands at top and status becomes boiled_over', () => {
        const arcSuccess = mockArc({ currentRung: 3 });
        const resultSuccess = advanceRung(arcSuccess, 'success');
        expect(resultSuccess.currentRung).toBe(4);
        expect(resultSuccess.status).toBe('boiled_over');

        const arcCrit = mockArc({ currentRung: 3 });
        const resultCrit = advanceRung(arcCrit, 'critSuccess');
        expect(resultCrit.currentRung).toBe(4);
        expect(resultCrit.status).toBe('boiled_over');
    });

    it('already at top + another climb stays at top and boiled_over', () => {
        const arc = mockArc({ currentRung: 4, status: 'boiled_over' });
        const result = advanceRung(arc, 'success');
        expect(result.currentRung).toBe(4);
        expect(result.status).toBe('boiled_over');
    });

    it('degenerate empty ladder returns arc unchanged', () => {
        const arc = mockArc({ ladder: [] });
        const result = advanceRung(arc, 'success');
        expect(result).toBe(arc);
    });

    it('maintains immutability (returns a new object)', () => {
        const arc = mockArc();
        const result = advanceRung(arc, 'success');
        expect(result).not.toBe(arc);
        expect(arc.currentRung).toBe(1);
    });
});

describe('arcSurfaceLine', () => {
    it('active arc with current rung surface ambient/rumor/direct returns tagged string', () => {
        const arcAmbient = mockArc({ status: 'active', currentRung: 0 });
        expect(arcSurfaceLine(arcAmbient)).toBe('[WORLD/ambient] Rung 0');

        const arcRumor = mockArc({ status: 'active', currentRung: 2 });
        expect(arcSurfaceLine(arcRumor)).toBe('[WORLD/rumor] Rung 2');

        const arcDirect = mockArc({ status: 'active', currentRung: 4 });
        expect(arcSurfaceLine(arcDirect)).toBe('[WORLD/direct] Rung 4');
    });

    it('inactive statuses (resolved, boiled_over, defused) return empty string', () => {
        const arcResolved = mockArc({ status: 'resolved' });
        expect(arcSurfaceLine(arcResolved)).toBe('');

        const arcBoiled = mockArc({ status: 'boiled_over' });
        expect(arcSurfaceLine(arcBoiled)).toBe('');

        const arcDefused = mockArc({ status: 'defused' });
        expect(arcSurfaceLine(arcDefused)).toBe('');
    });

    it('empty ladder or missing/invalid rung returns empty string', () => {
        const arcEmpty = mockArc({ ladder: [] });
        expect(arcSurfaceLine(arcEmpty)).toBe('');

        const arcInvalidIndex = mockArc({ currentRung: 99 });
        expect(arcSurfaceLine(arcInvalidIndex)).toBe('');

        const arcMissingLabel = mockArc({
            ladder: [
                { label: '', surface: 'ambient' }
            ],
            currentRung: 0
        });
        expect(arcSurfaceLine(arcMissingLabel)).toBe('');
    });
});

describe('scanArcStance', () => {
    const activeArc = mockArc({
        id: 'arc-1',
        title: 'Grain Shortage',
        seed: 'Wheat harvest failed.',
        ladder: [
            { label: 'Wheat prices rise', surface: 'ambient' },
        ],
        currentRung: 0,
        status: 'active',
    });

    it('classifies opposed when player input mentions keyword + oppose verb', () => {
        const result = scanArcStance('I will stop the grain hoarders', '', [activeArc]);
        expect(result).toEqual([{ arcId: 'arc-1', stance: 'opposed' }]);
    });

    it('classifies aided / fled / ignored when appropriate verbs are matched with keyword', () => {
        const resultAid = scanArcStance('We will support the wheat growers', '', [activeArc]);
        expect(resultAid).toEqual([{ arcId: 'arc-1', stance: 'aided' }]);

        const resultFled = scanArcStance('We must escape the rising prices', '', [activeArc]);
        expect(resultFled).toEqual([{ arcId: 'arc-1', stance: 'fled' }]);

        const resultIgnore = scanArcStance('We should disregard the shortage', '', [activeArc]);
        expect(resultIgnore).toEqual([{ arcId: 'arc-1', stance: 'ignored' }]);
    });

    it('omits arc if no keyword is matched', () => {
        const result = scanArcStance('I will stop the dragon hoarders', '', [activeArc]);
        expect(result).toEqual([]);
    });

    it('omits arc if keyword is matched but no stance verb is present', () => {
        const result = scanArcStance('Tell me about the grain', '', [activeArc]);
        expect(result).toEqual([]);
    });

    it('obeys priority: opposed > aided > fled > ignored when multiple verbs match', () => {
        const resultOpposeAid = scanArcStance('We will stop and support the grain shortage', '', [activeArc]);
        expect(resultOpposeAid).toEqual([{ arcId: 'arc-1', stance: 'opposed' }]);

        const resultAidFled = scanArcStance('We will support and escape the grain shortage', '', [activeArc]);
        expect(resultAidFled).toEqual([{ arcId: 'arc-1', stance: 'aided' }]);

        const resultFledIgnore = scanArcStance('We must escape and ignore the grain shortage', '', [activeArc]);
        expect(resultFledIgnore).toEqual([{ arcId: 'arc-1', stance: 'fled' }]);
    });

    it('uses secondary mention signal from GM text if player input contains only stance verb', () => {
        const result = scanArcStance('I will stop them', 'The grain is running out', [activeArc]);
        expect(result).toEqual([{ arcId: 'arc-1', stance: 'opposed' }]);
    });

    it('does not classify when GM text mentions keyword but player has no stance verb', () => {
        const result = scanArcStance('I go to the tavern', 'The grain is running out', [activeArc]);
        expect(result).toEqual([]);
    });

    it('ignores inactive arcs', () => {
        const inactiveArc = { ...activeArc, status: 'resolved' as const };
        const result = scanArcStance('I will stop the grain shortage', '', [inactiveArc]);
        expect(result).toEqual([]);
    });
});

describe('arcWorldState', () => {
    const inactiveArc = mockArc({ status: 'resolved' });

    it('returns live if active arc ticked recently (within recency of nowScene)', () => {
        const activeArc = mockArc({ status: 'active', lastTickScene: '10' });
        const result = arcWorldState([activeArc], [], {}, 12);
        expect(result).toBe('live');

        const resultBoundary = arcWorldState([activeArc], [], {}, 13);
        expect(resultBoundary).toBe('live');
    });

    it('returns live if NPC pressure is above threshold (> 1)', () => {
        const pressureIgnored = { npc1: { ignored: 2 } as NPCPressure };
        const resultIgnored = arcWorldState([], [], pressureIgnored, 10);
        expect(resultIgnored).toBe('live');

        const pressureEngaged = { npc2: { engaged: 2 } as NPCPressure };
        const resultEngaged = arcWorldState([], [], pressureEngaged, 10);
        expect(resultEngaged).toBe('live');
    });

    it('returns stalled if active arc exists but ticked long ago and no pressure', () => {
        const activeArc = mockArc({ status: 'active', lastTickScene: '10' });
        const result = arcWorldState([activeArc], [], {}, 14);
        expect(result).toBe('stalled');
    });

    it('returns stalled if open threads exist and no live pressure or recent arc tick', () => {
        const result = arcWorldState([], [{ text: 'open thread' }], {}, 10);
        expect(result).toBe('stalled');
    });

    it('returns dry if no active arcs, no open threads, and no live pressure', () => {
        const lowPressure = { npc1: { ignored: 1, engaged: 1 } as NPCPressure };
        const result = arcWorldState([inactiveArc], [], lowPressure, 10);
        expect(result).toBe('dry');
    });
});

describe('spawnArc', () => {
    const provider = { endpoint: 'http://mock-llm', modelName: 'mock-model' } as EndpointConfig;
    const anchor = { kind: 'thread' as const, text: 'The wheat guild is angry' };
    const input = {
        provider,
        anchor,
        worldContext: 'Recent events',
        suppressedTypes: [] as ArcType[],
        bornScene: 'scene-5',
    };

    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('valid JSON (5-12 rungs, valid type, good surfaces) returns well-formed ArcRecord', async () => {
        const validJson = {
            title: 'Wheat Guild Boycott',
            type: 'economic',
            seed: 'The wheat guild has declared a boycott.',
            ladder: [
                { label: 'Guild holds a meeting', surface: 'ambient' },
                { label: 'Prices rise', surface: 'ambient' },
                { label: 'Supply drys up', surface: 'rumor' },
                { label: 'Riots in the street', surface: 'rumor' },
                { label: 'The city gates are closed', surface: 'direct' },
            ],
        };

        mockLlmCall.mockResolvedValueOnce(JSON.stringify(validJson));

        const result = await spawnArc(input);
        expect(result).not.toBeNull();
        expect(result).toEqual({
            id: expect.any(String),
            type: 'economic',
            title: 'Wheat Guild Boycott',
            seed: 'The wheat guild has declared a boycott.',
            ladder: [
                { label: 'Guild holds a meeting', surface: 'ambient' },
                { label: 'Prices rise', surface: 'ambient' },
                { label: 'Supply drys up', surface: 'rumor' },
                { label: 'Riots in the street', surface: 'rumor' },
                { label: 'The city gates are closed', surface: 'direct' },
            ],
            currentRung: 0,
            tickDC: 35,
            stance: 'unaware',
            status: 'active',
            bornScene: 'scene-5',
            lastTickScene: 'scene-5',
        });
    });

    it('returns null if ladder length is less than 5', async () => {
        const tooShortJson = {
            title: 'Too Short',
            type: 'economic',
            seed: 'Seed',
            ladder: [
                { label: 'Rung 0', surface: 'ambient' },
                { label: 'Rung 1', surface: 'ambient' },
                { label: 'Rung 2', surface: 'ambient' },
                { label: 'Rung 3', surface: 'ambient' },
            ],
        };

        mockLlmCall.mockResolvedValueOnce(JSON.stringify(tooShortJson));

        const result = await spawnArc(input);
        expect(result).toBeNull();
    });

    it('returns null if ladder length is greater than 12', async () => {
        const tooLongJson = {
            title: 'Too Long',
            type: 'economic',
            seed: 'Seed',
            ladder: Array.from({ length: 13 }, (_, i) => ({
                label: `Rung ${i}`,
                surface: 'ambient',
            })),
        };

        mockLlmCall.mockResolvedValueOnce(JSON.stringify(tooLongJson));

        const result = await spawnArc(input);
        expect(result).toBeNull();
    });

    it('returns null if type is in suppressedTypes', async () => {
        const json = {
            title: 'Wheat Guild Boycott',
            type: 'economic',
            seed: 'Seed',
            ladder: Array.from({ length: 5 }, (_, i) => ({
                label: `Rung ${i}`,
                surface: 'ambient',
            })),
        };

        mockLlmCall.mockResolvedValueOnce(JSON.stringify(json));

        const result = await spawnArc({
            ...input,
            suppressedTypes: ['economic'],
        });
        expect(result).toBeNull();
    });

    it('coerces bad/garbage surface values to ambient', async () => {
        const garbageSurfaceJson = {
            title: 'Wheat Guild Boycott',
            type: 'economic',
            seed: 'Seed',
            ladder: [
                { label: 'Rung 0', surface: 'garbage' },
                { label: 'Rung 1', surface: 'ambient' },
                { label: 'Rung 2', surface: 'rumor' },
                { label: 'Rung 3', surface: 'rumor' },
                { label: 'Rung 4', surface: 'direct' },
            ],
        };

        mockLlmCall.mockResolvedValueOnce(JSON.stringify(garbageSurfaceJson));

        const result = await spawnArc(input);
        expect(result).not.toBeNull();
        expect(result?.ladder[0].surface).toBe('ambient');
    });

    it('returns null if LLM output is malformed / non-JSON', async () => {
        mockLlmCall.mockResolvedValueOnce('No JSON here whatsoever!');
        const result = await spawnArc(input);
        expect(result).toBeNull();
    });

    it('returns null if LLM call throws an error', async () => {
        mockLlmCall.mockRejectedValueOnce(new Error('Network Error'));
        const result = await spawnArc(input);
        expect(result).toBeNull();
    });
});
