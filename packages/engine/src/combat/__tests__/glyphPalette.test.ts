import { describe, it, expect } from 'vitest';
import {
    abilityTargets, allGlyphs, augmentCapacity, autoPlacementReason, chainColumns, chainCost, chainCount, chainOf, describeGlyph,
    EFFECT_IDS, emptyChain, firstFreeSocket, FORM_IDS, FORMS, EFFECTS, glyphCost, abilityCost, glyphCount, placeGlyph,
    placementReason, previewAbility, previewState, PREVIEW_USER_ID, removeGlyph, socketGlyph, STARTER_ABILITIES, validateAbility,
} from '../index';
import type { AbilityLimits, ChainDraft, GlyphAbility, Socket } from '../index';
import { glyph } from './glyphFixtures';

const limits: AbilityLimits = { maxChainLength: 6, maxSummons: 2 };

function toAbility(chain: ChainDraft): GlyphAbility {
    return { id: 'x', name: 'Test', form: { id: chain.form.id as never, augments: chain.form.augments }, effects: chain.effects, source: 'player' };
}

function structural(chain: ChainDraft): string[] {
    return validateAbility(toAbility(chain), limits).filter(r => r !== 'the ability needs at least one effect');
}

function bases(): ChainDraft[] {
    const out: ChainDraft[] = [];
    for (const form of FORM_IDS) {
        const formAugments = [[], ...FORMS[form].augments.map(a => [a])];
        for (const augments of formAugments) {
            out.push({ form: { id: form, augments }, effects: [] });
            for (const e of EFFECT_IDS) {
                out.push({ form: { id: form, augments }, effects: [{ id: e, augments: [] }] });
                for (const a of EFFECTS[e].augments) out.push({ form: { id: form, augments }, effects: [{ id: e, augments: [a] }] });
            }
            for (const e1 of ['damage', 'heal', 'push'] as const) {
                for (const e2 of ['shield', 'swap', 'drain'] as const) {
                    out.push({ form: { id: form, augments }, effects: [{ id: e1, augments: [] }, { id: e2, augments: [] }] });
                }
            }
        }
    }
    return out.filter(c => structural(c).length === 0);
}

function sockets(chain: ChainDraft): Socket[] {
    return chainColumns(chain).flatMap(c => [c.owner, ...c.augments.map(a => a.socket)]);
}

describe('palette placement matches validateAbility', () => {
    it('accepts a glyph in a socket exactly when the resulting chain validates', () => {
        const all = bases();
        expect(all.length).toBeGreaterThan(300);
        let checked = 0;
        for (const chain of all) {
            for (const socket of sockets(chain)) {
                if (socket.kind === 'form') continue;
                for (const g of allGlyphs(socket.kind)) {
                    const next = placeGlyph(chain, socket, g);
                    const expected = structural(next).length === 0;
                    const reason = placementReason(chain, socket, g, limits);
                    expect(reason === null, `${JSON.stringify(chain)} ${JSON.stringify(socket)} ${g.id}: ${JSON.stringify(reason)} vs ${structural(next).join('; ')}`).toBe(expected);
                    checked++;
                }
            }
        }
        expect(checked).toBeGreaterThan(5000);
    });

    it('honours a smaller chain limit', () => {
        const tight: AbilityLimits = { maxChainLength: 2, maxSummons: 2 };
        const chain: ChainDraft = { form: { id: 'burst', augments: [] }, effects: [{ id: 'damage', augments: [] }] };
        expect(placementReason(chain, { kind: 'augment', owner: 'form', index: 0 }, { kind: 'augment', id: 'widen' }, tight)).toEqual({ code: 'chain-full', limit: 2 });
        expect(placementReason(chain, { kind: 'effect', index: 1 }, { kind: 'effect', id: 'heal' }, tight)).toEqual({ code: 'chain-full', limit: 2 });
        expect(placementReason(chain, { kind: 'augment', owner: 'form', index: 0 }, { kind: 'augment', id: 'widen' }, { maxChainLength: 3 })).toBeNull();
    });

    it('turns summons off by the limit', () => {
        const chain: ChainDraft = { form: { id: 'touch', augments: [] }, effects: [] };
        expect(placementReason(chain, { kind: 'effect', index: 0 }, { kind: 'effect', id: 'summon' }, { maxChainLength: 6, maxSummons: 0 })).toEqual({ code: 'summons-off' });
    });
});

describe('placement reasons', () => {
    const touch: ChainDraft = { form: { id: 'touch', augments: [] }, effects: [] };
    const burstDamage: ChainDraft = { form: { id: 'burst', augments: [] }, effects: [{ id: 'damage', augments: [] }] };

    it('names the forms an effect needs', () => {
        expect(placementReason({ form: { id: 'projectile', augments: [] }, effects: [] }, { kind: 'effect', index: 0 }, { kind: 'effect', id: 'barrier' }, limits))
            .toEqual({ code: 'form-cannot-carry', forms: ['touch', 'line'] });
        expect(placementReason(emptyChain(), { kind: 'effect', index: 0 }, { kind: 'effect', id: 'damage' }, limits)).toEqual({ code: 'needs-form' });
    });

    it('names the glyph that refuses an augment and the repeat limit', () => {
        expect(placementReason(burstDamage, { kind: 'augment', owner: 'form', index: 0 }, { kind: 'augment', id: 'split' }, limits))
            .toEqual({ code: 'not-accepted', by: { kind: 'form', id: 'burst' } });
        const twice: ChainDraft = { form: { id: 'burst', augments: ['extend', 'extend'] }, effects: [{ id: 'damage', augments: [] }] };
        expect(placementReason(twice, { kind: 'augment', owner: 'form', index: 2 }, { kind: 'augment', id: 'extend' }, { maxChainLength: 9 }))
            .toEqual({ code: 'augment-limit', max: 2 });
    });

    it('explains solo effects, swap and barrier conflicts', () => {
        expect(placementReason({ form: { id: 'touch', augments: [] }, effects: [{ id: 'damage', augments: [] }] }, { kind: 'effect', index: 1 }, { kind: 'effect', id: 'summon' }, limits))
            .toEqual({ code: 'must-be-alone' });
        expect(placementReason({ form: { id: 'touch', augments: [] }, effects: [{ id: 'summon', augments: [] }] }, { kind: 'effect', index: 1 }, { kind: 'effect', id: 'damage' }, limits))
            .toEqual({ code: 'solo-present', with: 'summon' });
        expect(placementReason({ form: { id: 'touch', augments: ['split'] }, effects: [] }, { kind: 'effect', index: 0 }, { kind: 'effect', id: 'swap' }, limits))
            .toEqual({ code: 'swap-conflict' });
        expect(placementReason({ form: { id: 'line', augments: ['widen'] }, effects: [] }, { kind: 'effect', index: 0 }, { kind: 'effect', id: 'barrier' }, limits))
            .toEqual({ code: 'barrier-widen' });
    });

    it('rejects a glyph for a socket of another kind', () => {
        expect(placementReason(touch, { kind: 'form' }, { kind: 'effect', id: 'damage' }, limits)).toEqual({ code: 'wrong-socket', expects: 'form' });
    });
});

describe('replacing and removing glyphs', () => {
    it('replacing a form drops only the augments the new form does not accept', () => {
        const chain: ChainDraft = { form: { id: 'projectile', augments: ['extend', 'pierce', 'quicken'] }, effects: [{ id: 'damage', augments: [] }] };
        const next = placeGlyph(chain, { kind: 'form' }, { kind: 'form', id: 'touch' });
        expect(next.form).toEqual({ id: 'touch', augments: ['quicken'] });
        expect(next.effects).toEqual(chain.effects);
        expect(placeGlyph(chain, { kind: 'form' }, { kind: 'form', id: 'line' }).form.augments).toEqual(['extend', 'quicken']);
    });

    it('replacing an effect drops only the augments the new effect does not accept', () => {
        const chain: ChainDraft = { form: { id: 'touch', augments: [] }, effects: [{ id: 'shield', augments: ['amplify', 'extend'] }] };
        expect(placeGlyph(chain, { kind: 'effect', index: 0 }, { kind: 'effect', id: 'damage' }).effects[0]).toEqual({ id: 'damage', augments: ['amplify'] });
        expect(placeGlyph(chain, { kind: 'effect', index: 0 }, { kind: 'effect', id: 'swap' }).effects[0]).toEqual({ id: 'swap', augments: [] });
    });

    it('removing a form clears its augments, removing an effect clears its own', () => {
        const chain: ChainDraft = { form: { id: 'burst', augments: ['widen'] }, effects: [{ id: 'damage', augments: ['amplify'] }, { id: 'heal', augments: [] }] };
        expect(removeGlyph(chain, { kind: 'form' }).form).toEqual({ id: null, augments: [] });
        expect(removeGlyph(chain, { kind: 'effect', index: 0 }).effects).toEqual([{ id: 'heal', augments: [] }]);
        expect(removeGlyph(chain, { kind: 'augment', owner: 0, index: 0 }).effects[0].augments).toEqual([]);
        expect(socketGlyph(chain, { kind: 'augment', owner: 'form', index: 0 })).toEqual({ kind: 'augment', id: 'widen' });
    });
});

describe('sockets and automatic placement', () => {
    it('lists the form, each effect and one empty effect socket, with augment sockets under each glyph', () => {
        const columns = chainColumns({ form: { id: 'burst', augments: [] }, effects: [{ id: 'damage', augments: [] }] });
        expect(columns.map(c => c.key)).toEqual(['form', 'effect-0', 'effect-1']);
        expect(columns[0].augments).toHaveLength(2);
        expect(columns[1].augments).toHaveLength(2);
        expect(columns[2].augments).toHaveLength(0);
        expect(chainColumns(emptyChain()).map(c => c.key)).toEqual(['form', 'effect-0']);
    });

    it('stops offering an empty effect socket at four effects', () => {
        const four: ChainDraft = { form: { id: 'touch', augments: [] }, effects: (['damage', 'heal', 'shield', 'push'] as const).map(id => ({ id, augments: [] })) };
        expect(chainColumns(four).map(c => c.key)).toEqual(['form', 'effect-0', 'effect-1', 'effect-2', 'effect-3']);
    });

    it('grows the augment sockets so any saved valid chain can be shown whole', () => {
        const ability = glyph('burst', ['damage'], ['extend', 'extend', 'widen']);
        expect(validateAbility(ability, { maxChainLength: 6 })).toEqual([]);
        const columns = chainColumns(chainOf(ability));
        expect(columns[0].augments.filter(a => a.glyph).map(a => a.glyph?.id)).toEqual(['extend', 'extend', 'widen']);
        expect(columns[0].augments.length).toBeGreaterThan(3);
        expect(augmentCapacity({ kind: 'effect', id: 'swap' })).toBe(0);
        expect(chainColumns({ form: { id: 'touch', augments: [] }, effects: [{ id: 'swap', augments: [] }] })[1].augments).toHaveLength(0);
    });

    it('fills the next valid empty socket, and gives a reason when there is none', () => {
        const chain: ChainDraft = { form: { id: 'burst', augments: [] }, effects: [{ id: 'damage', augments: [] }] };
        expect(firstFreeSocket(chain, { kind: 'effect', id: 'heal' }, limits)).toEqual({ kind: 'effect', index: 1 });
        expect(firstFreeSocket(chain, { kind: 'augment', id: 'amplify' }, limits)).toEqual({ kind: 'augment', owner: 0, index: 0 });
        expect(firstFreeSocket(chain, { kind: 'augment', id: 'widen' }, limits)).toEqual({ kind: 'augment', owner: 'form', index: 0 });
        expect(firstFreeSocket(chain, { kind: 'augment', id: 'split' }, limits)).toBeNull();
        expect(autoPlacementReason(chain, { kind: 'augment', id: 'split' }, limits)).toEqual({
            code: 'no-owner',
            accepted: [{ kind: 'form', id: 'touch' }, { kind: 'form', id: 'projectile' }],
        });
        expect(autoPlacementReason(emptyChain(), { kind: 'effect', id: 'damage' }, limits)).toEqual({ code: 'needs-form' });
        expect(firstFreeSocket(emptyChain(), { kind: 'form', id: 'burst' }, limits)).toEqual({ kind: 'form' });
    });
});

describe('chain totals', () => {
    it('match abilityCost and glyphCount for every starter preset', () => {
        for (const preset of STARTER_ABILITIES) {
            expect(chainCost(chainOf(preset))).toBe(abilityCost(preset));
            expect(chainCount(chainOf(preset))).toBe(glyphCount(preset));
        }
        expect(chainCost(emptyChain())).toBe(0);
        expect(chainCount(emptyChain())).toBe(0);
    });

    it('price single glyphs from the registry', () => {
        expect(glyphCost({ kind: 'form', id: 'burst' })).toBe(3);
        expect(glyphCost({ kind: 'effect', id: 'haste' })).toBe(4);
        expect(glyphCost({ kind: 'augment', id: 'quicken' })).toBe(3);
    });
});

describe('describeGlyph', () => {
    const stats = { proficiency: 2, castingMod: 3 };

    it('states numbers at the character level', () => {
        expect(describeGlyph({ kind: 'form', id: 'burst' }, stats)).toEqual(['Burst, 3×3, within 8 squares.', 'Targets make a saving throw, DC 13.', '3 MP.']);
        expect(describeGlyph({ kind: 'effect', id: 'damage' }, stats)[0]).toBe('Takes 2d6 force damage.');
        expect(describeGlyph({ kind: 'effect', id: 'damage' }, { proficiency: 4, castingMod: 3 })[0]).toBe('Takes 4d6 force damage.');
        expect(describeGlyph({ kind: 'augment', id: 'amplify' }, stats)[0]).toBe('Damage: 2d6 → 3d6');
        expect(describeGlyph({ kind: 'augment', id: 'widen' }, stats)[0]).toBe('Burst: 3×3 → 5×5');
    });

    it('describes every glyph', () => {
        for (const kind of ['form', 'effect', 'augment'] as const) {
            for (const g of allGlyphs(kind)) {
                const lines = describeGlyph(g, stats);
                expect(lines.length).toBeGreaterThan(1);
                expect(lines.every(l => l.length > 0)).toBe(true);
                expect(lines[lines.length - 1]).toBe(`${glyphCost(g)} MP.`);
            }
        }
    });
});

describe('previewAbility', () => {
    it('equals abilityTargets on the fixed sample state at the chosen aim', () => {
        for (const preset of STARTER_ABILITIES) {
            const preview = previewAbility(preset);
            const direct = abilityTargets(previewState(), PREVIEW_USER_ID, preset, preview.aim);
            expect(preview.result).toEqual(direct);
            expect(preview.result.ok).toBe(true);
        }
    });

    it('aims a harmful area at the enemies and a heal at the ally', () => {
        const burst = previewAbility(glyph('burst', ['damage']));
        expect(burst.result.targetIds.sort()).toEqual(['preview-enemy-1', 'preview-enemy-2']);
        expect(previewAbility(glyph('touch', ['heal'])).result.targetIds).toEqual(['preview-ally']);
        expect(previewAbility(glyph('self', ['haste'])).result.targetIds).toEqual([PREVIEW_USER_ID]);
        expect(previewAbility(glyph('projectile', ['damage'], ['pierce'])).result.targetIds.sort()).toEqual(['preview-enemy-1', 'preview-enemy-2']);
    });

    it('reports no preview when nothing is legal', () => {
        const none = previewAbility(glyph('projectile', ['damage'], ['extend']));
        expect(none.result.ok).toBe(true);
        const tile = previewAbility(glyph('touch', ['barrier']));
        expect(tile.result.barrierTiles?.length).toBe(1);
        const summon = previewAbility(glyph('projectile', ['summon']));
        expect(summon.result.summonAt).toBeDefined();
    });
});
