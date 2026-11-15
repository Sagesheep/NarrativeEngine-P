import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useAppStore } from '../../../store/useAppStore';
import { cancelPendingSaves } from '../../../store/slices/campaignSlice';
import { CombatParleyBox } from '../CombatParleyBox';
import type { CombatSession, CombatState, Combatant } from '../../../types';

function unit(id: string, side: Combatant['side'], at: [number, number], extra: Partial<Combatant> = {}): Combatant {
    return {
        id, name: id, side, controller: side === 'player' ? 'player' : 'engine', tier: 'grunt',
        abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        maxHp: 20, hp: 20, ac: 12, attackBonus: 3, damage: { count: 1, sides: 6, bonus: 0, type: 'slashing' },
        initiative: 10, status: 'up', conditions: [], position: { x: at[0], y: at[1] }, ...extra,
    };
}

function session(list: Combatant[]): CombatSession {
    const state: CombatState = {
        id: 'ui', round: 2, order: list.map(c => c.id), turnIndex: 0, combatants: Object.fromEntries(list.map(c => [c.id, c])),
        rngSeed: 1, rngCursor: 0, eventSeq: 0, outcome: null, grid: { width: 8, height: 5, tiles: new Array(40).fill('floor') }, turnCount: 3,
    };
    return { state, log: [], narratedThroughSeq: 0, startedAtMessageId: 'gm', reason: 'Ambush' };
}

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    useAppStore.setState({ activeCampaignId: 'c1', combatSession: null, combatBusy: false });
});

afterEach(() => {
    cancelPendingSaves();
    vi.unstubAllGlobals();
});

describe('parley box with animals standing', () => {
    it('is disabled, with the reason, when only animals are left', () => {
        render(<CombatParleyBox session={session([unit('pc', 'player', [0, 2]), unit('Wild dog 1', 'enemy', [7, 2]), unit('Wild dog 2', 'enemy', [7, 3])])} busy={false} />);
        expect(screen.queryByTestId('combat-parley')).toBeNull();
        const blocked = screen.getByTestId('combat-parley-blocked');
        expect(blocked.querySelector('textarea')?.disabled).toBe(true);
        expect(blocked.querySelector('button')?.disabled).toBe(true);
        expect(blocked.querySelector('textarea')?.getAttribute('placeholder')).toBe('There is no one here to reason with.');
    });

    it('is enabled for a mixed group', () => {
        render(<CombatParleyBox session={session([unit('pc', 'player', [0, 2]), unit('Wild dog 1', 'enemy', [7, 2]), unit('Bandit', 'enemy', [7, 3])])} busy={false} />);
        expect(screen.getByTestId('combat-parley')).toBeTruthy();
        expect(screen.queryByTestId('combat-parley-blocked')).toBeNull();
    });

    it('is enabled for speakers only', () => {
        render(<CombatParleyBox session={session([unit('pc', 'player', [0, 2]), unit('Bandit', 'enemy', [7, 3])])} busy={false} />);
        expect(screen.getByTestId('combat-parley')).toBeTruthy();
    });
});
