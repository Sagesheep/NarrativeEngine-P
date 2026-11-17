import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { buildPcCombatant } from '@narrative/engine';
import type { PlacedEffect } from '@narrative/engine';
import { CombatBoard } from '../CombatBoard';
import { CombatProposalDialog } from '../CombatProposalDialog';
import { AimOverlay } from '../abilityOverlays';
import { PlacedLayer } from '../PlacedLayer';
import { placedViews } from '../placedView';
import { TileAvailabilityContext, tilesFrom } from '../tileAvailability';
import { PixelCatalogContext, buildPixelCatalog } from '../pixelCatalog';
import type { AbilityAim } from '../useAbilityAim';
import { t } from '../../../i18n';
import type { CombatProposal, CombatSession, CombatSheet, CombatState, CombatTile, Combatant, GlyphAbility } from '../../../types';

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

function unit(id: string, name: string, side: Combatant['side'], x: number, y: number, extra: Partial<Combatant> = {}): Combatant {
    return {
        id, name, side, controller: 'engine', tier: 'grunt',
        abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        maxHp: 10, hp: 10, ac: 11, attackBonus: 3, damage: { count: 1, sides: 6, bonus: 0, type: 'slashing' },
        initiative: 1, status: 'up', conditions: [], position: { x, y }, range: 'close', ...extra,
    };
}

function placed(id: string, kind: PlacedEffect['kind'], ownerId: string, side: PlacedEffect['side'], tiles: Array<{ x: number; y: number }>, extra: Partial<PlacedEffect> = {}): PlacedEffect {
    return { id, kind, ownerId, side, name: `${kind} spell`, trigger: kind === 'mark' || kind === 'sigil' ? 'enter' : 'turn_start', tiles, placedRound: 1, expiresRound: 4, ...extra };
}

const PLACED: PlacedEffect[] = [
    placed('p1', 'mark', 'pc', 'player', [{ x: 2, y: 3 }, { x: 3, y: 3 }], { mark: 'flames', element: 'fire', name: 'Flare' }),
    placed('p2', 'sigil', 'pc', 'player', [{ x: 1, y: 3 }], { name: 'Snap Trap', element: 'ice' }),
    placed('p3', 'sigil', 'boss', 'enemy', [{ x: 9, y: 0 }], { name: 'Hidden Rune' }),
    placed('p4', 'mantle', 'boss', 'enemy', [], { radius: 1, name: 'Ember Cloak', element: 'lava' }),
    placed('p5', 'delay', 'pc', 'player', [{ x: 5, y: 3 }], { name: 'Slow Fuse', trigger: 'owner_turn_start' }),
    placed('p6', 'wall', 'boss', 'enemy', [{ x: 7, y: 3 }], { name: 'Bulwark', element: 'earth' }),
];

function session(patch: Partial<CombatState> = {}): CombatSession {
    const pc = { ...buildPcCombatant({ name: 'Kira', sheet }), position: { x: 0, y: 1 } };
    const tiles = new Array(40).fill('floor') as CombatTile[];
    const state: CombatState = {
        id: 'e', round: 2, order: ['pc', 'boss'], turnIndex: 0,
        combatants: {
            pc,
            boss: unit('boss', 'Vey', 'enemy', 6, 1, { weak: ['water'], resist: ['fire'], immune: ['mental'], mindless: true }),
        },
        rngSeed: 1, rngCursor: 0, eventSeq: 0, outcome: null,
        grid: { width: 10, height: 4, tiles }, turn: { actorId: 'pc', moveLeft: 6, actionUsed: false }, turnCount: 1,
        ...patch,
    };
    return { state, log: [], narratedThroughSeq: 0, postedThroughSeq: 0, startedAtMessageId: 'gm', reason: '' };
}

function board(s: CombatSession, wrap: (node: ReactNode) => ReactNode = node => node, targetId: string | null = null) {
    return render(wrap(<CombatBoard session={s} busy={false} targetId={targetId} onTarget={() => {}} onAction={() => {}} />));
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
    mockState.settings = {};
    try { window.localStorage.clear(); } catch { return; }
});

describe('placed effects and tile marks on the board (H3)', () => {
    it.each(MODES)('draws marks, sigils, the mantle, the wall and the delay with screen reader labels (%s)', (_mode, wrap) => {
        board(session({ placed: PLACED, barriers: [{ pos: { x: 7, y: 3 }, expiresRound: 4, sourceId: 'boss' }] }), wrap);
        const layer = screen.getByTestId('combat-placed');
        const label = (id: string) => within(layer).getByTestId(id).getAttribute('aria-label');
        expect(label('combat-placed-mark')).toBe('Flames on 2 squares, 2 rounds left');
        expect(within(layer).getAllByTestId('combat-mark-tile').map(n => n.getAttribute('data-mark'))).toEqual(['flames', 'flames']);
        expect(within(layer).getAllByTestId('combat-placed-sigil')).toHaveLength(1);
        expect(within(layer).getByTestId('combat-placed-sigil').getAttribute('aria-label')).toBe('Sigil of Kira (Snap Trap), 2 rounds left');
        expect(label('combat-placed-mantle')).toBe('Mantle of Vey (Ember Cloak), 2 rounds left');
        expect(within(layer).getByTestId('combat-mantle-zone')).toHaveAttribute('data-radius', '1');
        expect(label('combat-placed-delay')).toBe('Slow Fuse of Kira goes off here at the start of their next turn');
        expect(label('combat-placed-wall')).toBe('Wall of Vey (Bulwark), 2 rounds left');
        expect(within(layer).getByTestId('combat-placed-mark').getAttribute('role')).toBe('img');
    });

    it('shows a foe\'s sigil only once a party member can see it', () => {
        const hidden = session({ placed: PLACED });
        expect(placedViews(hidden.state, t).some(v => v.id === 'p3')).toBe(false);
        const near = session({ placed: PLACED });
        near.state.combatants.pc = { ...near.state.combatants.pc, position: { x: 8, y: 1 } };
        expect(placedViews(near.state, t).some(v => v.id === 'p3')).toBe(true);
    });

    it('draws nothing new for a fight without placed effects', () => {
        board(session());
        expect(screen.queryByTestId('combat-placed')).toBeNull();
    });

    it('animates only when the effects setting allows it', () => {
        const views = placedViews(session({ placed: PLACED }).state, t);
        const { container, rerender } = render(<svg><PlacedLayer views={views} width={10} height={4} effects="off" /></svg>);
        expect(container.querySelector('style')).toBeNull();
        expect(container.querySelector('.combat-placed-flicker')).toBeNull();
        rerender(<svg><PlacedLayer views={views} width={10} height={4} effects="enhanced" /></svg>);
        expect(container.querySelector('style')?.textContent).toContain('prefers-reduced-motion');
        expect(container.querySelector('.combat-placed-flicker')).not.toBeNull();
        expect(screen.getByTestId('combat-placed')).toHaveAttribute('data-effects', 'enhanced');
    });

    it('names a marked square in the cursor label', () => {
        board(session({ placed: PLACED }));
        const surface = screen.getByTestId('combat-board-surface');
        for (let i = 0; i < 2; i++) fireEvent.keyDown(surface, { key: 'ArrowDown' });
        for (let i = 0; i < 2; i++) fireEvent.keyDown(surface, { key: 'ArrowRight' });
        expect(screen.getByTestId('combat-cursor').getAttribute('aria-label')).toContain('Flames on 2 squares');
    });

    it('lists weak, resist, immune and mindless in the unit panel', () => {
        board(session(), node => node, 'boss');
        const notes = screen.getAllByTestId('combat-inspect-note').map(n => n.textContent);
        expect(notes).toEqual(expect.arrayContaining(['Weak to Water', 'Resists Fire', 'Immune to Mental', 'Mindless: immune to mental and madness']));
    });

    it('names element conditions in the unit panel', () => {
        const s = session();
        s.state.combatants.boss = { ...s.state.combatants.boss, weak: undefined, resist: undefined, immune: undefined, mindless: undefined, conditions: [{ id: 'burning', turns: 2 }, { id: 'slowed', turns: 1, element: 'ice' }, { id: 'snared', turns: 1 }] };
        board(s, node => node, 'boss');
        const notes = screen.getAllByTestId('combat-inspect-note').map(n => n.textContent);
        expect(notes).toEqual(['Burning (2 of its turns)', 'Chilled (1 of its turns)', 'Snared (1 of its turns)']);
    });

    it('colours an elemental ability\'s area preview and leaves a plain one as it was', () => {
        const s = session();
        const make = (element?: GlyphAbility['element']): AbilityAim => ({
            ability: { id: 'a', name: 'Flare', form: { id: 'burst', augments: [] }, effects: [{ id: 'damage', augments: [] }], source: 'player', ...(element ? { element } : {}) },
            actorId: 'pc',
            legal: new Set(['5,2']),
            legalList: [{ x: 5, y: 2 }],
            preview: () => null,
            confirm: () => {},
            cancel: () => {},
        });
        const preview = { ok: true, tiles: [{ x: 5, y: 2 }], hits: [], pushes: [] };
        const { container, rerender } = render(<svg><AimOverlay aim={make('ice')} preview={preview} focus={{ x: 5, y: 2 }} state={s.state} /></svg>);
        const area = () => container.querySelector('[data-testid="combat-aim-area"]') as SVGElement;
        expect(container.querySelector('[data-testid="combat-aim"]')?.getAttribute('data-element')).toBe('ice');
        expect(area().getAttribute('style')).toContain('fill: #67e8f9');
        rerender(<svg><AimOverlay aim={make()} preview={preview} focus={{ x: 5, y: 2 }} state={s.state} /></svg>);
        expect(container.querySelector('[data-testid="combat-aim"]')?.getAttribute('data-element')).toBeNull();
        expect(area().getAttribute('style')).toContain('var(--combat-target)');
    });
});

describe('the start dialog element fields (H1)', () => {
    const proposal: CombatProposal = {
        id: 'p', messageId: 'm', reason: 'Ambush', source: 'tool',
        combatants: [{ name: 'Golem', side: 'enemy', tier: 'grunt', species: 'golem', weak: ['water'] }, { name: 'Bandit', side: 'enemy', tier: 'grunt' }],
    };

    it('shows what the model gave, lets the player change it and starts with it', () => {
        const onStart = vi.fn();
        render(<CombatProposalDialog proposal={proposal} open onStart={onStart} onDecline={() => {}} onMinimise={() => {}} />);
        expect(screen.getByTestId('combat-elements-summary-0')).toHaveTextContent('weak to Water');
        expect(screen.getByTestId('combat-mindless-0')).toBeChecked();
        expect(screen.getByTestId('combat-mindless-1')).not.toBeChecked();
        fireEvent.change(screen.getByTestId('combat-element-1-fire'), { target: { value: 'immune' } });
        fireEvent.change(screen.getByTestId('combat-element-0-water'), { target: { value: 'resist' } });
        fireEvent.change(screen.getByTestId('combat-caster-element-1'), { target: { value: 'ice' } });
        fireEvent.click(screen.getByTestId('combat-mindless-0'));
        fireEvent.click(screen.getByRole('button', { name: /start combat/i }));
        const started = onStart.mock.calls[0][0] as CombatProposal;
        expect(started.combatants[0]).toMatchObject({ resist: ['water'], mindless: false });
        expect(started.combatants[0].weak).toBeUndefined();
        expect(started.combatants[1]).toMatchObject({ immune: ['fire'], element: 'ice' });
    });

    it('offers only the active preset\'s elements', () => {
        mockState.context = { combatConfig: { combatElements: 'fantasy' } };
        render(<CombatProposalDialog proposal={proposal} open onStart={() => {}} onDecline={() => {}} onMinimise={() => {}} />);
        expect(screen.queryByTestId('combat-element-0-mental')).toBeNull();
        expect(screen.getByTestId('combat-element-0-lava')).toBeInTheDocument();
        expect(screen.getByTestId('combat-element-0-fire')).toHaveAccessibleName('Fire against Golem');
    });
});
