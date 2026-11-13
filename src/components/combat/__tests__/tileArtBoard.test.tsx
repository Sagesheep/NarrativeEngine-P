import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { buildPcCombatant } from '@narrative/engine';
import { CombatBoard } from '../CombatBoard';
import { CombatProposalDialog } from '../CombatProposalDialog';
import { TileAvailabilityContext, tilesFrom } from '../tileAvailability';
import type { TileAvailability } from '../tileAvailability';
import type { CombatProposal, CombatSession, CombatSheet, CombatState, CombatTile, Combatant } from '../../../types';

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
const ROWS = ['......', '..o...', '.~#!..', '......'];
const CHAR: Record<string, CombatTile> = { '.': 'floor', o: 'cover', '#': 'wall', '~': 'difficult', '!': 'hazard' };

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
        mapSeed: 5,
        grid: {
            width: 6, height: 4, tiles: ROWS.join('').split('').map(ch => CHAR[ch]), area: 'open', hazardType: 'fire',
            labels: { wall: 'wall', cover: 'crates', difficult: 'rough ground', hazard: 'fire' },
        },
    };
    return { state, log: [], narratedThroughSeq: 0, postedThroughSeq: 0, startedAtMessageId: 'gm', reason: '', map: { place: 'the old tavern' } };
}

const ALL = tilesFrom({ floor: ['grass', 'wood-planks', 'lava'], wall: ['stone-brick'], cover: ['crates'], difficult: ['rubble'] });

function withTiles(tiles: TileAvailability | null, node: ReactNode) {
    return tiles ? <TileAvailabilityContext.Provider value={tiles}>{node}</TileAvailabilityContext.Provider> : node;
}

function board(tiles: TileAvailability | null) {
    return render(withTiles(tiles, <CombatBoard session={session()} busy={false} targetId={null} onTarget={() => {}} onAction={() => {}} />));
}

const surface = () => screen.getByTestId('combat-board-surface');
const images = () => [...surface().querySelectorAll('image[data-testid="combat-tile-art"]')];
const imageAt = (x: number, y: number, path: string) => images().find(i => i.getAttribute('data-x') === `${x}` && i.getAttribute('data-y') === `${y}` && i.getAttribute('data-path') === path);
const svgMarkup = () => (surface().querySelector('svg') as SVGSVGElement).outerHTML.replace(/combat-hatch-[A-Za-z0-9_-]+/g, 'combat-hatch');

beforeEach(() => {
    try { window.localStorage.clear(); } catch { return; }
});

describe('tile art on the board', () => {
    it('draws floor, wall, cover, difficult and hazard art in layers, with the place choosing the floor', () => {
        board(ALL);
        expect(surface().querySelector('[data-testid="combat-tiles"]')?.getAttribute('data-art')).toBe('on');
        expect(imageAt(0, 0, 'floor/wood-planks')?.getAttribute('href')).toBe('/assets/combat/tiles/floor/wood-planks.png');
        expect(imageAt(2, 2, 'wall/stone-brick')).toBeDefined();
        expect(imageAt(2, 2, 'floor/wood-planks')).toBeUndefined();
        expect(within(screen.getByTestId('combat-art-cover')).getAllByTestId('combat-tile-art').map(i => i.getAttribute('data-path'))).toEqual(['cover/crates']);
        const ground = within(screen.getByTestId('combat-art-ground')).getAllByTestId('combat-tile-art').map(i => i.getAttribute('data-path'));
        expect(ground).toEqual(['difficult/rubble', 'floor/lava']);
        expect(screen.getAllByTestId('combat-hazard-outline')).toHaveLength(1);
        expect(within(surface()).queryByTestId('combat-hazard-mark')).toBeNull();
        expect(surface().querySelectorAll('rect[data-tile]')).toHaveLength(24);
        expect(screen.getAllByTestId('combat-token-ring')).toHaveLength(2);
        expect(images().every(i => (i as SVGElement).style.pointerEvents === 'none')).toBe(true);
    });

    it('keeps hover names and clicks on the tiles under the art', () => {
        const onAction = vi.fn();
        render(withTiles(ALL, <CombatBoard session={session()} busy={false} targetId={null} onTarget={() => {}} onAction={onAction} />));
        const cover = surface().querySelector('rect[data-x="2"][data-y="1"][data-tile]') as SVGRectElement;
        expect(cover.querySelector('title')?.textContent).toBe('crates (cover)');
        fireEvent.click(surface().querySelector('rect[data-x="1"][data-y="1"][data-tile]') as SVGRectElement);
        expect(onAction).toHaveBeenCalledWith({ type: 'move', actorId: 'pc', to: { x: 1, y: 1 } });
    });

    it('falls back to the flat fill and cues for each kind without art', () => {
        board(tilesFrom({ floor: ['grass'] }));
        const flat = screen.getAllByTestId('combat-tile-flat').map(g => g.getAttribute('data-tile'));
        expect(flat.sort()).toEqual(['cover', 'difficult', 'hazard', 'wall']);
        expect(within(surface()).getByTestId('combat-hazard-mark')).toBeInTheDocument();
        expect(images().every(i => i.getAttribute('data-path') === 'floor/grass')).toBe(true);
        expect(images()).toHaveLength(20);
    });

    it('replaces an image that fails to load with the next choice or flat colour, leaving no hole', () => {
        board(ALL);
        fireEvent.error(imageAt(2, 1, 'cover/crates') as Element);
        expect(images().some(i => i.getAttribute('data-path') === 'cover/crates')).toBe(false);
        expect(screen.getAllByTestId('combat-tile-flat').map(g => g.getAttribute('data-tile'))).toEqual(['cover']);
        fireEvent.error(imageAt(0, 0, 'floor/wood-planks') as Element);
        expect(imageAt(0, 0, 'floor/grass')).toBeDefined();
        fireEvent.error(imageAt(0, 0, 'floor/grass') as Element);
        expect(images().some(i => i.getAttribute('data-path')?.startsWith('floor/') && i.getAttribute('data-tile') === 'floor')).toBe(false);
        const plain = surface().querySelectorAll('[data-testid="combat-art-base"] > rect');
        expect(plain.length).toBeGreaterThan(0);
    });

    it('with the toggle off draws exactly what the board draws without art, and remembers it', () => {
        const { unmount } = board(null);
        const before = svgMarkup();
        expect(screen.queryByTestId('combat-tile-art-toggle')).toBeNull();
        unmount();
        board(ALL);
        const toggle = screen.getByTestId('combat-tile-art-toggle');
        expect(toggle.textContent).toBe('Tile art');
        expect(toggle.getAttribute('aria-pressed')).toBe('true');
        expect(svgMarkup()).not.toBe(before);
        fireEvent.click(toggle);
        expect(toggle.getAttribute('aria-pressed')).toBe('false');
        expect(svgMarkup()).toBe(before);
        expect(window.localStorage.getItem('nn_combat_tile_art')).toBe('off');
    });

    it('starts with the art off when that was remembered', () => {
        window.localStorage.setItem('nn_combat_tile_art', 'off');
        board(ALL);
        expect(images()).toHaveLength(0);
        expect(screen.getByTestId('combat-tile-art-toggle').getAttribute('aria-pressed')).toBe('false');
    });

    it('draws the board as before with no tiles available', () => {
        board(tilesFrom({}));
        expect(surface().querySelector('[data-art]')).toBeNull();
        expect(images()).toHaveLength(0);
        expect(screen.queryByTestId('combat-tile-art-toggle')).toBeNull();
        expect(screen.queryByTestId('combat-token-ring')).toBeNull();
    });
});

describe('tile art in the proposal preview', () => {
    const proposal: CombatProposal = {
        id: 'p', messageId: 'gm', reason: 'Bandits!', source: 'tool', mapSeed: 11,
        combatants: [{ name: 'Bandit', side: 'enemy', tier: 'grunt' }],
    };

    it('uses the same renderer with art', () => {
        render(withTiles(ALL, <CombatProposalDialog proposal={proposal} open onStart={() => {}} onDecline={() => {}} onMinimise={() => {}} />));
        const preview = screen.getByTestId('combat-map-preview');
        expect(preview.querySelector('[data-testid="combat-tiles"]')?.getAttribute('data-art')).toBe('on');
        expect(preview.querySelectorAll('image[data-testid="combat-tile-art"]').length).toBeGreaterThan(0);
    });

    it('stays flat without tiles', () => {
        render(<CombatProposalDialog proposal={proposal} open onStart={() => {}} onDecline={() => {}} onMinimise={() => {}} />);
        expect(screen.getByTestId('combat-map-preview').querySelector('image')).toBeNull();
    });
});
