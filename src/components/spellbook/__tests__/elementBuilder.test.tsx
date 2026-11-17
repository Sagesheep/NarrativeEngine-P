import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ELEMENTS, allGlyphs, glyphTier } from '@narrative/engine';
import { SpellbookDialog } from '../SpellbookDialog';
import { GlyphStrip } from '../GlyphStrip';
import { Hotbar } from '../Hotbar';
import { useAppStore } from '../../../store/useAppStore';
import { cancelPendingSaves } from '../../../store/slices/campaignSlice';
import { DEFAULT_COMBAT_CONFIG, migrateLegacyContext } from '../../../types';
import type { CombatSheet, GlyphAbility, Spellbook } from '../../../types';
import { glyphDescriptionKey, glyphLabelKey } from '../../character/tabs/glyphLabels';
import { en } from '../../../i18n/locales/en';

const sheet: CombatSheet = { abilities: { STR: 10, DEX: 14, CON: 14, INT: 16, WIS: 10, CHA: 8 }, budget: 'NORMAL', level: 3, needsAllocation: false };

const quake: GlyphAbility = { id: 'q1', name: 'Quake', form: { id: 'burst', augments: [] }, effects: [{ id: 'damage', augments: [] }], element: 'earth', source: 'player' };

function seed(book?: Spellbook, elements: 'all' | 'fantasy' | 'modern' = 'all') {
    const context = migrateLegacyContext({
        combatModeActive: true,
        combatSheet: sheet,
        combatConfig: { ...DEFAULT_COMBAT_CONFIG, combatElements: elements },
        characterProfileData: {
            name: 'Kira', race: 'Human', class: 'Mage', level: 3,
            hp: { current: 25, max: 25 }, stats: {}, skills: [], abilities: [], traits: [], notes: '',
        },
        ...(book ? { spellbook: book } : {}),
    });
    useAppStore.setState({ context, characterProfileData: context.characterProfileData, activeCampaignId: null, abilityEditDraft: null, abilityProposal: null, spellbookOpen: true });
}

const book = () => useAppStore.getState().context.spellbook!;
const pal = (kind: string, id: string) => screen.getByTestId(`palette-${kind}-${id}`);
const click = (el: Element) => fireEvent.click(el);

describe('the builder with elements and the new glyphs (H2)', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    });

    afterEach(() => {
        cancelPendingSaves();
        vi.unstubAllGlobals();
    });

    it('lists only the active preset\'s elements, each with its tier and cost', () => {
        seed(undefined, 'modern');
        render(<SpellbookDialog />);
        const list = within(screen.getByTestId('palette-elements')).getAllByRole('button').map(b => b.getAttribute('data-testid'));
        expect(list).toEqual(['kinetic', 'fire', 'lightning', 'ice', 'steel', 'slime', 'mental', 'madness'].map(e => `palette-element-${e}`));
        expect(screen.getByTestId('palette-element-madness')).toHaveAttribute('aria-label', 'Madness, 1 MP, Tier 3');
        expect(screen.getByTestId('palette-element-madness')).toHaveAttribute('data-tier', String(ELEMENTS.madness.tier));
    });

    it('shows every glyph, old and new, with its tier and a description', () => {
        seed();
        render(<SpellbookDialog />);
        for (const kind of ['form', 'effect', 'augment'] as const) {
            for (const glyph of allGlyphs(kind)) {
                const tile = pal(kind, glyph.id);
                expect(tile).toHaveAttribute('data-tier', String(glyphTier(glyph)));
                expect(tile.getAttribute('aria-label')).toContain(`Tier ${glyphTier(glyph)}`);
                expect(en[glyphDescriptionKey(glyph)]).toBeTruthy();
                expect(en[glyphLabelKey(glyph)]).toBeTruthy();
            }
        }
        fireEvent.focus(pal('form', 'sigil'));
        expect(screen.getByTestId('glyph-detail-desc')).toHaveTextContent('A trap on a square');
        expect(screen.getByTestId('glyph-detail')).toHaveTextContent('Tier 3');
        fireEvent.focus(screen.getByTestId('palette-element-fire'));
        expect(screen.getByTestId('glyph-detail-desc')).toHaveTextContent('Burns the target');
    });

    it('places an element, counts it in the cost, saves it and removes it again', () => {
        seed();
        render(<SpellbookDialog />);
        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Flare' } });
        click(pal('form', 'burst'));
        click(pal('effect', 'damage'));
        const before = screen.getByTestId('builder-cost').textContent;
        click(screen.getByTestId('palette-element-lava'));
        expect(screen.getByTestId('palette-element-lava')).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByTestId('socket-element')).toHaveTextContent('Lava');
        expect(screen.getByTestId('builder-cost').textContent).not.toBe(before);
        click(screen.getByRole('button', { name: 'Save ability' }));
        expect(book().abilities[0].element).toBe('lava');
        click(screen.getByTestId('palette-element-fire'));
        expect(screen.getByTestId('socket-element')).toHaveTextContent('Fire');
        click(within(screen.getByTestId('socket-element')).getByRole('button', { name: 'Remove Fire' }));
        expect(screen.queryByTestId('socket-element')).toBeNull();
    });

    it('builds an ability from the new glyphs', () => {
        seed();
        render(<SpellbookDialog />);
        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Snap Trap' } });
        click(pal('form', 'sigil'));
        click(pal('effect', 'snare'));
        click(pal('augment', 'sustain'));
        click(screen.getByRole('button', { name: 'Save ability' }));
        expect(book().abilities[0]).toMatchObject({ form: { id: 'sigil' }, effects: [{ id: 'snare' }] });
    });

    it('keeps an ability whose element is outside the preset usable and flags it', () => {
        seed({ abilities: [quake], equippedIds: ['q1'] }, 'modern');
        render(<SpellbookDialog />);
        expect(screen.getByTestId('builder-element-outside')).toHaveTextContent('Earth is not one of this campaign\'s elements (Modern)');
        expect(screen.queryByTestId('builder-reasons')).toBeNull();
        expect(screen.getByTestId('socket-element')).toHaveTextContent('Earth');
        expect(screen.queryByTestId('palette-element-earth')).toBeNull();
        expect(book().equippedIds).toEqual(['q1']);
        const chips = screen.getAllByTestId('element-chip').filter(c => c.getAttribute('data-element') === 'earth');
        expect(chips.length).toBeGreaterThan(0);
        expect(chips.every(c => c.getAttribute('data-outside') === 'true')).toBe(true);
        expect(chips[0]).toHaveAttribute('aria-label', 'Element: Earth, not one of this campaign\'s elements');
    });

    it('shows the element in the glyph strip and the hotbar, unflagged inside the preset', () => {
        seed(undefined, 'all');
        render(<GlyphStrip ability={quake} />);
        expect(screen.getByTestId('element-chip')).toHaveAttribute('data-outside', 'false');
        expect(screen.getByTestId('element-chip')).toHaveAttribute('aria-label', 'Element: Earth');
    });

    it('shows nothing extra for an ability without an element', () => {
        seed();
        const plain: GlyphAbility = { ...quake, element: undefined };
        render(<Hotbar ids={['q1']} max={2} abilities={new Map([['q1', plain]])} selectedId={null} onSelect={() => {}} onEquipAt={() => {}} onReorder={() => {}} onUnequip={() => {}} />);
        expect(screen.queryByTestId('element-chip')).toBeNull();
    });
});
