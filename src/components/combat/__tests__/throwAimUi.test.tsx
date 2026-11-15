import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { applyAction, buildPcCombatant, freshTurn } from '@narrative/engine';
import type { PcCarriedInput } from '@narrative/engine';
import { CombatScreen } from '../CombatScreen';
import { CombatBoard } from '../CombatBoard';
import { TileAvailabilityContext, tilesFrom } from '../tileAvailability';
import { PixelCatalogContext, buildPixelCatalog } from '../pixelCatalog';
import type { ChatMessage, CombatAction, CombatSession, CombatSheet, CombatState, CombatTile, Combatant } from '../../../types';

const mockState: { settings: Record<string, unknown>; modTables: Record<string, unknown>; messages: ChatMessage[]; context: Record<string, unknown> } = {
    settings: {}, modTables: {}, messages: [], context: {},
};

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

function session(foes: Combatant[], tiles: Array<[number, number, CombatTile]> = [], items: PcCarriedInput[] = [], patch: Partial<CombatState> = {}): CombatSession {
    const pc = { ...buildPcCombatant({ name: 'Kira', sheet, ...(items.length > 0 ? { items } : {}) }), position: { x: 4, y: 4 } };
    const all = [pc, ...foes];
    const grid = { width: 12, height: 8, tiles: new Array<CombatTile>(96).fill('floor'), labels: { wall: 'wall', cover: 'crates', difficult: 'rubble', hazard: 'fire' } };
    for (const [x, y, kind] of tiles) grid.tiles[y * 12 + x] = kind;
    const base: CombatState = {
        id: 'ui', round: 1, order: all.map(c => c.id), turnIndex: 0,
        combatants: Object.fromEntries(all.map(c => [c.id, c])),
        rngSeed: 5, rngCursor: 0, eventSeq: 0, outcome: null, turnCount: 1, grid, ...patch,
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
const surface = () => screen.getByTestId('combat-board-surface');
const status = () => screen.getByTestId('combat-board-status');
const legalTiles = () => screen.queryAllByTestId('combat-aim-legal').map(r => `${r.getAttribute('data-x')},${r.getAttribute('data-y')}`).sort();
const key = (k: string) => fireEvent.keyDown(surface(), { key: k });

function openThrow() {
    fireEvent.click(screen.getByTestId('combat-ability-builtin:throw'));
}

beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    mockState.context = {};
    try { window.localStorage.clear(); } catch { return; }
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('Throw is a two-step aim', () => {
    it('step one highlights liftable payloads and offers an item and whatever is at hand; step two the landing squares', () => {
        const onAct = vi.fn();
        render(<Harness initial={session([npc('DogA', 'enemy', 5, 4)], [[4, 5, 'cover']])} onAct={onAct} />);
        openThrow();
        expect(status()).toHaveTextContent('Throw, step 1 of 2');
        expect(legalTiles()).toEqual(['4,5', '5,4']);
        expect(screen.getByTestId('combat-throw-choices')).toHaveAttribute('aria-label', 'Throw, step 1 of 2: choose what to pick up');
        expect(screen.getByTestId('combat-throw-hand')).toHaveTextContent('Whatever is at hand');
        expect(screen.getByTestId('combat-throw-items')).toBeDisabled();
        fireEvent.mouseEnter(tile(5, 4));
        expect(status()).toHaveTextContent('Lift DogA');
        fireEvent.click(tile(5, 4));
        expect(onAct).not.toHaveBeenCalled();
        fireEvent.mouseLeave(surface());
        expect(status()).toHaveTextContent('Throw, step 2 of 2. Choose where DogA lands');
        expect(screen.getByTestId('combat-throw-choices')).toHaveAttribute('aria-label', 'Throw, step 2 of 2: choose where DogA lands');
        expect(legalTiles()).toContain('7,4');
        expect(legalTiles()).not.toContain('8,4');
        fireEvent.mouseEnter(tile(7, 4));
        const trail = screen.getByTestId('combat-throw');
        expect([trail.getAttribute('data-landing-x'), trail.getAttribute('data-landing-y')]).toEqual(['7', '4']);
        expect(screen.getByTestId('combat-throw-path')).toBeTruthy();
        expect(status()).toHaveTextContent('DogA lands here.');
        fireEvent.click(tile(7, 4));
        expect(onAct).toHaveBeenCalledTimes(1);
        expect(onAct.mock.calls[0][0]).toMatchObject({
            type: 'use_ability', actorId: 'pc', abilityId: 'builtin:throw', aim: { x: 7, y: 4 }, payload: { kind: 'creature', id: 'DogA' },
        });
    });

    it('shows where a creature ends up on an occupied square, and marks a hazard', () => {
        render(<Harness initial={session([npc('DogA', 'enemy', 5, 4), npc('DogB', 'enemy', 7, 4)], [[7, 3, 'hazard'], [6, 4, 'hazard'], [8, 4, 'hazard'], [7, 5, 'hazard']])} />);
        openThrow();
        fireEvent.click(tile(5, 4));
        fireEvent.mouseEnter(tile(7, 4));
        const trail = screen.getByTestId('combat-throw');
        expect(trail.getAttribute('data-displaced')).toBe('true');
        expect(screen.getByTestId('combat-throw-ends')).toBeTruthy();
        expect(status()).toHaveTextContent('lands here and strikes DogB');
        expect(status()).toHaveTextContent('nearest free square');
        fireEvent.mouseEnter(tile(7, 3));
        expect(screen.getByTestId('combat-throw-hazard').getAttribute('data-x')).toBe('7');
        expect(status()).toHaveTextContent('lands in the hazard');
    });

    it('works from the keyboard: Tab and Enter pick a payload and a landing, Escape goes back one step', () => {
        const onAct = vi.fn();
        render(<Harness initial={session([npc('DogA', 'enemy', 5, 4)])} onAct={onAct} />);
        openThrow();
        key('Tab');
        expect(screen.getByTestId('combat-cursor')).toBeTruthy();
        key('Enter');
        expect(screen.getByTestId('combat-throw-choices')).toHaveAttribute('aria-label', expect.stringContaining('step 2 of 2'));
        key('Escape');
        expect(screen.getByTestId('combat-throw-choices')).toHaveAttribute('aria-label', expect.stringContaining('step 1 of 2'));
        expect(status()).toHaveTextContent('Lift DogA');
        key('Enter');
        expect(screen.getByTestId('combat-throw-choices')).toHaveAttribute('aria-label', expect.stringContaining('step 2 of 2'));
        key('Tab');
        key('Enter');
        expect(onAct).toHaveBeenCalledTimes(1);
        const call = onAct.mock.calls[0][0] as CombatAction;
        expect(call).toMatchObject({ type: 'use_ability', abilityId: 'builtin:throw', payload: { kind: 'creature', id: 'DogA' } });
        expect(screen.queryByTestId('combat-aim')).toBeNull();
    });

    it('takes whatever is at hand with W and goes back with the Back button', () => {
        const onAct = vi.fn();
        render(<Harness initial={session([npc('DogA', 'enemy', 9, 4)])} onAct={onAct} />);
        openThrow();
        key('w');
        expect(status()).toHaveTextContent('Throw, step 2 of 2. Choose where something snatched up lands');
        fireEvent.click(screen.getByTestId('combat-throw-back'));
        expect(status()).toHaveTextContent('Throw, step 1 of 2');
        fireEvent.click(screen.getByTestId('combat-throw-hand'));
        fireEvent.click(tile(8, 4));
        expect(onAct.mock.calls[0][0]).toMatchObject({ aim: { x: 8, y: 4 }, payload: { kind: 'hand' } });
    });

    it('lists carried items on I and throws the chosen one', () => {
        const onAct = vi.fn();
        render(<Harness initial={session([npc('DogA', 'enemy', 9, 4)], [], [{ id: 'dagger', name: 'Iron dagger', quality: 'common' }])} onAct={onAct} />);
        openThrow();
        key('i');
        const item = screen.getByTestId('combat-throw-item-dagger');
        expect(item).toHaveTextContent('Iron dagger');
        fireEvent.click(item);
        expect(status()).toHaveTextContent('Choose where Iron dagger lands');
        fireEvent.click(tile(7, 4));
        expect(onAct.mock.calls[0][0]).toMatchObject({ aim: { x: 7, y: 4 }, payload: { kind: 'item', itemId: 'dagger' } });
    });

    it('explains a payload that is too heavy and refuses to start the second step on it', () => {
        render(<Harness initial={session([npc('Brute', 'enemy', 5, 4, { tier: 'elite' })])} />);
        openThrow();
        expect(legalTiles()).toEqual([]);
        fireEvent.mouseEnter(tile(5, 4));
        expect(status()).toHaveTextContent('Too heavy to lift.');
        fireEvent.click(tile(5, 4));
        expect(status()).toHaveTextContent('Too heavy to lift.');
        expect(screen.getByTestId('combat-throw-hand')).toBeTruthy();
    });

    it('says why a thrown ally cannot land on a hazard', () => {
        render(<Harness initial={session([npc('Bram', 'ally', 5, 4)], [[7, 4, 'hazard']])} />);
        openThrow();
        fireEvent.click(tile(5, 4));
        expect(legalTiles()).not.toContain('7,4');
        fireEvent.mouseEnter(tile(7, 4));
        expect(status()).toHaveTextContent('A willing ally cannot be thrown onto a hazard.');
    });
});

const CHAR_ROWS = ['......', '..o...', '......', '......'];

function strip(patch: Partial<CombatState> = {}): CombatSession {
    const pc = { ...buildPcCombatant({ name: 'Kira', sheet }), position: { x: 0, y: 3 } };
    const foe = npc('e1', 'enemy', 5, 3);
    const tiles = CHAR_ROWS.join('').split('').map(ch => (ch === 'o' ? 'cover' : 'floor') as CombatTile);
    const state: CombatState = {
        id: 'b', round: 1, order: ['pc', 'e1'], turnIndex: 0, combatants: { pc, e1: foe },
        rngSeed: 1, rngCursor: 0, eventSeq: 0, outcome: null, turnCount: 1, turn: { actorId: 'pc', moveLeft: 6, actionUsed: false },
        mapSeed: 5, grid: { width: 6, height: 4, tiles, area: 'open', labels: { wall: 'wall', cover: 'crates', difficult: 'rubble', hazard: 'fire' } }, ...patch,
    };
    return { state, log: [], narratedThroughSeq: 0, postedThroughSeq: 0, startedAtMessageId: 'gm', reason: '', map: { place: 'the old tavern' } };
}

const pixelCatalog = buildPixelCatalog({ floor: ['grass-a', 'grass-b'], cover: ['crates@1x1'], wall: ['stone-brick'], difficult: ['rubble'], hazard: ['flames'] });
const painted = tilesFrom({ floor: ['grass', 'wood-planks'], wall: ['stone-brick'], cover: ['crates'], difficult: ['rubble'] });

function withArt(node: ReactNode, art: 'pixel' | 'painted' | 'flat') {
    let out = node;
    if (art !== 'flat') out = <TileAvailabilityContext.Provider value={painted}>{out}</TileAvailabilityContext.Provider>;
    if (art === 'pixel') out = <PixelCatalogContext.Provider value={pixelCatalog}>{out}</PixelCatalogContext.Provider>;
    return out;
}

const drawBoard = (s: CombatSession, art: 'pixel' | 'painted' | 'flat') => render(withArt(<CombatBoard session={s} busy={false} targetId={null} onTarget={() => {}} onAction={() => {}} />, art));
const props = () => [...surface().querySelectorAll('image[data-testid="combat-pixel-prop"]')];
const overlays = () => [...surface().querySelectorAll('image[data-testid="combat-pixel-art"][data-layer="overlay"]')].map(i => `${i.getAttribute('data-x')},${i.getAttribute('data-y')}:${i.getAttribute('data-path')}`);
const markup = () => (surface().querySelector('svg') as SVGSVGElement).outerHTML.replace(/combat-hatch-[A-Za-z0-9_-]+/g, 'combat-hatch');
const edited: Partial<CombatState> = { terrainEdits: [{ pos: { x: 2, y: 1 }, tile: 'floor' }, { pos: { x: 4, y: 2 }, tile: 'difficult' }] };

describe('the board redraws a thrown cover object and the rubble', () => {
    it('painted and flat boards show the removed cover as floor and the landing as difficult ground', () => {
        for (const art of ['painted', 'flat'] as const) {
            const first = drawBoard(strip(), art);
            expect(tile(2, 1).getAttribute('data-tile')).toBe('cover');
            first.unmount();
            const after = drawBoard(strip(edited), art);
            expect(tile(2, 1).getAttribute('data-tile')).toBe('floor');
            expect(tile(4, 2).getAttribute('data-tile')).toBe('difficult');
            expect(tile(3, 1).getAttribute('data-tile')).toBe('floor');
            after.unmount();
        }
    });

    it('a pixel map drops the cover prop, draws the rubble overlay and re-packs the same way every time', () => {
        const before = drawBoard(strip(), 'pixel');
        expect(props().map(p => p.getAttribute('data-path'))).toEqual(['cover/crates@1x1']);
        expect(overlays()).toEqual([]);
        before.unmount();
        const first = drawBoard(strip(edited), 'pixel');
        expect(props()).toHaveLength(0);
        expect(overlays()).toEqual(['4,2:difficult/rubble']);
        const a = markup();
        first.unmount();
        drawBoard(strip(edited), 'pixel');
        expect(markup()).toBe(a);
    });

    it('draws a dropped item on its square and names it', () => {
        const item = { id: 'dagger', name: 'Iron dagger', count: 1, sides: 4, pos: { x: 3, y: 3 }, ownerId: 'pc' };
        drawBoard(strip({ fieldItems: [item] }), 'painted');
        const mark = screen.getByTestId('combat-field-item');
        expect([mark.getAttribute('data-x'), mark.getAttribute('data-y')]).toEqual(['3', '3']);
        expect(mark).toHaveAttribute('aria-label', 'Dropped: Iron dagger');
        fireEvent.mouseEnter(tile(3, 3));
        expect(status()).toHaveTextContent('Iron dagger lies here. Walk over it to pick it up.');
    });
});
