import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { applyAction, buildPcCombatant, freshTurn, runEngineTurns, STARTER_ABILITIES } from '@narrative/engine';
import { CombatScreen } from '../CombatScreen';
import { isEngineTurn } from '../../../services/combat/combatController';
import type { ChatMessage, CombatAction, CombatSession, CombatSheet, CombatState, Combatant, GlyphAbility } from '../../../types';

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

const sheet: CombatSheet = { abilities: { STR: 10, DEX: 14, CON: 14, INT: 16, WIS: 10, CHA: 8 }, budget: 'NORMAL', level: 3, needsAllocation: false };
const fireball = STARTER_ABILITIES.find(a => a.id === 'fireball') as GlyphAbility;
const mend = STARTER_ABILITIES.find(a => a.id === 'mend') as GlyphAbility;

function npc(id: string, side: Combatant['side'], x: number, y: number, extra: Partial<Combatant> = {}): Combatant {
    return {
        id, name: id, side, controller: 'engine', tier: 'grunt',
        abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        maxHp: 40, hp: 40, ac: 30, attackBonus: -20, damage: { count: 1, sides: 4, bonus: 0, type: 'slashing' },
        initiative: 1, status: 'up', conditions: [], position: { x, y }, range: 'close', ...extra,
    };
}

function session(extra: Partial<CombatState> = {}, more: Combatant[] = []): CombatSession {
    const pc = { ...buildPcCombatant({ name: 'Kira', sheet, kit: [fireball, mend] }), position: { x: 1, y: 4 } };
    const all = [pc, npc('Pal', 'ally', 6, 4), npc('Brute', 'enemy', 7, 4), npc('Thug', 'enemy', 7, 5), ...more];
    const base: CombatState = {
        id: 'ui', round: 1, order: all.map(c => c.id), turnIndex: 0,
        combatants: Object.fromEntries(all.map(c => [c.id, c])),
        rngSeed: 5, rngCursor: 0, eventSeq: 0, outcome: null, turnCount: 1,
        grid: { width: 12, height: 8, tiles: new Array(96).fill('floor') },
        ...extra,
    };
    return { state: { ...base, turn: freshTurn(base, 'pc') }, log: [], narratedThroughSeq: 0, postedThroughSeq: 0, startedAtMessageId: 'gm', reason: 'Ambush' };
}

function Harness({ initial }: { initial: CombatSession }) {
    const [s, setS] = useState(initial);
    const feedRef = useRef<HTMLDivElement | null>(null);
    const onAction = (action: CombatAction) => setS(current => {
        const applied = applyAction(current.state, action);
        if (applied.events.some(e => e.type === 'rejected')) return current;
        let state = applied.state;
        if (!state.outcome && isEngineTurn(state)) state = runEngineTurns(state).state;
        return { ...current, state, log: [...current.log, ...applied.events] };
    });
    return <CombatScreen session={s} busy={false} onAction={onAction} onEnd={() => {}} onSkip={() => {}} feedScrollRef={feedRef} feed={<div ref={feedRef} />} />;
}

const tile = (x: number, y: number) => document.querySelector(`[data-testid="combat-tiles"] rect[data-x="${x}"][data-y="${y}"]`) as Element;

describe('combat UI for abilities (T7)', () => {
    beforeEach(() => {
        vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('lists equipped abilities between Defend and End turn, with cost, MP beside HP and disabled reasons', () => {
        render(<Harness initial={session()} />);
        const bar = screen.getByTestId('combat-action-bar');
        const labels = within(bar).getAllByRole('button').map(b => b.textContent?.trim() ?? '');
        const defend = labels.findIndex(l => /Defend/.test(l));
        const end = labels.findIndex(l => /End turn/.test(l));
        const fb = labels.findIndex(l => /Fireball/.test(l));
        expect(defend).toBeLessThan(fb);
        expect(fb).toBeLessThan(end);
        expect(screen.getByTestId('combat-ability-fireball')).toHaveTextContent('4');
        expect(screen.getByTestId('combat-mp')).toHaveTextContent('MP 16/16');
        expect(screen.getByTestId('combat-ability-mend')).toBeDisabled();
        expect(screen.getByTestId('combat-ability-mend')).toHaveAttribute('title', 'No legal target');
    });

    it('a digit key enters aiming; hovering previews the area and marks allies apart from foes; Escape cancels', () => {
        render(<Harness initial={session()} />);
        fireEvent.keyDown(window, { key: '1' });
        expect(screen.getAllByTestId('combat-aim-legal').length).toBeGreaterThan(0);
        expect(screen.queryAllByTestId('combat-reachable')).toHaveLength(0);
        fireEvent.mouseEnter(tile(7, 4));
        expect(screen.getAllByTestId('combat-aim-area')).toHaveLength(9);
        const hits = screen.getAllByTestId('combat-aim-hit').map(h => [h.getAttribute('data-id'), h.getAttribute('data-friendly')]);
        expect(hits.sort()).toEqual([['Brute', 'false'], ['Pal', 'true'], ['Thug', 'false']]);
        expect(screen.getByTestId('combat-board-status')).toHaveTextContent('Fireball: 3 caught, 1 on your side');
        fireEvent.keyDown(screen.getByTestId('combat-board-surface'), { key: 'Escape' });
        expect(screen.queryByTestId('combat-aim')).toBeNull();
    });

    it('clicking a legal square casts the ability and spends MP', () => {
        render(<Harness initial={session()} />);
        fireEvent.click(screen.getByTestId('combat-ability-fireball'));
        fireEvent.click(tile(8, 5));
        expect(screen.getByTestId('combat-mp')).toHaveTextContent('MP 12/16');
        expect(screen.queryByTestId('combat-aim')).toBeNull();
    });

    it('draws barriers as their own layer, summons distinctly, hides gone summons, and shows conditions and temporary HP', () => {
        const summon = npc('Aqua', 'ally', 3, 3, { summonerId: 'pc', expiresRound: 4, controller: 'engine', tier: 'minion' });
        const gone = npc('Old', 'ally', 3, 2, { summonerId: 'pc', status: 'gone' });
        const s = session({ barriers: [{ pos: { x: 4, y: 4 }, expiresRound: 3, sourceId: 'pc' }] }, [summon, gone]);
        s.state.combatants.pc = { ...s.state.combatants.pc, tempHp: 7, conditions: [{ id: 'hasted', turns: 2 }] };
        render(<Harness initial={s} />);
        expect(screen.getAllByTestId('combat-barrier')).toHaveLength(1);
        expect(screen.getByTestId('token-Aqua')).toHaveAttribute('data-summon', 'true');
        expect(screen.queryByTestId('token-Old')).toBeNull();
        expect(screen.queryByTestId('combatant-Old')).toBeNull();
        expect(within(screen.getByTestId('token-pc')).getByTestId('combat-conditions')).toHaveTextContent('H2');
        expect(within(screen.getByTestId('token-pc')).getByTestId('combat-temp-hp')).toBeTruthy();
        expect(screen.getByTestId('combat-temp')).toHaveTextContent('7 temporary HP');
        fireEvent.click(screen.getByTestId('combatant-pc'));
        const notes = screen.getAllByTestId('combat-inspect-note').map(n => n.textContent);
        expect(notes).toEqual(['MP 16/16', '7 temporary HP', 'Hasted (2 of its turns)']);
        fireEvent.click(screen.getByTestId('combatant-Aqua'));
        expect(screen.getAllByTestId('combat-inspect-note').map(n => n.textContent)).toContain('Summoned, leaves when round 4 begins');
        fireEvent.mouseEnter(tile(4, 4));
        expect(screen.getByTestId('combat-board-status')).toHaveTextContent('Barrier, ends when round 3 begins');
    });
});
