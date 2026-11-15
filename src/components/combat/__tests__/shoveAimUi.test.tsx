import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useRef, useState } from 'react';
import { applyAction, buildPcCombatant, freshTurn } from '@narrative/engine';
import { CombatScreen } from '../CombatScreen';
import { computeAimPreview } from '../useAbilityAim';
import type { ChatMessage, CombatAction, CombatSession, CombatSheet, CombatState, CombatTile, Combatant, GlyphAbility } from '../../../types';

const mockState: { settings: Record<string, unknown>; modTables: Record<string, unknown>; messages: ChatMessage[] } = { settings: {}, modTables: {}, messages: [] };

vi.mock('../../../store/useAppStore', () => {
    const useAppStore = Object.assign(
        (selector: (s: typeof mockState) => unknown) => selector(mockState),
        { getState: () => mockState, subscribe: () => () => {} },
    );
    return { useAppStore };
});

vi.mock('../../../services/turn/pendingCommit', () => ({
    commitPendingTurn: vi.fn(async () => {}),
    findPendingCommitMessage: () => null,
}));

const sheet: CombatSheet = { abilities: { STR: 14, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 8 }, budget: 'NORMAL', level: 3, needsAllocation: false };

function npc(id: string, side: Combatant['side'], x: number, y: number, extra: Partial<Combatant> = {}): Combatant {
    return {
        id, name: id, side, controller: 'engine', tier: 'grunt',
        abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        maxHp: 40, hp: 40, ac: 30, attackBonus: -20, damage: { count: 1, sides: 4, bonus: 0, type: 'slashing' },
        initiative: 1, status: 'up', conditions: [], position: { x, y }, range: 'close', ...extra,
    };
}

function session(foes: Combatant[], tiles: Array<[number, number, CombatTile]> = [], kit: GlyphAbility[] = []): CombatSession {
    const pc = { ...buildPcCombatant({ name: 'Kira', sheet, kit }), position: { x: 4, y: 4 } };
    const all = [pc, ...foes];
    const grid = { width: 12, height: 8, tiles: new Array<CombatTile>(96).fill('floor') };
    for (const [x, y, kind] of tiles) grid.tiles[y * 12 + x] = kind;
    const base: CombatState = {
        id: 'ui', round: 1, order: all.map(c => c.id), turnIndex: 0,
        combatants: Object.fromEntries(all.map(c => [c.id, c])),
        rngSeed: 5, rngCursor: 0, eventSeq: 0, outcome: null, turnCount: 1, grid,
    };
    return { state: { ...base, turn: freshTurn(base, 'pc') }, log: [], narratedThroughSeq: 0, postedThroughSeq: 0, startedAtMessageId: 'gm', reason: 'Ambush' };
}

function Harness({ initial, onAct }: { initial: CombatSession; onAct?: (a: CombatAction) => void }) {
    const [s, setS] = useState(initial);
    const feedRef = useRef<HTMLDivElement | null>(null);
    const onAction = (action: CombatAction) => {
        onAct?.(action);
        setS(current => {
            const applied = applyAction(current.state, action);
            if (applied.events.some(e => e.type === 'rejected')) return current;
            return { ...current, state: applied.state, log: [...current.log, ...applied.events] };
        });
    };
    return <CombatScreen session={s} busy={false} onAction={onAction} onEnd={() => {}} onSkip={() => {}} feedScrollRef={feedRef} feed={<div ref={feedRef} />} />;
}

const tile = (x: number, y: number) => document.querySelector(`[data-testid="combat-tiles"] rect[data-x="${x}"][data-y="${y}"]`) as Element;

function openShove() {
    fireEvent.click(screen.getByTestId('combat-ability-builtin:shove'));
}

describe('aiming Shove shows where the target would go', () => {
    beforeEach(() => {
        vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('draws the path and landing tile for the hovered target, and marks a hazard on the path', () => {
        render(<Harness initial={session([npc('DogA', 'enemy', 5, 4)], [[6, 4, 'hazard']])} />);
        openShove();
        expect(screen.queryByTestId('combat-push')).toBeNull();
        fireEvent.mouseEnter(tile(5, 4));
        const trail = screen.getByTestId('combat-push');
        expect(trail.getAttribute('data-target')).toBe('DogA');
        expect(trail.getAttribute('data-squares')).toBe('2');
        const landing = screen.getByTestId('combat-push-landing');
        expect([landing.getAttribute('data-x'), landing.getAttribute('data-y')]).toEqual(['7', '4']);
        const hazard = screen.getByTestId('combat-push-hazard');
        expect([hazard.getAttribute('data-x'), hazard.getAttribute('data-y')]).toEqual(['6', '4']);
    });

    it('shows the slid path when a creature stands directly behind the target', () => {
        render(<Harness initial={session([npc('DogA', 'enemy', 5, 4), npc('DogB', 'enemy', 6, 4)])} />);
        openShove();
        fireEvent.mouseEnter(tile(5, 4));
        const trail = screen.getByTestId('combat-push');
        expect(trail.getAttribute('data-slid')).toBe('true');
        const landing = screen.getByTestId('combat-push-landing');
        expect([landing.getAttribute('data-x'), landing.getAttribute('data-y')]).toEqual(['7', '6']);
    });

    it('refuses a pinned target with its own reason, and the Shove button says so when nothing can be shoved', () => {
        const walls: Array<[number, number, CombatTile]> = [[6, 4, 'wall']];
        render(<Harness initial={session([npc('DogA', 'enemy', 5, 4)], walls)} />);
        const button = screen.getByTestId('combat-ability-builtin:shove');
        expect(button.getAttribute('aria-disabled')).toBe('true');
        expect(button).toHaveTextContent('No room to shove them');
    });

    it('explains a pinned target on hover while another target can still be shoved', () => {
        const walls: Array<[number, number, CombatTile]> = [[6, 4, 'wall']];
        render(<Harness initial={session([npc('DogA', 'enemy', 5, 4), npc('DogC', 'enemy', 4, 5)], walls)} />);
        openShove();
        fireEvent.mouseEnter(tile(5, 4));
        expect(screen.getByTestId('combat-board-status')).toHaveTextContent('Shove: no room to shove them');
        expect(screen.queryByTestId('combat-push')).toBeNull();
        fireEvent.mouseEnter(tile(4, 5));
        expect(screen.getByTestId('combat-push')).toBeTruthy();
    });
});

describe('aim previews carry the pushes for push and pull abilities', () => {
    const push: GlyphAbility = { id: 'gust', name: 'Gust', form: { id: 'burst', augments: [] }, effects: [{ id: 'push', augments: [] }], source: 'player' };
    const pull: GlyphAbility = { id: 'hook', name: 'Hook', form: { id: 'projectile', augments: [] }, effects: [{ id: 'pull', augments: [] }], source: 'player' };

    it('lists one push per target in an area', () => {
        const s = session([npc('A', 'enemy', 8, 4), npc('B', 'enemy', 9, 4), npc('C', 'enemy', 8, 5)], [], [push]).state;
        const ability = s.combatants.pc.kit?.[0] as GlyphAbility;
        const preview = computeAimPreview(s, 'pc', ability, { x: 8, y: 4 });
        expect(preview.ok).toBe(true);
        expect(preview.pushes.map(p => p.targetId).sort()).toEqual(['B', 'C']);
    });

    it('lists the pull for a single target and nothing for plain damage', () => {
        const s = session([npc('A', 'enemy', 8, 4)], [], [pull]).state;
        const preview = computeAimPreview(s, 'pc', s.combatants.pc.kit?.[0] as GlyphAbility, { x: 8, y: 4 });
        expect(preview.pushes).toHaveLength(1);
        expect(preview.pushes[0]).toMatchObject({ kind: 'pull', squares: 2, landing: { x: 6, y: 4 } });
        const damage: GlyphAbility = { id: 'zap', name: 'Zap', form: { id: 'projectile', augments: [] }, effects: [{ id: 'damage', augments: [] }], source: 'player' };
        expect(computeAimPreview(s, 'pc', damage, { x: 8, y: 4 }).pushes).toEqual([]);
    });
});
