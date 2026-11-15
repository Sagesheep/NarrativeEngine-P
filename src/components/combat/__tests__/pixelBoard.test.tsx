import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { buildPcCombatant } from '@narrative/engine';
import { CombatBoard } from '../CombatBoard';
import { CombatProposalDialog } from '../CombatProposalDialog';
import { TileAvailabilityContext, tilesFrom } from '../tileAvailability';
import { PixelCatalogContext, buildPixelCatalog } from '../pixelCatalog';
import type { PixelCatalog, PixelFolder } from '../pixelCatalog';
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

function session(foe = { x: 4, y: 1 }): CombatSession {
    const pc = { ...buildPcCombatant({ name: 'Kira', sheet }), position: { x: 0, y: 1 } };
    const enemy: Combatant = {
        id: 'e1', name: 'Ghoul', side: 'enemy', controller: 'engine', tier: 'grunt',
        abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        maxHp: 10, hp: 10, ac: 11, attackBonus: 3, damage: { count: 1, sides: 6, bonus: 0, type: 'slashing' },
        initiative: 1, status: 'up', conditions: [], position: foe, range: 'close',
    };
    const state: CombatState = {
        id: 'b', round: 1, order: ['pc', 'e1'], turnIndex: 0, combatants: { pc, e1: enemy },
        rngSeed: 1, rngCursor: 0, eventSeq: 0, outcome: null, turnCount: 1, turn: { actorId: 'pc', moveLeft: 6, actionUsed: false },
        mapSeed: 5,
        grid: {
            width: 6, height: 4, tiles: ROWS.join('').split('').map(ch => CHAR[ch]), area: 'open', hazardType: 'fire',
            labels: { wall: 'wall', cover: 'crates', difficult: 'rough ground', hazard: 'fire' },
        },
    };
    return { state, log: [], narratedThroughSeq: 0, postedThroughSeq: 0, startedAtMessageId: 'gm', reason: '', map: { place: 'the old tavern' } };
}

function pixel(extra: Partial<Record<PixelFolder, string[]>> = {}): PixelCatalog {
    return buildPixelCatalog({
        floor: ['grass-a', 'grass-b', 'grass-c'],
        cover: ['crates@1x1'],
        wall: ['cliff'],
        difficult: ['rubble'],
        hazard: ['flames'],
        ...extra,
    });
}

const PAINTED = tilesFrom({ floor: ['grass', 'wood-planks', 'lava'], wall: ['stone-brick'], cover: ['crates'], difficult: ['rubble'] });

function withContexts(catalog: PixelCatalog | null, painted: ReturnType<typeof tilesFrom> | null, node: ReactNode) {
    let out = node;
    if (painted) out = <TileAvailabilityContext.Provider value={painted}>{out}</TileAvailabilityContext.Provider>;
    if (catalog) out = <PixelCatalogContext.Provider value={catalog}>{out}</PixelCatalogContext.Provider>;
    return out;
}

function board(catalog: PixelCatalog | null, painted: ReturnType<typeof tilesFrom> | null = null, s: CombatSession = session(), onAction: () => void = () => {}) {
    return render(withContexts(catalog, painted, <CombatBoard session={s} busy={false} targetId={null} onTarget={() => {}} onAction={onAction} />));
}

const surface = () => screen.getByTestId('combat-board-surface');
const pixelImages = () => [...surface().querySelectorAll('image[data-testid="combat-pixel-art"]')];
const props = () => [...surface().querySelectorAll('image[data-testid="combat-pixel-prop"]')];
const paintedImages = () => [...surface().querySelectorAll('image[data-testid="combat-tile-art"]')];
const svgMarkup = () => (surface().querySelector('svg') as SVGSVGElement).outerHTML.replace(/combat-hatch-[A-Za-z0-9_-]+/g, 'combat-hatch');

beforeEach(() => {
    mockState.context = {};
    try { window.localStorage.clear(); } catch { return; }
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('pixel maps on the board', () => {
    it('draws floor variants, fill, overlays and prop sprites, with pixelated scaling', () => {
        board(pixel(), PAINTED);
        expect(surface().querySelector('[data-testid="combat-tiles"]')?.getAttribute('data-style')).toBe('pixel');
        expect(paintedImages()).toHaveLength(0);
        const floors = pixelImages().filter(i => i.getAttribute('data-layer') === 'floor');
        expect(floors.every(i => /^floor\/grass-[abc]$/.test(i.getAttribute('data-path') ?? ''))).toBe(true);
        expect(floors).toHaveLength(23);
        const fill = pixelImages().filter(i => i.getAttribute('data-layer') === 'fill');
        expect(fill.map(i => [i.getAttribute('data-x'), i.getAttribute('data-y'), i.getAttribute('data-path')])).toEqual([['2', '2', 'wall/cliff']]);
        const overlays = pixelImages().filter(i => i.getAttribute('data-layer') === 'overlay').map(i => i.getAttribute('data-path'));
        expect(overlays).toEqual(['difficult/rubble', 'hazard/flames']);
        expect(props().map(i => i.getAttribute('data-path'))).toEqual(['cover/crates@1x1']);
        expect(props()[0].getAttribute('href')).toBe('/assets/combat/pixel/cover/crates@1x1.png');
        expect(pixelImages().every(i => (i.getAttribute('style') ?? '').includes('image-rendering: pixelated'))).toBe(true);
        expect(props().every(i => (i.getAttribute('style') ?? '').includes('image-rendering: pixelated'))).toBe(true);
        expect(within(surface()).queryByTestId('combat-hazard-mark')).toBeNull();
    });

    it('picks the same variants on every render', () => {
        const first = board(pixel());
        const a = pixelImages().map(i => i.getAttribute('data-path'));
        first.unmount();
        board(pixel());
        expect(pixelImages().map(i => i.getAttribute('data-path'))).toEqual(a);
    });

    it('keeps clicks, hover names and keyboard on the tiles under the art', () => {
        const onAction = vi.fn();
        board(pixel(), null, session(), onAction);
        const cover = surface().querySelector('rect[data-x="2"][data-y="1"][data-tile]') as SVGRectElement;
        expect(cover.querySelector('title')?.textContent).toBe('crates (cover)');
        fireEvent.click(surface().querySelector('rect[data-x="1"][data-y="1"][data-tile]') as SVGRectElement);
        expect(onAction).toHaveBeenCalledWith({ type: 'move', actorId: 'pc', to: { x: 1, y: 1 } });
        expect(surface().querySelectorAll('rect[data-tile][data-x]')).toHaveLength(24);
        expect([...surface().querySelectorAll('image')].every(i => (i as SVGElement).style.pointerEvents === 'none')).toBe(true);
    });

    it('uses a plain marker for kinds with no pixel art, never a painted image', () => {
        board(pixel({ cover: [], difficult: [], hazard: [] }), PAINTED);
        const markers = screen.getAllByTestId('combat-pixel-marker').map(m => m.getAttribute('data-tile')).sort();
        expect(markers).toEqual(['cover', 'difficult', 'hazard']);
        expect(paintedImages()).toHaveLength(0);
    });

    it('draws a map with no pixel floor exactly as the painted board', () => {
        const withoutPixel = board(pixel({ floor: ['snow-a'] }), PAINTED);
        const a = svgMarkup();
        withoutPixel.unmount();
        board(null, PAINTED);
        expect(svgMarkup()).toBe(a);
        expect(paintedImages().length).toBeGreaterThan(0);
        expect(pixelImages()).toHaveLength(0);
    });

    it('forced painted ignores pixel art', () => {
        mockState.context = { combatConfig: { tileStyle: 'painted' } };
        board(pixel(), PAINTED);
        expect(pixelImages()).toHaveLength(0);
        expect(surface().querySelector('[data-style="pixel"]')).toBeNull();
        expect(paintedImages().length).toBeGreaterThan(0);
    });

    it('with the tile art toggle off draws the flat board and remembers it', () => {
        const flat = board(null);
        const before = svgMarkup();
        flat.unmount();
        board(pixel());
        const toggle = screen.getByTestId('combat-tile-art-toggle');
        expect(svgMarkup()).not.toBe(before);
        fireEvent.click(toggle);
        expect(svgMarkup()).toBe(before);
        expect(pixelImages()).toHaveLength(0);
    });

    it('replaces a floor whose image fails to load with the other variants, and falls back to painted when none are left', () => {
        board(pixel({ floor: ['grass-a'] }), PAINTED);
        const first = pixelImages().find(i => i.getAttribute('data-layer') === 'floor') as Element;
        fireEvent.error(first);
        expect(pixelImages()).toHaveLength(0);
        expect(paintedImages().length).toBeGreaterThan(0);
    });

    it('drops a prop whose image fails to load to a marker, leaving no hole', () => {
        board(pixel(), PAINTED);
        fireEvent.error(props()[0]);
        expect(props()).toHaveLength(0);
        expect(screen.getAllByTestId('combat-pixel-marker').map(m => m.getAttribute('data-tile'))).toEqual(['cover']);
    });

    it('anchors a tall prop to the bottom of its footprint and draws it in row order with the tokens', () => {
        board(pixel({ cover: ['crates@1x1+1'] }), null, session({ x: 4, y: 3 }));
        const prop = props()[0];
        expect(prop.getAttribute('x')).toBe('20');
        expect(prop.getAttribute('y')).toBe('0');
        expect(prop.getAttribute('width')).toBe('10');
        expect(prop.getAttribute('height')).toBe('20');
        const depth = screen.getByTestId('combat-depth');
        expect([...depth.children].map(c => c.getAttribute('data-testid'))).toEqual(['combat-pixel-prop', 'token-pc', 'token-e1']);
    });

    it('fades a prop whose raised part covers a token, and not otherwise', () => {
        const idle = (s: CombatSession) => render(withContexts(pixel({ cover: ['crates@1x1+1'] }), null, <CombatBoard session={s} busy targetId={null} onTarget={() => {}} onAction={() => {}} />));
        const covered = idle(session({ x: 2, y: 0 }));
        expect(props()[0].getAttribute('data-faded')).toBe('true');
        expect(Number(props()[0].getAttribute('opacity'))).toBeLessThan(1);
        expect(within(screen.getByTestId('combat-depth')).getByTestId('token-e1')).toBeInTheDocument();
        covered.unmount();
        idle(session({ x: 5, y: 3 }));
        expect(props()[0].getAttribute('data-faded')).toBeNull();
        expect(props()[0].getAttribute('opacity')).toBeNull();
    });

    it('fades a prop whose raised part covers a movement highlight', () => {
        board(pixel({ cover: ['crates@1x1+1'] }), null, session({ x: 5, y: 3 }));
        expect(props()[0].getAttribute('data-faded')).toBe('true');
        expect(surface().querySelector('[data-testid="combat-reachable"][data-x="2"][data-y="0"]')).not.toBeNull();
    });

    it('keeps the grid lines faint, and stronger while a movement path is hovered', () => {
        board(pixel());
        const tiles = surface().querySelector('[data-testid="combat-tiles"]') as Element;
        expect(tiles.getAttribute('data-grid')).toBe('faint');
        const line = surface().querySelector('rect[data-x="1"][data-y="1"][data-tile]') as SVGRectElement;
        expect(line.getAttribute('style')).toContain('stroke-opacity: 0.18');
        fireEvent.mouseEnter(line);
        expect(surface().querySelector('[data-testid="combat-tiles"]')?.getAttribute('data-grid')).toBe('strong');
        expect((surface().querySelector('rect[data-x="1"][data-y="1"][data-tile]') as SVGRectElement).getAttribute('style')).toContain('stroke-opacity: 0.75');
    });

    it('sizes the board to a whole multiple of 32 pixels per tile when the space is known', () => {
        class Observer {
            private readonly callback: (entries: unknown[]) => void;
            constructor(callback: (entries: unknown[]) => void) {
                this.callback = callback;
            }
            observe() {
                this.callback([{ contentRect: { width: 700, height: 500 } }]);
            }
            disconnect() {}
        }
        vi.stubGlobal('ResizeObserver', Observer);
        board(pixel());
        const svg = surface().querySelector('svg') as SVGSVGElement;
        expect(svg.getAttribute('width')).toBe('576');
        expect(svg.getAttribute('height')).toBe('384');
    });

    it('leaves the painted board fluid, with no fixed size', () => {
        board(null, PAINTED);
        const svg = surface().querySelector('svg') as SVGSVGElement;
        expect(svg.getAttribute('width')).toBe('100%');
        expect(svg.getAttribute('height')).toBe('100%');
    });
});

describe('pixel maps in the proposal preview', () => {
    const proposal: CombatProposal = {
        id: 'p', messageId: 'gm', reason: 'Bandits!', source: 'tool', mapSeed: 11,
        combatants: [{ name: 'Bandit', side: 'enemy', tier: 'grunt' }],
    };

    it('uses the same renderer', () => {
        render(withContexts(pixel(), null, <CombatProposalDialog proposal={proposal} open onStart={() => {}} onDecline={() => {}} onMinimise={() => {}} />));
        const preview = screen.getByTestId('combat-map-preview');
        expect(preview.querySelector('[data-testid="combat-tiles"]')?.getAttribute('data-style')).toBe('pixel');
        expect(preview.querySelectorAll('image[data-testid="combat-pixel-art"]').length).toBeGreaterThan(0);
    });
});
