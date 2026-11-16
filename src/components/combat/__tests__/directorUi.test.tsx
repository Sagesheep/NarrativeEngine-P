import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { buildPcCombatant } from '@narrative/engine';
import { CombatBoard } from '../CombatBoard';
import { CombatProposalDialog } from '../CombatProposalDialog';
import { orderBubbles, wrapLine } from '../directorBubbles';
import { TileAvailabilityContext, tilesFrom } from '../tileAvailability';
import { PixelCatalogContext, buildPixelCatalog } from '../pixelCatalog';
import type { CombatEvent, CombatProposal, CombatSession, CombatSheet, CombatState, CombatTile, Combatant } from '../../../types';

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
const ROWS = ['......', '......', '......', '......'];

function unit(id: string, name: string, side: Combatant['side'], x: number, y: number, extra: Partial<Combatant> = {}): Combatant {
    return {
        id, name, side, controller: 'engine', tier: 'grunt',
        abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        maxHp: 10, hp: 10, ac: 11, attackBonus: 3, damage: { count: 1, sides: 6, bonus: 0, type: 'slashing' },
        initiative: 1, status: 'up', conditions: [], position: { x, y }, range: 'close', ...extra,
    };
}

function orderEvent(seq: number, actorId: string, line: string | undefined, round = 2): CombatEvent {
    return { seq, round, turn: 1, type: 'order_given', actorId, data: { kind: 'hold', round, previous: null, ...(line ? { line } : {}) }, text: 'x orders: hold position.' };
}

function session(patch: Partial<CombatState> = {}, log: CombatEvent[] = []): CombatSession {
    const pc = { ...buildPcCombatant({ name: 'Kira', sheet }), position: { x: 0, y: 1 } };
    const tiles = ROWS.join('').split('').map(() => 'floor' as CombatTile);
    const state: CombatState = {
        id: 'd', round: 2, order: ['pc', 'vey', 'thug', 'oro'],
        turnIndex: 0,
        combatants: {
            pc,
            vey: unit('vey', 'Captain Vey', 'enemy', 4, 1, { tier: 'elite' }),
            thug: unit('thug', 'Thug', 'enemy', 4, 2),
            oro: unit('oro', 'Oro', 'enemy', 5, 3, { directed: true }),
        },
        rngSeed: 1, rngCursor: 0, eventSeq: 10, outcome: null,
        grid: { width: 6, height: 4, tiles }, turn: { actorId: 'pc', moveLeft: 6, actionUsed: false }, turnCount: 1,
        ...patch,
    };
    return { state, log, narratedThroughSeq: 0, postedThroughSeq: 0, startedAtMessageId: 'gm', reason: '' };
}

function board(s: CombatSession, wrap: (node: ReactNode) => ReactNode = node => node) {
    return render(wrap(<CombatBoard session={s} busy={false} targetId={null} onTarget={() => {}} onAction={() => {}} />));
}

const PAINTED = tilesFrom({ floor: ['grass', 'wood-planks'], wall: ['stone-brick'], cover: ['crates'], difficult: ['rubble'] });
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
    mockState.settings = {};
    mockState.context = {};
    try { window.localStorage.clear(); } catch { return; }
});

describe('officer badge', () => {
    it.each(MODES)('marks directed units and labels them for screen readers (%s)', (_mode, wrap) => {
        board(session(), wrap);
        const vey = screen.getByTestId('token-vey');
        expect(vey.querySelector('[data-testid="combat-badge-officer"]')).not.toBeNull();
        expect(vey.getAttribute('aria-label')).toMatch(/, Officer$/);
        expect(screen.getByTestId('token-oro').querySelector('[data-testid="combat-badge-officer"]')).not.toBeNull();
        expect(screen.getByTestId('token-thug').querySelector('[data-testid="combat-badge-officer"]')).toBeNull();
        expect(screen.getByTestId('token-pc').querySelector('[data-testid="combat-badge-officer"]')).toBeNull();
        expect(screen.getAllByRole('img', { name: 'Officer' }).length).toBe(2);
    });

    it('does not mark an elite that was made a plain fighter', () => {
        board(session({ combatants: { ...session().state.combatants, vey: unit('vey', 'Captain Vey', 'enemy', 4, 1, { tier: 'elite', directed: false }) } }));
        expect(screen.getByTestId('token-vey').querySelector('[data-testid="combat-badge-officer"]')).toBeNull();
    });
});

describe('speech bubble', () => {
    it('shows the spoken line over the officer for this round until its turn has passed', () => {
        const log = [orderEvent(9, 'vey', 'Hold the line, curs!'), orderEvent(8, 'oro', 'Old line', 1), orderEvent(10, 'thug', undefined)];
        const s = session({}, log);
        expect(orderBubbles(s).map(b => b.id)).toEqual(['vey']);
        board(s);
        const bubble = screen.getByTestId('combat-order-bubble-vey');
        expect(bubble.getAttribute('aria-label')).toBe('Captain Vey says: “Hold the line, curs!”');
        expect(bubble.textContent).toContain('Hold the line, curs!');
        expect(orderBubbles(session({ turnIndex: 2 }, log))).toEqual([]);
        expect(orderBubbles(session({ outcome: 'victory' }, log))).toEqual([]);
    });

    it('is still and plain with effects off, and fades in with effects on', () => {
        const log = [orderEvent(9, 'vey', 'Now!')];
        const { unmount } = board(session({}, log));
        expect(screen.getByTestId('combat-order-bubble-vey').getAttribute('class')).toBeNull();
        unmount();
        mockState.settings = { combatEffects: 'subtle' };
        board(session({}, log));
        expect(screen.getByTestId('combat-order-bubble-vey').getAttribute('class')).toBe('combat-order-bubble');
    });

    it('wraps a long line into at most three lines', () => {
        const lines = wrapLine('You will not leave this hall alive, not one of you, not while I still stand and breathe and hold this blade');
        expect(lines).toHaveLength(3);
        expect(lines.every(l => l.length <= 30)).toBe(true);
        expect(lines[2].endsWith('…')).toBe(true);
        expect(wrapLine('Short.')).toEqual(['Short.']);
    });
});

describe('officer checkbox in the start dialog', () => {
    const proposal: CombatProposal = {
        id: 'p', messageId: 'gm', reason: 'Ambush', source: 'manual',
        combatants: [
            { name: 'Captain Vey', side: 'enemy', tier: 'elite' },
            { name: 'Thug', side: 'enemy', tier: 'grunt' },
            { name: 'Pilgrim', side: 'neutral', tier: 'grunt' },
            { name: 'Marta', side: 'ally', tier: 'grunt', npcId: 'npc-marta' },
        ],
    };

    it('shows who is an officer, lets the player change it, and passes it to the start', () => {
        const onStart = vi.fn();
        render(<CombatProposalDialog proposal={proposal} open onStart={onStart} onDecline={() => {}} onMinimise={() => {}} />);
        const vey = screen.getByLabelText('Captain Vey is an officer') as HTMLInputElement;
        const thug = screen.getByLabelText('Thug is an officer') as HTMLInputElement;
        expect(vey.checked).toBe(true);
        expect(thug.checked).toBe(false);
        expect((screen.getByLabelText('Marta is an officer') as HTMLInputElement).checked).toBe(true);
        expect(screen.queryByLabelText('Pilgrim is an officer')).toBeNull();
        fireEvent.click(vey);
        fireEvent.click(thug);
        fireEvent.click(screen.getByRole('button', { name: /start/i }));
        const started = onStart.mock.calls[0][0] as CombatProposal;
        expect(started.combatants.find(c => c.name === 'Captain Vey')?.officer).toBe(false);
        expect(started.combatants.find(c => c.name === 'Thug')?.officer).toBe(true);
    });
});
