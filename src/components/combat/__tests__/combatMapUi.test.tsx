import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { buildPcCombatant } from '@narrative/engine';
import { CombatBoard } from '../CombatBoard';
import { CombatProposalDialog } from '../CombatProposalDialog';
import type { CombatProposal, CombatSession, CombatSheet, CombatState, CombatTile, Combatant } from '../../../types';

const mockState: Record<string, unknown> = { settings: {}, modTables: {}, context: { currentPlaceId: 'loc' }, locationLedger: [{ id: 'loc', name: 'The old cemetery', description: '' }] };

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

const ROWS = ['......', '..o...', '.~#...', '......'];
const CHAR: Record<string, CombatTile> = { '.': 'floor', o: 'cover', '#': 'wall', '~': 'difficult' };

function session(): CombatSession {
    const pc = { ...buildPcCombatant({ name: 'Kira', sheet }), position: { x: 0, y: 1 } };
    const foe: Combatant = {
        id: 'e1', name: 'Ghoul', side: 'enemy', controller: 'engine', tier: 'grunt',
        abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        maxHp: 10, hp: 10, ac: 11, attackBonus: 3, damage: { count: 1, sides: 6, bonus: 0, type: 'slashing' },
        initiative: 1, status: 'up', conditions: [], position: { x: 4, y: 1 }, range: 'close',
    };
    const state: CombatState = {
        id: 'b', round: 1, order: ['pc', 'e1'], turnIndex: 0, combatants: { pc, e1: foe },
        rngSeed: 1, rngCursor: 0, eventSeq: 0, outcome: null, turnCount: 1, turn: { actorId: 'pc', moveLeft: 6, actionUsed: false },
        grid: {
            width: 6, height: 4, tiles: ROWS.join('').split('').map(ch => CHAR[ch]), area: 'scattered',
            labels: { wall: 'crypt walls', cover: 'tombstones', difficult: 'grave mounds', hazard: 'hazard' },
        },
    };
    return { state, log: [], narratedThroughSeq: 0, postedThroughSeq: 0, startedAtMessageId: 'gm', reason: '' };
}

describe('T5 board labels', () => {
    it('shows the labels in the legend, names terrain on hover and in the inspect card', () => {
        render(<CombatBoard session={session()} busy={false} targetId="e1" onTarget={() => {}} onAction={() => {}} />);
        const legend = screen.getByTestId('combat-legend');
        expect(within(legend).getByText('Cover: tombstones')).toBeInTheDocument();
        expect(within(legend).getByText('Wall: crypt walls')).toBeInTheDocument();
        const surface = screen.getByTestId('combat-board-surface');
        const cover = surface.querySelector('rect[data-x="2"][data-y="1"][data-tile]') as SVGRectElement;
        expect(cover.querySelector('title')?.textContent).toBe('tombstones (cover)');
        fireEvent.mouseEnter(surface.querySelector('rect[data-x="1"][data-y="2"][data-tile]') as SVGRectElement);
        expect(screen.getByTestId('combat-board-status').textContent).toContain('grave mounds (difficult ground)');
        expect(screen.getByTestId('combat-inspect-behind').textContent).toBe('Behind tombstones from you');
    });
});

describe('T5 proposal dialog area and density', () => {
    const proposal: CombatProposal = {
        id: 'p', messageId: 'gm', reason: 'The dead rise.', source: 'tool', mapSeed: 11,
        combatants: [{ name: 'Ghoul', side: 'enemy', tier: 'grunt' }],
    };

    it('infers the area from the location, rebuilds the preview when area or density change and shows the labels', () => {
        const onStart = vi.fn();
        render(<CombatProposalDialog proposal={proposal} open onStart={onStart} onDecline={() => {}} onMinimise={() => {}} />);
        const preview = () => screen.getByTestId('combat-map-preview');
        const area = screen.getByLabelText('Area type') as HTMLSelectElement;
        expect(area.value).toBe('scattered');
        expect(within(screen.getByTestId('combat-preview-key')).getByText('Cover: tombstones')).toBeInTheDocument();
        const first = preview().getAttribute('data-tiles');
        fireEvent.change(screen.getByLabelText('Terrain density'), { target: { value: 'dense' } });
        const dense = preview().getAttribute('data-tiles');
        expect(dense).not.toBe(first);
        fireEvent.change(area, { target: { value: 'cavern' } });
        expect(preview().getAttribute('data-tiles')).not.toBe(dense);
        expect(within(screen.getByTestId('combat-preview-key')).getByText('Difficult ground: rubble')).toBeInTheDocument();
        fireEvent.click(screen.getByText('Start combat', { selector: 'button' }));
        expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ mapSeed: 11, map: expect.objectContaining({ area: 'cavern', density: 'dense', size: 'small' }) }));
    });
});
