import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { buildPcCombatant } from '@narrative/engine';
import { CombatBoard } from '../CombatBoard';
import { CombatObjectiveBanner } from '../CombatObjectiveBanner';
import { CombatInitiativeStrip } from '../CombatInitiativeStrip';
import { CombatProposalDialog } from '../CombatProposalDialog';
import { TileAvailabilityContext, tilesFrom } from '../tileAvailability';
import { PixelCatalogContext, buildPixelCatalog } from '../pixelCatalog';
import type { CombatObjective, CombatProposal, CombatSession, CombatSheet, CombatState, CombatTile, Combatant } from '../../../types';

const mockState: Record<string, unknown> = { settings: {}, modTables: {}, context: {}, locationLedger: [] };

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

function unit(id: string, name: string, side: Combatant['side'], x: number, y: number, extra: Partial<Combatant> = {}): Combatant {
    return {
        id, name, side, controller: 'engine', tier: 'grunt',
        abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        maxHp: 10, hp: 10, ac: 11, attackBonus: 3, damage: { count: 1, sides: 6, bonus: 0, type: 'slashing' },
        initiative: 1, status: 'up', conditions: [], position: { x, y }, range: 'close', ...extra,
    };
}

const OBJECTIVE: CombatObjective = {
    win: { kind: 'protect', wardId: 'w', with: { kind: 'escape', exits: [{ x: 5, y: 0 }], everyone: false } },
    lose: [{ kind: 'ward_falls', wardId: 'w' }, { kind: 'round_limit' }, { kind: 'leader_escapes', leaderId: 'boss', exits: [{ x: 0, y: 3 }] }],
    roundLimit: 6,
    side: { kind: 'reach_tile', tile: { x: 3, y: 3 } },
};

function session(patch: Partial<CombatState> = {}, objective: CombatObjective | null = OBJECTIVE): CombatSession {
    const pc = { ...buildPcCombatant({ name: 'Kira', sheet }), position: { x: 0, y: 1 } };
    const tiles = ROWS.join('').split('').map(ch => (ch === '#' ? 'wall' : 'floor') as CombatTile);
    const incoming = unit('r1', 'Raider', 'enemy', 5, 3, { status: 'gone' });
    const state: CombatState = {
        id: 'o', round: 2, order: ['pc', 'w', 'boss', 'by'],
        turnIndex: 0,
        combatants: {
            pc,
            w: unit('w', 'Mara', 'ally', 1, 1, { mark: 'ward' }),
            boss: unit('boss', 'Vey', 'enemy', 4, 1, { mark: 'leader' }),
            by: unit('by', 'Pilgrim', 'neutral', 3, 0, { mark: 'bystander' }),
        },
        rngSeed: 1, rngCursor: 0, eventSeq: 0, outcome: null,
        grid: { width: 6, height: 4, tiles }, turn: { actorId: 'pc', moveLeft: 6, actionUsed: false }, turnCount: 1,
        ...(objective ? { objective } : {}),
        ...(objective ? { reinforcements: { budget: 2, waves: [{ id: 'r1', trigger: { kind: 'round' as const, round: 3 }, edge: 'far' as const, units: [incoming], arriveRound: 3, tiles: [{ x: 5, y: 3 }] }] } } : {}),
        ...patch,
    };
    return { state, log: [], narratedThroughSeq: 0, postedThroughSeq: 0, startedAtMessageId: 'gm', reason: '' };
}

const surface = () => screen.getByTestId('combat-board-surface');

function board(s: CombatSession, wrap: (node: ReactNode) => ReactNode = node => node) {
    return render(wrap(<CombatBoard session={s} busy={false} targetId={null} onTarget={() => {}} onAction={() => {}} />));
}

const PAINTED = tilesFrom({ floor: ['grass', 'wood-planks', 'lava'], wall: ['stone-brick'], cover: ['crates'], difficult: ['rubble'] });
const PIXEL = buildPixelCatalog({ floor: ['grass-a', 'grass-b'], cover: ['crates@1x1'], wall: ['cliff'], difficult: ['rubble'], hazard: ['flames'] });

const MODES: Array<[string, (node: ReactNode) => ReactNode]> = [
    ['flat', node => node],
    ['painted', node => <TileAvailabilityContext.Provider value={PAINTED}>{node}</TileAvailabilityContext.Provider>],
    ['pixel', node => (
        <PixelCatalogContext.Provider value={PIXEL}>
            <TileAvailabilityContext.Provider value={PAINTED}>{node}</TileAvailabilityContext.Provider>
        </PixelCatalogContext.Provider>
    )],
];

beforeEach(() => {
    mockState.context = {};
    try { window.localStorage.clear(); } catch { return; }
});

describe('the objective banner', () => {
    it('states the win, the lose conditions, the side aim and the clock in plain words', () => {
        render(<CombatObjectiveBanner state={session().state} />);
        const banner = screen.getByTestId('combat-objective');
        expect(within(banner).getByTestId('combat-objective-win').textContent).toBe('Get out through the exit, and keep Mara alive');
        expect(within(banner).getByTestId('combat-objective-lose').textContent).toBe('Lost if: Mara falls, time runs out after round 6, Vey gets away');
        expect(within(banner).getByTestId('combat-objective-side').textContent).toBe('Bonus: reach the marked spot');
        expect(within(banner).getByTestId('combat-objective-clock').textContent).toBe('Rounds left: 5');
        expect(within(banner).getByTestId('combat-objective-incoming').textContent).toBe('Reinforcements arrive in round 3');
    });

    it('shows the last round', () => {
        render(<CombatObjectiveBanner state={session({ round: 6 }).state} />);
        expect(screen.getByTestId('combat-objective-clock').textContent).toBe('Last round');
    });

    it('describes each win kind', () => {
        const kinds: Array<[CombatObjective['win'], string]> = [
            [{ kind: 'defeat_leader', leaderId: 'boss' }, 'Defeat Vey; the rest will break'],
            [{ kind: 'survive', rounds: 5 }, 'Hold out for 5 rounds'],
            [{ kind: 'escape', exits: [{ x: 5, y: 0 }], everyone: true }, 'Get everyone out through the exit'],
            [{ kind: 'seize', tile: { x: 3, y: 3 } }, 'Take the marked square and hold it for a full turn'],
            [{ kind: 'protect', wardId: 'w', rounds: 4 }, 'Keep Mara alive for 4 rounds'],
        ];
        for (const [win, text] of kinds) {
            const { unmount } = render(<CombatObjectiveBanner state={session({}, { win }).state} />);
            expect(screen.getByTestId('combat-objective-win').textContent).toBe(text);
            unmount();
        }
    });

    it('reports how the fight ended and whether the side aim was met', () => {
        const ended = { ...OBJECTIVE, result: { status: 'won' as const, by: 'escape' as const, round: 4, outcome: 'victory' as const, side: { kind: 'reach_tile' as const, met: false } } };
        render(<CombatObjectiveBanner state={session({ outcome: 'victory' }, ended).state} />);
        expect(screen.getByTestId('combat-objective-result').textContent).toBe('Objective achieved');
        expect(screen.getByTestId('combat-objective-side').textContent).toContain('(missed)');
        expect(screen.queryByTestId('combat-objective-clock')).toBeNull();
    });

    it('lists who got out', () => {
        const progress = { ...OBJECTIVE, progress: { escaped: ['w'] } };
        render(<CombatObjectiveBanner state={session({}, progress).state} />);
        expect(screen.getByTestId('combat-objective-out').textContent).toBe('Out: Mara');
    });

    it('is absent for a plain rout and when there is no objective', () => {
        const plain = render(<CombatObjectiveBanner state={session({}, { win: { kind: 'rout' } }).state} />);
        expect(plain.container.firstChild).toBeNull();
        plain.unmount();
        const none = render(<CombatObjectiveBanner state={session({}, null).state} />);
        expect(none.container.firstChild).toBeNull();
    });
});

describe.each(MODES)('board markers in the %s style', (_name, wrap) => {
    it('marks the exits, the seize and reach tiles and the incoming wave with screen reader labels', () => {
        board(session(), wrap);
        const marks = within(surface()).getByTestId('combat-objective-marks');
        expect(within(marks).getAllByTestId('combat-mark-exit').map(m => m.getAttribute('aria-label'))).toEqual(['Exit']);
        expect(within(marks).getByTestId('combat-mark-leaderExit').getAttribute('aria-label')).toBe('Exit the enemy leader is heading for');
        expect(within(marks).getByTestId('combat-mark-reach').getAttribute('aria-label')).toBe('Marked spot to reach');
        const incoming = within(marks).getByTestId('combat-mark-incoming');
        expect(incoming.getAttribute('aria-label')).toBe('Reinforcements arrive here in round 3');
        expect([incoming.getAttribute('data-x'), incoming.getAttribute('data-y')]).toEqual(['5', '3']);
        expect(within(marks).getByTestId('combat-mark-exit').getAttribute('role')).toBe('img');
    });

    it('marks the seize tile', () => {
        const seize = { win: { kind: 'seize' as const, tile: { x: 3, y: 3 } } };
        board(session({}, seize), wrap);
        expect(within(surface()).getByTestId('combat-mark-seize').getAttribute('aria-label')).toBe('Marked square to take and hold');
    });

    it('badges the leader, the ward and the bystander and names the role in the token label', () => {
        board(session(), wrap);
        expect(within(surface()).getByTestId('combat-badge-leader')).toBeTruthy();
        expect(within(surface()).getByTestId('combat-badge-ward')).toBeTruthy();
        expect(within(surface()).getByTestId('combat-badge-bystander')).toBeTruthy();
        expect(screen.getByTestId('token-boss').getAttribute('aria-label')).toContain('enemy leader');
        expect(screen.getByTestId('token-w').getAttribute('aria-label')).toContain('ward, keep alive');
        expect(screen.getByTestId('token-by').getAttribute('aria-label')).toContain('bystander, keep safe');
        expect(screen.getByTestId('token-pc').getAttribute('aria-label')).not.toContain('keep');
    });

    it('draws no objective layer and no badge without an objective', () => {
        const plain = session({}, null);
        const { w, boss, by } = plain.state.combatants;
        const stripped = { ...plain, state: { ...plain.state, combatants: { ...plain.state.combatants, w: { ...w, mark: undefined }, boss: { ...boss, mark: undefined }, by: { ...by, mark: undefined } } } };
        board(stripped, wrap);
        expect(within(surface()).queryByTestId('combat-objective-marks')).toBeNull();
        expect(within(surface()).queryByTestId('combat-badge-leader')).toBeNull();
    });

    it('says what a marked tile is when the keyboard cursor reaches it', () => {
        board(session(), wrap);
        surface().focus();
        for (let i = 0; i < 3; i++) fireEvent.keyDown(surface(), { key: 'ArrowRight' });
        for (let i = 0; i < 2; i++) fireEvent.keyDown(surface(), { key: 'ArrowDown' });
        expect(screen.getByTestId('combat-board-status').textContent).toContain('Marked spot to reach');
    });
});

describe('units that left through an exit', () => {
    it('are not drawn on the board and read as escaped in the order strip', () => {
        const s = session();
        const out = { ...s.state.combatants.w, status: 'escaped' as const, position: undefined };
        const escaped = { ...s, state: { ...s.state, combatants: { ...s.state.combatants, w: out } } };
        board(escaped);
        expect(screen.queryByTestId('token-w')).toBeNull();
        render(<CombatInitiativeStrip session={escaped} busy={false} selectedId={null} onSelect={() => {}} onEnd={() => {}} />);
        expect(screen.getByTestId('combatant-w').textContent).toContain('Escaped');
    });
});

describe('the start dialog objective controls', () => {
    const proposal: CombatProposal = {
        id: 'p', messageId: 'm', source: 'manual', reason: 'Holding the bridge',
        combatants: [{ name: 'Captain Vey', side: 'enemy', tier: 'elite' }, { name: 'Bandit', side: 'enemy', tier: 'grunt' }, { name: 'Mara', side: 'ally', tier: 'grunt' }],
    };
    const dialog = (p: CombatProposal = proposal, onStart = vi.fn()) => {
        render(<CombatProposalDialog proposal={p} open onStart={onStart} onDecline={() => {}} onMinimise={() => {}} />);
        return onStart;
    };
    const pick = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

    it('starts a plain fight with no objective by default', () => {
        const onStart = dialog();
        fireEvent.click(screen.getByRole('button', { name: /start combat/i }));
        expect(onStart.mock.calls[0][0].objective).toBeUndefined();
        expect((screen.getByTestId('combat-objective-reinforcements') as HTMLSelectElement).disabled).toBe(true);
    });

    it('offers a leader choice for defeat the leader', () => {
        const onStart = dialog();
        pick('combat-objective-kind', 'defeat_leader');
        const leader = screen.getByTestId('combat-objective-leader') as HTMLSelectElement;
        expect([...leader.options].map(o => o.textContent)).toEqual(['Strongest enemy', 'Captain Vey', 'Bandit']);
        pick('combat-objective-leader', 'Captain Vey');
        fireEvent.click(screen.getByRole('button', { name: /start combat/i }));
        expect(onStart.mock.calls[0][0].objective).toEqual({ win: 'defeat_leader', leader: 'Captain Vey' });
    });

    it('offers the allies as wards and adds a new one when none is chosen', () => {
        const onStart = dialog();
        pick('combat-objective-kind', 'protect');
        const ward = screen.getByTestId('combat-objective-ward') as HTMLSelectElement;
        expect([...ward.options].map(o => o.textContent)).toEqual(['New ally (added at start)', 'Mara']);
        pick('combat-objective-reinforcements', 'some');
        fireEvent.click(screen.getByRole('button', { name: /start combat/i }));
        const started = onStart.mock.calls[0][0] as CombatProposal;
        expect(started.objective).toEqual({ win: 'protect', ward: 'Ward', reinforcements: 'some' });
        expect(started.combatants.find(c => c.name === 'Ward')).toMatchObject({ side: 'ally', tier: 'grunt', included: true });
    });

    it('keeps a chosen ally as the ward and does not add another', () => {
        const onStart = dialog();
        pick('combat-objective-kind', 'protect');
        pick('combat-objective-ward', 'Mara');
        fireEvent.click(screen.getByRole('button', { name: /start combat/i }));
        const started = onStart.mock.calls[0][0] as CombatProposal;
        expect(started.objective?.ward).toBe('Mara');
        expect(started.combatants).toHaveLength(3);
    });

    it('takes a side aim and a bystander', () => {
        const onStart = dialog();
        pick('combat-objective-side-kind', 'save_bystander');
        expect(screen.getByTestId('combat-objective-bystander')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: /start combat/i }));
        const started = onStart.mock.calls[0][0] as CombatProposal;
        expect(started.objective).toEqual({ win: 'rout', side: 'save_bystander', bystander: 'Bystander' });
        expect(started.combatants.find(c => c.name === 'Bystander')).toMatchObject({ side: 'neutral' });
    });

    it('shows what the model asked for and lets the player change it', () => {
        const onStart = dialog({ ...proposal, objective: { win: 'survive', rounds: 4 } });
        expect((screen.getByTestId('combat-objective-kind') as HTMLSelectElement).value).toBe('survive');
        pick('combat-objective-kind', 'escape');
        fireEvent.click(screen.getByLabelText('Everyone must leave'));
        fireEvent.click(screen.getByLabelText('Time runs out'));
        fireEvent.click(screen.getByRole('button', { name: /start combat/i }));
        expect(onStart.mock.calls[0][0].objective).toEqual({ win: 'escape', everyone: true, lose: ['round_limit'] });
    });
});
