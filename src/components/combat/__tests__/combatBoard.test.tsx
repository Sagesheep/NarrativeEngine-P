import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { buildPcCombatant } from '@narrative/engine';
import { CombatBoard } from '../CombatBoard';
import { CombatProposalDialog } from '../CombatProposalDialog';
import type { CombatProposal, CombatSession, CombatSheet, CombatState, CombatTile, Combatant } from '../../../types';

const mockState: { settings: Record<string, unknown>; modTables: Record<string, unknown> } = { settings: {}, modTables: {} };

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

const sheet: CombatSheet = { abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 3, needsAllocation: false };

const ROWS = ['......', '......', '..#...', '......'];

function foe(id: string, name: string, x: number, y: number, extra: Partial<Combatant> = {}): Combatant {
    return {
        id, name, side: 'enemy', controller: 'engine', tier: 'grunt',
        abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        maxHp: 10, hp: 10, ac: 11, attackBonus: 3, damage: { count: 1, sides: 6, bonus: 0, type: 'slashing' },
        initiative: 1, status: 'up', conditions: [], position: { x, y }, range: 'close', ...extra,
    };
}

function session(patch: Partial<CombatState> = {}): CombatSession {
    const pc = { ...buildPcCombatant({ name: 'Kira', sheet }), position: { x: 0, y: 1 } };
    const tiles = ROWS.join('').split('').map(ch => (ch === '#' ? 'wall' : 'floor') as CombatTile);
    const state: CombatState = {
        id: 'b', round: 1, order: ['pc', 'e1', 'e2'], turnIndex: 0,
        combatants: { pc, e1: foe('e1', 'Bandit', 1, 1), e2: foe('e2', 'Archer', 5, 3, { hp: 4 }) },
        rngSeed: 1, rngCursor: 0, eventSeq: 0, outcome: null,
        grid: { width: 6, height: 4, tiles }, turn: { actorId: 'pc', moveLeft: 6, actionUsed: false }, turnCount: 1,
        ...patch,
    };
    return { state, log: [], narratedThroughSeq: 0, postedThroughSeq: 0, startedAtMessageId: 'gm', reason: '' };
}

const surface = () => screen.getByTestId('combat-board-surface');
const tile = (x: number, y: number) => surface().querySelector(`rect[data-x="${x}"][data-y="${y}"][data-tile]`) as SVGRectElement;

function board(s = session(), busy = false, targetId: string | null = null) {
    const onAction = vi.fn();
    const onTarget = vi.fn();
    const utils = render(<CombatBoard session={s} busy={busy} targetId={targetId} onTarget={onTarget} onAction={onAction} />);
    return { onAction, onTarget, ...utils };
}

beforeEach(() => {
    mockState.modTables = {};
    mockState.settings = {};
    try { window.localStorage.clear(); } catch { return; }
});

describe('CombatBoard', () => {
    it('draws one tile per square and names every token, with one and many squares worded apart', () => {
        board();
        expect(surface().querySelectorAll('rect[data-tile]')).toHaveLength(24);
        expect(tile(2, 2).getAttribute('data-tile')).toBe('wall');
        expect(screen.getByLabelText('Bandit, Enemy, Unhurt, 1 square away')).toBeInTheDocument();
        expect(screen.getByLabelText('Archer, Enemy, Badly hurt, 5 squares away')).toBeInTheDocument();
        expect(screen.getByLabelText(/^Kira, You, 28 of 28 HP$/)).toBeInTheDocument();
    });

    it('fills its cell: the map scales inside the cell with square tiles and no fixed height', () => {
        board();
        const svg = screen.getByTestId('combat-board-surface').querySelector('svg') as SVGSVGElement;
        expect(svg.getAttribute('viewBox')).toBe('0 0 60 40');
        expect(svg.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
        expect(svg.getAttribute('width')).toBe('100%');
        expect(svg.getAttribute('height')).toBe('100%');
        expect(screen.getByTestId('combat-board-surface').getAttribute('style')).toBeNull();
    });

    it('highlights reachable squares, previews the path and its cost, and moves on click', () => {
        const { onAction } = board();
        const reachable = screen.getAllByTestId('combat-reachable');
        expect(reachable.length).toBeGreaterThan(10);
        expect(reachable.some(r => r.getAttribute('data-x') === '1' && r.getAttribute('data-y') === '1')).toBe(false);
        expect(reachable.some(r => r.getAttribute('data-x') === '2' && r.getAttribute('data-y') === '2')).toBe(false);
        fireEvent.mouseEnter(tile(3, 0));
        expect(screen.getByTestId('combat-path')).toBeInTheDocument();
        expect(screen.getByTestId('combat-board-status').textContent).toBe('Move here: 3 of 6 squares');
        fireEvent.click(tile(3, 0));
        expect(onAction).toHaveBeenCalledWith({ type: 'move', actorId: 'pc', to: { x: 3, y: 0 } });
        onAction.mockClear();
        fireEvent.click(tile(2, 2));
        expect(onAction).not.toHaveBeenCalled();
    });

    it('marks targets in range, attacks on click and explains why others cannot be hit', () => {
        const { onAction, onTarget } = board();
        expect(screen.getAllByTestId('combat-target-mark')).toHaveLength(1);
        fireEvent.mouseEnter(screen.getByTestId('token-e2'));
        expect(screen.getByTestId('combat-board-status').textContent).toBe('Archer is out of range');
        expect(screen.getByTestId('combat-los').getAttribute('data-clear')).toBe('false');
        fireEvent.click(screen.getByTestId('token-e2'));
        expect(onAction).not.toHaveBeenCalled();
        expect(onTarget).toHaveBeenCalledWith('e2');
        fireEvent.mouseEnter(screen.getByTestId('token-e1'));
        expect(screen.getByTestId('combat-board-status').textContent).toBe('Attack Bandit');
        fireEvent.click(screen.getByTestId('token-e1'));
        expect(onAction).toHaveBeenCalledWith({ type: 'attack', actorId: 'pc', targetId: 'e1' });
    });

    it('shows the cover bonus and adjacency disadvantage for a ranged shot', () => {
        const s = session();
        s.state.combatants.pc.range = 'ranged';
        s.state.grid!.tiles[2 * 6 + 2] = 'floor';
        s.state.grid!.tiles[2 * 6 + 3] = 'cover';
        board(s);
        fireEvent.mouseEnter(screen.getByTestId('token-e2'));
        expect(screen.getByTestId('combat-board-status').textContent).toBe('Attack Archer · cover +2 AC · disadvantage: an enemy is next to you');
        expect(screen.getByTestId('combat-los').getAttribute('data-clear')).toBe('true');
    });

    it('offers nothing while the engine is acting or the action is spent, but still lets the player inspect', () => {
        const busy = board(session(), true);
        expect(screen.queryAllByTestId('combat-reachable')).toHaveLength(0);
        fireEvent.click(tile(3, 0));
        fireEvent.click(screen.getByTestId('token-e1'));
        expect(busy.onAction).not.toHaveBeenCalled();
        expect(busy.onTarget).toHaveBeenCalledWith('e1');
        busy.unmount();
        const spent = board(session({ turn: { actorId: 'pc', moveLeft: 2, actionUsed: true } }));
        expect(screen.queryAllByTestId('combat-target-mark')).toHaveLength(0);
        fireEvent.click(screen.getByTestId('token-e1'));
        expect(spent.onAction).not.toHaveBeenCalled();
        expect(screen.getAllByTestId('combat-reachable').length).toBeGreaterThan(0);
    });

    it('plays by keyboard: arrows move a cursor, Enter acts, Tab cycles targets, Escape clears and lets focus leave', () => {
        const { onAction, onTarget } = board();
        const surface = screen.getByTestId('combat-board-surface');
        const leaked: string[] = [];
        const outside = (e: KeyboardEvent) => { leaked.push(e.key); };
        document.addEventListener('keydown', outside);
        surface.focus();
        fireEvent.keyDown(surface, { key: 'ArrowUp' });
        fireEvent.keyDown(surface, { key: 'ArrowRight' });
        expect(screen.getByTestId('combat-cursor').getAttribute('aria-label')).toBe('Square 2, 1: open ground');
        fireEvent.keyDown(surface, { key: 'Enter' });
        expect(onAction).toHaveBeenLastCalledWith({ type: 'move', actorId: 'pc', to: { x: 1, y: 0 } });
        expect(fireEvent.keyDown(surface, { key: 'Tab' })).toBe(false);
        expect(onTarget).toHaveBeenLastCalledWith('e1');
        expect(screen.getByTestId('combat-cursor').getAttribute('aria-label')).toBe('Square 2, 2: open ground. Bandit, Enemy, Unhurt, 1 square away');
        fireEvent.keyDown(surface, { key: 'Enter' });
        expect(onAction).toHaveBeenLastCalledWith({ type: 'attack', actorId: 'pc', targetId: 'e1' });
        fireEvent.keyDown(surface, { key: 'Escape' });
        expect(screen.queryByTestId('combat-cursor')).toBeNull();
        expect(onTarget).toHaveBeenLastCalledWith(null);
        expect(fireEvent.keyDown(surface, { key: 'Tab' })).toBe(true);
        expect(leaked).toEqual(['Tab']);
        document.removeEventListener('keydown', outside);
    });

    it('marks hazard squares with a symbol as well as a tint', () => {
        const s = session();
        s.state.grid!.tiles[3 * 6 + 2] = 'hazard';
        board(s);
        expect(within(surface()).getAllByTestId('combat-hazard-mark')).toHaveLength(1);
    });
});

describe('inspect card', () => {
    it('describes the selected token in the corner opposite it, with why it cannot be attacked', () => {
        board(session(), false, 'e2');
        const card = screen.getByTestId('combat-inspect');
        expect(card.getAttribute('data-corner')).toBe('top-left');
        expect(within(card).getByText('Archer')).toBeInTheDocument();
        expect(within(card).getByText('Enemy · Grunt')).toBeInTheDocument();
        expect(within(card).getByText('Badly hurt')).toBeInTheDocument();
        expect(within(card).getByText('5 squares from you')).toBeInTheDocument();
        expect(within(card).getByTestId('combat-inspect-blocked').textContent).toBe('Cannot be attacked: out of range');
        expect(within(card).queryByText(/^AC/)).toBeNull();
    });

    it('moves to the other corner for a token on the opposite side and shows party AC and HP', () => {
        const near = board(session(), false, 'e1');
        expect(screen.getByTestId('combat-inspect').getAttribute('data-corner')).toBe('bottom-right');
        expect(within(screen.getByTestId('combat-inspect')).getByText('1 square from you')).toBeInTheDocument();
        expect(screen.queryByTestId('combat-inspect-blocked')).toBeNull();
        near.unmount();
        const self = board(session(), false, 'pc');
        const card = screen.getByTestId('combat-inspect');
        expect(card.textContent).toContain('28 / 28 HP');
        expect(card.textContent).toMatch(/AC \d+/);
        expect(card.textContent).not.toContain('from you');
        fireEvent.click(within(card).getByRole('button', { name: 'Close' }));
        expect(self.onTarget).toHaveBeenLastCalledWith(null);
    });

    it('selects a token on click without attacking it when it cannot be hit', () => {
        const { onTarget, onAction } = board();
        fireEvent.click(screen.getByTestId('token-pc'));
        expect(onTarget).toHaveBeenLastCalledWith('pc');
        expect(onAction).not.toHaveBeenCalled();
    });
});

describe('turn focus', () => {
    it('moves focus to the board when the player turn starts, unless the player is typing', () => {
        const typing = render(<input data-testid="field" />);
        const field = screen.getByTestId('field');
        field.focus();
        const onAction = vi.fn();
        const first = session();
        typing.rerender(<><input data-testid="field" /><CombatBoard session={first} busy={false} targetId={null} onTarget={() => {}} onAction={onAction} /></>);
        expect(document.activeElement).toBe(field);
        field.blur();
        const next = session({ turnCount: 2 });
        typing.rerender(<><input data-testid="field" /><CombatBoard session={next} busy={false} targetId={null} onTarget={() => {}} onAction={onAction} /></>);
        expect(document.activeElement).toBe(screen.getByTestId('combat-board-surface'));
    });

    it('does not take focus while the engine is acting', () => {
        board(session(), true);
        expect(document.activeElement).not.toBe(screen.getByTestId('combat-board-surface'));
    });
});

describe('legend', () => {
    it('lists the four terrain kinds and stays collapsed after the first dismissal', () => {
        const first = board();
        const legend = screen.getByTestId('combat-legend');
        for (const name of ['wall', 'cover', 'difficult ground', 'hazard']) expect(within(legend).getByText(name)).toBeInTheDocument();
        fireEvent.click(within(legend).getByRole('button', { name: 'Hide key' }));
        expect(within(screen.getByTestId('combat-legend')).queryByText('wall')).toBeNull();
        first.unmount();
        board();
        const again = screen.getByTestId('combat-legend');
        expect(within(again).queryByText('wall')).toBeNull();
        const toggle = within(again).getByRole('button', { name: 'Map key' });
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        fireEvent.click(toggle);
        expect(within(screen.getByTestId('combat-legend')).getByText('wall')).toBeInTheDocument();
    });

    it('still works when storage is unavailable', () => {
        const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
        const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
        board();
        fireEvent.click(screen.getByRole('button', { name: 'Hide key' }));
        expect(screen.getByRole('button', { name: 'Map key' })).toBeInTheDocument();
        getItem.mockRestore();
        setItem.mockRestore();
    });
});

describe('CombatProposalDialog map preview and stat source', () => {
    const proposal: CombatProposal = {
        id: 'p', messageId: 'gm', reason: 'Wyverns!', source: 'tool', mapSeed: 7,
        map: { size: 'small', features: [{ kind: 'crates', where: 'scattered' }, { kind: 'wall', where: 'centre' }] },
        combatants: [{ name: 'Rathalos', side: 'enemy', tier: 'boss', species: 'Rathalos' }, { name: 'Bandit', side: 'enemy', tier: 'grunt' }],
    };

    const dialog = (onStart = vi.fn()) => render(<CombatProposalDialog proposal={proposal} open onStart={onStart} onDecline={() => {}} onMinimise={() => {}} />);

    it('keeps the layout when the roster changes and rebuilds it only for a new layout or size', () => {
        const onStart = vi.fn();
        dialog(onStart);
        const preview = () => screen.getByTestId('combat-map-preview');
        const first = preview().getAttribute('data-tiles');
        expect(preview().getAttribute('viewBox')).toBe('0 0 100 80');
        fireEvent.click(screen.getByLabelText('Remove Bandit'));
        fireEvent.change(screen.getByLabelText('Tier of Rathalos'), { target: { value: 'legendary' } });
        expect(preview().getAttribute('data-tiles')).toBe(first);
        fireEvent.click(screen.getByText('Start combat', { selector: 'button' }));
        expect(onStart).toHaveBeenLastCalledWith(expect.objectContaining({ mapSeed: 7, map: expect.objectContaining({ size: 'small' }) }));
        fireEvent.change(screen.getByLabelText('Map size'), { target: { value: 'large' } });
        expect(preview().getAttribute('viewBox')).toBe('0 0 180 140');
        const large = preview().getAttribute('data-tiles');
        const random = vi.spyOn(Math, 'random').mockReturnValue(0.123);
        fireEvent.click(screen.getByText('New layout'));
        random.mockRestore();
        expect(preview().getAttribute('data-tiles')).not.toBe(large);
        fireEvent.click(screen.getByText('Start combat', { selector: 'button' }));
        expect(onStart).toHaveBeenLastCalledWith(expect.objectContaining({ mapSeed: Math.floor(0.123 * 0xffffffff), map: expect.objectContaining({ size: 'large' }) }));
    });

    it('names the stat source for each combatant', () => {
        mockState.modTables = { 'mod.enemies.compendium': [{ id: 'r', name: 'Rathalos', aliases: '', stats: [{ name: 'HP', value: '150' }, { name: 'AC', value: '17' }] }] };
        dialog();
        expect(within(screen.getByTestId('combat-source-0')).getByText('Compendium: HP, AC · rest from tier')).toBeInTheDocument();
        expect(screen.getByTestId('combat-source-1').textContent).toBe('Stats from tier');
    });

    it('falls back to the tier label when the enemies mod is disabled', () => {
        mockState.modTables = { 'mod.enemies.compendium': [{ id: 'r', name: 'Rathalos', aliases: '', stats: [{ name: 'HP', value: '150' }] }] };
        mockState.settings = { moduleEnabled: { 'mod.enemies': false } };
        dialog();
        expect(screen.getByTestId('combat-source-0').textContent).toBe('Stats from tier');
    });
});
