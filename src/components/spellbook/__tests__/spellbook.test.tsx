import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { STARTER_ABILITIES, abilityTargets, previewState, previewAbility, PREVIEW_USER_ID } from '@narrative/engine';
import { SpellbookDialog } from '../SpellbookDialog';
import { GlyphIcon } from '../GlyphIcon';
import { GlyphArtContext, parseGlyphManifest } from '../glyphAvailability';
import { GLYPH_MIME, SLOT_MIME, ABILITY_MIME, SOCKET_MIME } from '../dnd';
import { TargetPreview } from '../TargetPreview';
import { useAppStore } from '../../../store/useAppStore';
import { cancelPendingSaves } from '../../../store/slices/campaignSlice';
import { migrateLegacyContext } from '../../../types';
import type { CombatSheet, GameContext, GlyphAbility, Spellbook } from '../../../types';

const sheet: CombatSheet = { abilities: { STR: 10, DEX: 14, CON: 14, INT: 16, WIS: 10, CHA: 8 }, budget: 'NORMAL', level: 3, needsAllocation: false };

function ability(id: string, name: string, form: GlyphAbility['form'], effects: GlyphAbility['effects'], extra: Partial<GlyphAbility> = {}): GlyphAbility {
    return { id, name, form, effects, source: 'player', ...extra };
}

function seed(book?: Spellbook, patch: Partial<GameContext> = {}) {
    const context = migrateLegacyContext({
        combatModeActive: true,
        combatSheet: sheet,
        characterProfileData: {
            name: 'Kira', race: 'Human', class: 'Mage', level: 3,
            hp: { current: 25, max: 25 }, stats: {}, skills: [], abilities: [], traits: [], notes: '',
        },
        ...(book ? { spellbook: book } : {}),
        ...patch,
    });
    useAppStore.setState({ context, characterProfileData: context.characterProfileData, activeCampaignId: null, abilityEditDraft: null, abilityProposal: null, spellbookOpen: true });
}

const book = () => useAppStore.getState().context.spellbook!;
const shape = (a: GlyphAbility) => ({ form: a.form, effects: a.effects, damageType: a.damageType });
const pal = (kind: string, id: string) => screen.getByTestId(`palette-${kind}-${id}`);
const sock = (key: string) => screen.getByTestId(`socket-${key}`);
const click = (el: Element) => fireEvent.click(el);
const name = (v: string) => fireEvent.change(screen.getByLabelText('Name'), { target: { value: v } });
const type = (v: string) => fireEvent.change(screen.getByLabelText('Damage type (optional, default force)'), { target: { value: v } });
const save = () => click(screen.getByRole('button', { name: 'Save ability' }));
const newAbility = () => click(screen.getByRole('button', { name: 'New ability' }));

function dt(data: Record<string, string>) {
    return { dataTransfer: { types: Object.keys(data), getData: (m: string) => data[m] ?? '', setData: vi.fn(), effectAllowed: 'move' } };
}

describe('Spellbook workbench', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    });

    afterEach(() => {
        cancelPendingSaves();
        vi.unstubAllGlobals();
    });

    it('renders only while open and while combat is on', () => {
        seed();
        useAppStore.setState({ spellbookOpen: false });
        const { unmount } = render(<SpellbookDialog />);
        expect(screen.queryByTestId('spellbook-dialog')).toBeNull();
        act(() => useAppStore.setState({ spellbookOpen: true }));
        expect(screen.getByTestId('spellbook-dialog')).toBeInTheDocument();
        expect(screen.getByTestId('spellbook-dialog-mp')).toHaveTextContent('Max MP: 16');
        expect(screen.getByTestId('spellbook-body')).toHaveAttribute('data-layout', 'columns');
        unmount();
        seed(undefined, { combatModeActive: false });
        render(<SpellbookDialog />);
        expect(screen.queryByTestId('spellbook-dialog')).toBeNull();
    });

    it('shows the six presets as cards when empty and adds one as an ordinary ability', () => {
        seed();
        render(<SpellbookDialog />);
        expect(STARTER_ABILITIES.every(p => screen.queryByTestId(`preset-${p.id}`))).toBe(true);
        expect(screen.getByTestId('preset-fireball')).toHaveTextContent('Burst, 3×3, within 8 squares');
        click(screen.getByRole('button', { name: 'Add Fireball' }));
        expect(shape(book().abilities[0])).toEqual(shape(STARTER_ABILITIES.find(a => a.id === 'fireball')!));
        expect(book().abilities[0].source).toBe('preset');
        expect(screen.queryByTestId('preset-fireball')).toBeNull();
    });

    it('builds each of the six presets by clicking and equips them', () => {
        seed();
        render(<SpellbookDialog />);
        const build = (n: string, steps: () => void) => {
            if (book().abilities.length > 0) newAbility();
            name(n);
            steps();
            save();
        };
        build('Fire bolt', () => { click(pal('form', 'projectile')); click(pal('effect', 'damage')); type('fire'); });
        build('Mend', () => { click(pal('form', 'touch')); click(pal('effect', 'heal')); });
        build('Fireball', () => { click(pal('form', 'burst')); click(pal('effect', 'damage')); type('fire'); });
        build('Flash step', () => { click(pal('form', 'dash')); click(pal('effect', 'damage')); });
        build('Haste', () => {
            click(pal('form', 'self'));
            expect(pal('effect', 'damage')).toHaveAttribute('aria-label', expect.stringContaining('Needs one of these forms'));
            click(pal('effect', 'damage'));
            expect(sock('effect-0')).toHaveAttribute('data-filled', 'false');
            expect(screen.getByTestId('builder-reasons')).toHaveTextContent('the ability needs at least one effect');
            expect(screen.getByRole('button', { name: 'Save ability' })).toBeDisabled();
            click(pal('effect', 'haste'));
            expect(screen.getByTestId('builder-cost')).toHaveTextContent('Costs 4 of 16 MP');
        });
        build('Aqua elemental', () => {
            click(pal('form', 'touch'));
            click(pal('effect', 'summon'));
            click(pal('augment', 'extend'));
            type('water');
        });
        const saved = book().abilities;
        expect(saved.map(a => a.name)).toEqual(STARTER_ABILITIES.map(a => a.name));
        saved.forEach((a, i) => expect(shape(a)).toEqual(shape(STARTER_ABILITIES[i])));
        for (const a of saved) click(screen.getByRole('button', { name: `Equip: ${a.name}` }));
        expect(book().equippedIds).toEqual(saved.map(a => a.id));
    });

    it('builds a preset with the keyboard alone', async () => {
        seed();
        const user = userEvent.setup();
        render(<SpellbookDialog />);
        await user.click(screen.getByLabelText('Name'));
        await user.keyboard('Fire bolt');
        await user.click(screen.getByLabelText('Damage type (optional, default force)'));
        await user.keyboard('fire');
        act(() => pal('form', 'projectile').focus());
        await user.keyboard('{Enter}');
        await user.keyboard('{ArrowRight}');
        expect(document.activeElement).toBe(pal('form', 'self'));
        act(() => pal('effect', 'damage').focus());
        await user.keyboard('{Enter}');
        act(() => sock('form').focus());
        await user.keyboard('{ArrowRight}');
        expect(document.activeElement).toBe(sock('effect-0'));
        await user.keyboard('{ArrowLeft}{ArrowDown}');
        expect(document.activeElement).toBe(sock('augment-form-0'));
        expect(screen.getByRole('button', { name: 'Save ability' })).toBeEnabled();
        act(() => screen.getByRole('button', { name: 'Save ability' }).focus());
        await user.keyboard('{Enter}');
        expect(shape(book().abilities[0])).toEqual(shape(STARTER_ABILITIES.find(a => a.id === 'fire-bolt')!));
    });

    it('moves between sockets with the arrows and removes with Delete', async () => {
        seed({ abilities: [ability('a', 'Bolt', { id: 'projectile', augments: [] }, [{ id: 'damage', augments: [] }])], equippedIds: [] });
        const user = userEvent.setup();
        render(<SpellbookDialog />);
        act(() => sock('effect-0').focus());
        expect(sock('effect-0')).toHaveAttribute('aria-label', 'Effect 1: Damage, 1 MP');
        await user.keyboard('{Delete}');
        expect(sock('effect-0')).toHaveAttribute('aria-label', 'Effect 1: empty');
        expect(screen.getByTestId('spellbook-status')).toHaveTextContent('Removed Damage.');
    });

    it('dims glyphs that cannot go in and gives the reason', () => {
        seed();
        render(<SpellbookDialog />);
        click(pal('form', 'projectile'));
        const barrier = pal('effect', 'barrier');
        expect(barrier).toHaveAttribute('aria-disabled', 'true');
        expect(barrier).toHaveAttribute('data-dim', 'true');
        expect(barrier).toHaveAttribute('aria-label', 'Barrier, 2 MP. Needs one of these forms: Touch, Line');
        click(pal('form', 'burst'));
        click(pal('effect', 'damage'));
        click(sock('form'));
        expect(pal('effect', 'heal')).toHaveAttribute('aria-label', expect.stringContaining('Goes in a Form socket'));
        click(sock('form'));
        const split = pal('augment', 'split');
        expect(split).toHaveAttribute('data-dim', 'true');
        expect(split).toHaveAttribute('aria-label', expect.stringContaining('Needs one of these in the chain: Touch, Projectile'));
        click(sock('augment-form-0'));
        expect(split).toHaveAttribute('aria-label', expect.stringContaining('Not accepted by Burst'));
        expect(pal('augment', 'widen')).toHaveAttribute('data-dim', 'false');
        click(split);
        expect(screen.getByTestId('spellbook-status')).toHaveTextContent('Not accepted by Burst');
        expect(sock('augment-form-0')).toHaveAttribute('data-filled', 'false');
        fireEvent.focus(split);
        expect(screen.getByTestId('glyph-detail')).toHaveTextContent('Not accepted by Burst');
        expect(screen.getByTestId('glyph-detail')).toHaveTextContent('Touch, Projectile: one extra target within 3 squares');
    });

    it('shows numbers at the character level in the glyph details', () => {
        seed();
        render(<SpellbookDialog />);
        fireEvent.focus(pal('effect', 'damage'));
        expect(screen.getByTestId('glyph-detail')).toHaveTextContent('Takes 2d6 force damage.');
        fireEvent.focus(pal('form', 'burst'));
        expect(screen.getByTestId('glyph-detail')).toHaveTextContent('Burst, 3×3, within 8 squares.');
    });

    it('replacing a form drops only the augments that became invalid', () => {
        seed({
            abilities: [ability('a', 'Bolt', { id: 'projectile', augments: ['extend', 'pierce', 'quicken'] }, [{ id: 'damage', augments: ['amplify'] }])],
            equippedIds: [],
        });
        render(<SpellbookDialog />);
        click(pal('form', 'line'));
        expect(sock('augment-form-0')).toHaveAttribute('aria-label', 'Form augment 1: Extend, 1 MP');
        expect(sock('augment-form-1')).toHaveAttribute('aria-label', 'Form augment 2: Quicken, 3 MP');
        expect(sock('augment-form-2')).toHaveAttribute('data-filled', 'false');
        expect(sock('augment-0-0')).toHaveAttribute('aria-label', 'Effect 1 augment 1: Amplify, 2 MP');
        expect(screen.getByTestId('spellbook-status')).toHaveTextContent('Placed Line. 1 glyph(s) that no longer fit were removed.');
    });

    it('keeps effects when the form is swapped and shows the engine reason in plain sight', () => {
        seed({ abilities: [ability('a', 'Bolt', { id: 'projectile', augments: [] }, [{ id: 'damage', augments: [] }])], equippedIds: [] });
        render(<SpellbookDialog />);
        click(pal('form', 'self'));
        expect(sock('effect-0')).toHaveAttribute('aria-label', 'Effect 1: Damage, 1 MP');
        expect(screen.getByTestId('builder-reasons')).toHaveTextContent('the self form cannot carry damage');
        expect(screen.getByRole('button', { name: 'Save ability' })).toBeDisabled();
    });

    it('shows a saved ability with more augments than two sockets and keeps it valid', () => {
        seed({ abilities: [ability('a', 'Wide', { id: 'burst', augments: ['extend', 'extend', 'widen'] }, [{ id: 'damage', augments: [] }])], equippedIds: [] });
        render(<SpellbookDialog />);
        expect(sock('augment-form-2')).toHaveAttribute('aria-label', 'Form augment 3: Widen, 2 MP');
        expect(screen.getByTestId('builder-count')).toHaveTextContent('5 / 6 glyphs');
        expect(screen.queryByTestId('builder-reasons')).toBeNull();
        expect(screen.getByRole('button', { name: 'Save ability' })).toBeDisabled();
    });

    it('drops a palette glyph onto a socket, and drags a socket glyph back to the palette', () => {
        seed();
        render(<SpellbookDialog />);
        fireEvent.drop(sock('form'), dt({ [GLYPH_MIME]: JSON.stringify({ kind: 'form', id: 'cone' }) }));
        expect(sock('form')).toHaveAttribute('aria-label', 'Form: Cone, 2 MP');
        fireEvent.drop(sock('effect-0'), dt({ [GLYPH_MIME]: JSON.stringify({ kind: 'form', id: 'burst' }) }));
        expect(sock('effect-0')).toHaveAttribute('data-filled', 'false');
        fireEvent.drop(sock('effect-0'), dt({ [GLYPH_MIME]: JSON.stringify({ kind: 'effect', id: 'stun' }) }));
        expect(sock('effect-0')).toHaveAttribute('aria-label', 'Effect 1: Stun, 3 MP');
        fireEvent.drop(screen.getByTestId('glyph-palette'), dt({ [SOCKET_MIME]: 'effect-0' }));
        expect(sock('effect-0')).toHaveAttribute('data-filled', 'false');
    });

    it('warns about unsaved edits before switching cards or closing', () => {
        seed({
            abilities: [
                ability('a', 'Bolt', { id: 'projectile', augments: [] }, [{ id: 'damage', augments: [] }]),
                ability('b', 'Mend', { id: 'touch', augments: [] }, [{ id: 'heal', augments: [] }]),
            ],
            equippedIds: [],
        });
        render(<SpellbookDialog />);
        click(pal('effect', 'shield'));
        expect(screen.getByTestId('spellbook-dirty')).toHaveTextContent('Unsaved changes');
        click(within(screen.getByTestId('ability-b')).getAllByRole('button')[0]);
        expect(screen.getByTestId('spellbook-unsaved')).toHaveTextContent('unsaved changes to Bolt');
        click(screen.getByRole('button', { name: 'Keep editing' }));
        expect(screen.queryByTestId('spellbook-unsaved')).toBeNull();
        expect(screen.getByTestId('ability-a')).toHaveAttribute('data-selected', 'true');
        fireEvent.keyDown(screen.getByTestId('spellbook-dialog'), { key: 'Escape' });
        expect(screen.getByTestId('spellbook-unsaved')).toBeInTheDocument();
        expect(useAppStore.getState().spellbookOpen).toBe(true);
        click(screen.getByRole('button', { name: 'Discard changes' }));
        expect(useAppStore.getState().spellbookOpen).toBe(false);
    });

    it('saves and continues to another card', () => {
        seed({
            abilities: [
                ability('a', 'Bolt', { id: 'projectile', augments: [] }, [{ id: 'damage', augments: [] }]),
                ability('b', 'Mend', { id: 'touch', augments: [] }, [{ id: 'heal', augments: [] }]),
            ],
            equippedIds: [],
        });
        render(<SpellbookDialog />);
        click(pal('augment', 'amplify'));
        click(within(screen.getByTestId('ability-b')).getAllByRole('button')[0]);
        click(screen.getByRole('button', { name: 'Save and continue' }));
        expect(book().abilities[0].effects[0].augments).toEqual(['amplify']);
        expect(screen.getByTestId('ability-b')).toHaveAttribute('data-selected', 'true');
    });

    it('loads an AI proposal into the workbench as unsaved, and saves it as an ai ability', () => {
        seed();
        useAppStore.setState({ abilityEditDraft: ability('p', 'Frost lance', { id: 'projectile', augments: [] }, [{ id: 'slow', augments: [] }], { source: 'ai' }) });
        render(<SpellbookDialog />);
        expect(screen.getByLabelText('Name')).toHaveValue('Frost lance');
        expect(sock('form')).toHaveAttribute('aria-label', 'Form: Projectile, 1 MP');
        save();
        expect(book().abilities.map(a => [a.name, a.source])).toEqual([['Frost lance', 'ai']]);
        expect(useAppStore.getState().abilityEditDraft).toBeNull();
    });

    it('equips, reorders and clears on the hotbar by click and by drop', () => {
        seed({
            abilities: [
                ability('a', 'Bolt', { id: 'projectile', augments: [] }, [{ id: 'damage', augments: [] }]),
                ability('b', 'Mend', { id: 'touch', augments: [] }, [{ id: 'heal', augments: [] }]),
                ability('c', 'Haste', { id: 'self', augments: [] }, [{ id: 'haste', augments: [] }]),
            ],
            equippedIds: [],
        }, { combatConfig: { ...migrateLegacyContext({}).combatConfig!, maxEquippedAbilities: 3 } });
        render(<SpellbookDialog />);
        expect(screen.getByTestId('spellbook-equipped-count')).toHaveTextContent('Equipped 0 of 3');
        click(screen.getByRole('button', { name: 'Equip: Bolt' }));
        fireEvent.drop(screen.getByTestId('hotbar-slot-1'), dt({ [ABILITY_MIME]: 'b' }));
        fireEvent.drop(screen.getByTestId('hotbar-slot-2'), dt({ [ABILITY_MIME]: 'c' }));
        expect(book().equippedIds).toEqual(['a', 'b', 'c']);
        fireEvent.drop(screen.getByTestId('hotbar-slot-0'), dt({ [SLOT_MIME]: '2' }));
        expect(book().equippedIds).toEqual(['c', 'a', 'b']);
        expect(screen.getByTestId('hotbar-slot-0')).toHaveTextContent('1');
        click(screen.getByRole('button', { name: 'Unequip Haste' }));
        expect(book().equippedIds).toEqual(['a', 'b']);
        click(screen.getByRole('button', { name: 'Unequip: Bolt' }));
        expect(book().equippedIds).toEqual(['b']);
    });

    it('refuses to equip past the limit and says why', () => {
        seed({
            abilities: [
                ability('a', 'Bolt', { id: 'projectile', augments: [] }, [{ id: 'damage', augments: [] }]),
                ability('b', 'Mend', { id: 'touch', augments: [] }, [{ id: 'heal', augments: [] }]),
            ],
            equippedIds: ['a'],
        }, { combatConfig: { ...migrateLegacyContext({}).combatConfig!, maxEquippedAbilities: 1 } });
        render(<SpellbookDialog />);
        expect(screen.getByRole('button', { name: 'Equip: Mend' })).toBeDisabled();
        expect(screen.getByTestId('ability-b')).toHaveTextContent('Unequip another ability first (limit 1)');
        fireEvent.drop(screen.getByTestId('hotbar-slot-0'), dt({ [ABILITY_MIME]: 'b' }));
        expect(book().equippedIds).toEqual(['b']);
    });

    it('deletes an ability only after a second click', () => {
        seed({ abilities: [ability('a', 'Bolt', { id: 'projectile', augments: [] }, [{ id: 'damage', augments: [] }])], equippedIds: ['a'] });
        render(<SpellbookDialog />);
        click(screen.getByRole('button', { name: 'Delete: Bolt' }));
        expect(book().abilities).toHaveLength(1);
        click(screen.getByRole('button', { name: 'Confirm delete: Bolt' }));
        expect(book().abilities).toHaveLength(0);
        expect(book().equippedIds).toEqual([]);
    });
});

describe('Targeting preview', () => {
    it('marks exactly the tiles and combatants abilityTargets returns for the sample state', () => {
        for (const preset of STARTER_ABILITIES) {
            const { unmount } = render(<TargetPreview ability={preset} />);
            const preview = previewAbility(preset);
            const direct = abilityTargets(previewState(), PREVIEW_USER_ID, preset, preview.aim);
            const tiles = screen.queryAllByTestId('preview-tile').map(t => `${t.getAttribute('data-x')},${t.getAttribute('data-y')}`).sort();
            expect(tiles).toEqual(direct.tiles.map(p => `${p.x},${p.y}`).sort());
            const hits = screen.queryAllByTestId('preview-hit').map(h => h.getAttribute('data-id')).sort();
            expect(hits).toEqual([...direct.targetIds].sort());
            unmount();
        }
    });

    it('shows a burst catching both enemies, and a waiting note without an ability', () => {
        const burst = STARTER_ABILITIES.find(a => a.id === 'fireball')!;
        const { unmount } = render(<TargetPreview ability={burst} />);
        expect(screen.getByTestId('preview-caption')).toHaveTextContent('hits 2 enemies and 0 on your side');
        expect(screen.getAllByTestId('preview-tile')).toHaveLength(9);
        unmount();
        render(<TargetPreview ability={null} />);
        expect(screen.getByTestId('target-preview')).toHaveTextContent('Choose a form and an effect');
    });
});

describe('GlyphIcon', () => {
    it('uses the art override as a mask only when the injected set has the glyph', () => {
        const { container, rerender } = render(
            <GlyphArtContext.Provider value={parseGlyphManifest(['damage'])}>
                <GlyphIcon kind="effect" id="damage" />
                <GlyphIcon kind="effect" id="heal" />
            </GlyphArtContext.Provider>,
        );
        const damage = container.querySelector('[data-glyph-icon="damage"]') as HTMLElement;
        const heal = container.querySelector('[data-glyph-icon="heal"]') as HTMLElement;
        expect(damage.getAttribute('data-glyph-art')).toBe('true');
        expect(damage.style.maskImage || damage.style.webkitMaskImage).toContain('assets/combat/glyphs/damage.png');
        expect(heal.getAttribute('data-glyph-art')).toBe('false');
        expect(heal.tagName.toLowerCase()).toBe('svg');
        rerender(
            <GlyphArtContext.Provider value={parseGlyphManifest([])}>
                <GlyphIcon kind="effect" id="damage" />
            </GlyphArtContext.Provider>,
        );
        expect(container.querySelector('[data-glyph-icon="damage"]')?.getAttribute('data-glyph-art')).toBe('false');
    });

    it('parses the manifest defensively', () => {
        expect([...parseGlyphManifest('["a","b-c","Bad Name",3]')]).toEqual(['a', 'b-c']);
        expect(parseGlyphManifest('nope').size).toBe(0);
        expect(parseGlyphManifest(undefined).size).toBe(0);
        expect(parseGlyphManifest({}).size).toBe(0);
    });
});
