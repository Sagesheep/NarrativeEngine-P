import { describe, it, expect, afterEach } from 'vitest';
import { applyAction, buildPcCombatant, createCombat, freshTurn } from '@narrative/engine';
import type { CombatEvent, CombatState, Combatant, ElementId, GlyphAbility } from '@narrative/engine';
import {
    START_COMBAT_TOOL_RESULT, getToolDefinitions, handleProposeAbilityTool, handleStartCombatTool, setElementPresetSource,
} from '../../turn/toolHandlers';
import { elementListLine, elementToolNotes, parseCombatArgs } from '../combatProposal';
import { abilityLimitsOf, parseAbilityArgs } from '../abilityProposalArgs';
import { buildCombatantSpecs } from '../combatController';
import { templateElements } from '../compendiumLookup';
import { buildManualStartPrompt } from '../combatManualStart';
import { cleanAbility, elementOutsidePreset } from '../spellbook';
import { momentTags, narrationLine } from '../combatEvents';
import { beatDirective, directiveForRange } from '../combatNarration';
import { elementLogText, translateElementEvents } from '../elementStory';
import { elementStakes, elementsInEvents } from '../elementNarration';
import { normalizeGlyphAbility, normalizeSpellbook } from '../../../types';
import type { CombatSession } from '../../../types';
import { blankDraft, draftFrom, toAbility } from '../../../components/spellbook/draft';

type ToolDef = { function: { name: string; description: string; parameters: { properties: Record<string, { enum?: string[]; items?: { properties?: Record<string, unknown> } }> } } };

const startTool = (defs: unknown[]) => (defs as ToolDef[]).find(d => d.function.name === 'start_combat') as ToolDef;
const abilityTool = (defs: unknown[]) => (defs as ToolDef[]).find(d => d.function.name === 'propose_ability') as ToolDef;

afterEach(() => setElementPresetSource(null));

describe('start_combat and the element setting (H1)', () => {
    it('tells the model the active element list in one line and offers the per-combatant fields', () => {
        const all = startTool(getToolDefinitions({ allowDiceTool: false, allowCombatTool: true }));
        expect(all.function.description.split('\n').filter(l => l.startsWith('Elements of this setting:'))).toEqual([elementListLine('all')]);
        expect(all.function.description).toContain('fire, water, earth, kinetic, lightning, ice, steel, light, darkness, slime, mental, lava, madness, almighty');
        const props = (all.function.parameters.properties.combatants as unknown as { items: { properties: Record<string, unknown> } }).items.properties;
        for (const field of ['weak', 'resist', 'immune', 'mindless', 'element']) expect(props).toHaveProperty(field);
        const fantasy = startTool(getToolDefinitions({ allowDiceTool: false, allowCombatTool: true, elementPreset: 'fantasy' }));
        expect(fantasy.function.description).toContain('Elements of this setting: fire, water, earth, lightning, ice, lava, steel, darkness, light, almighty, slime.');
        setElementPresetSource(() => 'modern');
        const modern = startTool(getToolDefinitions({ allowDiceTool: false, allowCombatTool: true }));
        expect(modern.function.description).toContain('Elements of this setting: kinetic, fire, lightning, ice, steel, slime, mental, madness.');
    });

    it('parses weak, resist, immune, mindless and a caster element, as lists or comma text', () => {
        const parsed = parseCombatArgs({
            reason: 'x',
            combatants: [
                { name: 'Golem', weak: ['water', 'Lightning'], resist: 'fire, cold', immune: ['mental'], mindless: 'yes' },
                { name: 'Witch', element: 'shadow', mindless: false },
                { name: 'Bandit' },
            ],
        }, [], 'all');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.value.combatants[0]).toMatchObject({ weak: ['water', 'lightning'], resist: ['fire', 'ice'], immune: ['mental'], mindless: true });
        expect(parsed.value.combatants[1]).toMatchObject({ element: 'darkness', mindless: false });
        expect(Object.keys(parsed.value.combatants[2])).toEqual(['name', 'side', 'tier']);
        expect(parsed.drops).toEqual([]);
    });

    it('drops elements outside the preset or unknown and reports them in the tool result', () => {
        const args = JSON.stringify({ reason: 'x', combatants: [{ name: 'Drone', weak: ['earth', 'lightning'], immune: ['plasma'], element: 'lava' }] });
        const parsed = parseCombatArgs(args, [], 'modern');
        expect(parsed.ok && parsed.value.combatants[0]).toMatchObject({ weak: ['lightning'] });
        expect(parsed.ok && parsed.value.combatants[0].immune).toBeUndefined();
        expect(parsed.ok && parsed.value.combatants[0].element).toBeUndefined();
        expect(parsed.ok && parsed.drops.map(d => [d.field, d.value, d.reason])).toEqual([
            ['weak', 'earth', 'outside_preset'],
            ['immune', 'plasma', 'unknown'],
            ['element', 'lava', 'outside_preset'],
        ]);
        const fantasy = handleStartCombatTool(JSON.stringify({ reason: 'x', combatants: [{ name: 'Drone', weak: ['madness', 'lightning'] }] }), [], 'fantasy');
        expect(fantasy.toolResult).toBe(`${START_COMBAT_TOOL_RESULT}\n\nSome elements were dropped; the fight will not use them: Drone: weak "madness" was dropped (not an element of this setting).`);
        expect(elementToolNotes([{ name: 'A', field: 'immune', value: 'plasma', reason: 'unknown' }])).toEqual(['A: immune "plasma" was dropped (not an element).']);
    });

    it('leaves the tool result byte-identical when nothing was dropped', () => {
        expect(handleStartCombatTool(JSON.stringify({ reason: 'x', combatants: [{ name: 'Bandit' }] })).toolResult).toBe(START_COMBAT_TOOL_RESULT);
        expect(handleStartCombatTool(JSON.stringify({ reason: 'x', combatants: [{ name: 'Golem', weak: ['fire'] }] }), [], 'fantasy').toolResult).toBe(START_COMBAT_TOOL_RESULT);
    });

    it('passes the fields to the engine spec, merging the compendium', () => {
        const parsed = parseCombatArgs({ reason: 'x', combatants: [{ name: 'Golem', species: 'golem', weak: ['water'], element: 'earth' }] }, [], 'all');
        if (!parsed.ok) throw new Error('parse');
        const lookup = {
            modTables: { 'mod.enemies.compendium': [{ name: 'Golem', resistances: ['Immune: fire, poison'], tags: ['Mindless'] }] },
            settings: { moduleEnabled: { enemies: true } },
        };
        const [spec] = buildCombatantSpecs(parsed.value.combatants, lookup);
        expect(spec).toMatchObject({ weak: ['water'], immune: ['fire'], mindless: true, element: 'earth' });
        const [plain] = buildCombatantSpecs([{ name: 'Bandit', side: 'enemy', tier: 'grunt' }], {});
        expect(Object.keys(plain).filter(k => ['weak', 'resist', 'immune', 'mindless', 'element'].includes(k))).toEqual([]);
    });

    it('reads immunities, a mindless tag and an element from a compendium template', () => {
        expect(templateElements({ name: 'x', resistances: ['cold', 'Immune to lightning and water'], passiveTraits: ['A mindless husk'] }))
            .toEqual({ immune: ['lightning', 'water'], mindless: true });
        expect(templateElements({ name: 'x', immunities: ['frost'], mindless: false, element: 'Magma' })).toEqual({ immune: ['ice'], mindless: false, element: 'lava' });
        expect(templateElements({ name: 'x', resistances: ['fire'] })).toEqual({});
    });

    it('makes the engine drop and report what a fight preset does not hold', () => {
        const sheet = { abilities: { STR: 10, DEX: 14, CON: 14, INT: 16, WIS: 10, CHA: 10 }, budget: 'NORMAL' as const, level: 3, needsAllocation: false };
        const pc = buildPcCombatant({ name: 'Kira', sheet });
        const specs = buildCombatantSpecs([{ name: 'Drone', side: 'enemy', tier: 'grunt', weak: ['madness', 'ice'] }], {});
        const made = createCombat({ id: 'e', combatants: specs, elementPreset: 'fantasy' }, pc, 3);
        expect(made.elementDrops?.map(d => d.value)).toEqual(['madness']);
        const drone = Object.values(made.state.combatants).find(c => c.name === 'Drone') as Combatant;
        expect(drone.weak).toEqual(['ice']);
        const plain = createCombat({ id: 'e', combatants: buildCombatantSpecs([{ name: 'Bandit', side: 'enemy', tier: 'grunt' }], {}) }, pc, 3);
        expect(plain.state.elementPreset).toBeUndefined();
        expect(plain.elementDrops).toBeUndefined();
    });

    it('asks the manual start for the same fields with the active element list', () => {
        const prompt = buildManualStartPrompt([], 'Kira', 'modern');
        expect(prompt).toContain('weak, resist and immune are optional lists');
        expect(prompt).toContain(elementListLine('modern'));
    });
});

describe('abilities with elements (H2)', () => {
    const fire: GlyphAbility = { id: 'ab1', name: 'Flare', form: { id: 'burst', augments: [] }, effects: [{ id: 'damage', augments: [] }], element: 'fire', source: 'player' };

    it('keeps the element and the new glyphs through saving and loading', () => {
        expect(normalizeGlyphAbility(fire)).toEqual(fire);
        const sigil = { id: 'ab2', name: 'Trap', form: { id: 'sigil', augments: ['sustain'] }, effects: [{ id: 'snare', augments: [] }], source: 'player' };
        expect(normalizeGlyphAbility(sigil)).toEqual(sigil);
        const unknownElement = normalizeGlyphAbility({ ...fire, element: 'plasma' });
        expect(unknownElement?.name).toBe('Flare');
        expect('element' in (unknownElement ?? {})).toBe(false);
        expect(normalizeSpellbook({ abilities: [fire], equippedIds: ['ab1'] }).abilities[0].element).toBe('fire');
        expect(cleanAbility(fire).element).toBe('fire');
        const plain = cleanAbility({ ...fire, element: undefined });
        expect('element' in plain).toBe(false);
    });

    it('copies the chain element back in the builder draft', () => {
        const draft = draftFrom(fire);
        expect(draft.chain.element).toBe('fire');
        expect(toAbility(draft).element).toBe('fire');
        expect('element' in toAbility(blankDraft())).toBe(false);
    });

    it('flags an element outside the preset without refusing it', () => {
        expect(elementOutsidePreset(fire, 'modern')).toBe(false);
        expect(elementOutsidePreset({ element: 'earth' }, 'modern')).toBe(true);
        expect(elementOutsidePreset({}, 'modern')).toBe(false);
    });

    it('lets the ability proposal carry an element from the active list only', () => {
        const limits = abilityLimitsOf({ combatConfig: { combatElements: 'modern' } as never });
        expect(limits.elementPreset).toBe('modern');
        const ok = parseAbilityArgs({ name: 'Zap', form: 'projectile', effects: [{ effect: 'damage' }], element: 'Lightning' }, limits);
        expect(ok.ok && ok.ability.element).toBe('lightning');
        const outside = parseAbilityArgs({ name: 'Quake', form: 'projectile', effects: [{ effect: 'damage' }], element: 'earth' }, limits);
        expect(outside.ok).toBe(false);
        const unknown = handleProposeAbilityTool(JSON.stringify({ name: 'X', form: 'touch', effects: [{ effect: 'damage' }], element: 'plasma' }), limits);
        expect(unknown.toolResult).toContain('`element` must be one of kinetic, fire');
        const def = abilityTool(getToolDefinitions({ allowDiceTool: false, allowAbilityTool: true, elementPreset: 'fantasy' }));
        expect(def.function.parameters.properties.element.enum).toEqual(['fire', 'water', 'earth', 'lightning', 'ice', 'lava', 'steel', 'darkness', 'light', 'almighty', 'slime']);
        expect(JSON.stringify(def)).toMatch(/sigil \(a trap/);
        expect(JSON.stringify(def)).toMatch(/rewind \(the user returns/);
    });
});

const SHEET = { abilities: { STR: 10, DEX: 14, CON: 14, INT: 16, WIS: 10, CHA: 10 }, budget: 'NORMAL' as const, level: 3, needsAllocation: false };

function foe(id: string, x: number, overrides: Partial<Combatant> = {}): Combatant {
    return {
        id, name: id === 'f' ? 'Ghoul' : 'Raider', side: 'enemy', controller: 'engine', tier: 'grunt',
        abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        maxHp: 99, hp: 99, ac: 0, attackBonus: 3, damage: { count: 1, sides: 6, bonus: 0, type: 'slashing' },
        initiative: 5, status: 'up', conditions: [], position: { x, y: 5 }, range: 'close', ...overrides,
    };
}

function cast(element: ElementId, target: Partial<Combatant> = {}): { state: CombatState; events: CombatEvent[] } {
    const ability: GlyphAbility = { id: 'a', name: 'Bolt', element, form: { id: 'burst', augments: [] }, effects: [{ id: 'damage', augments: [] }], source: 'player' };
    const pc = { ...buildPcCombatant({ name: 'Kira', sheet: SHEET, kit: [ability] }), position: { x: 2, y: 5 }, hp: 99, maxHp: 99 };
    const base: CombatState = {
        id: 'w', round: 1, order: ['pc', 'f'], turnIndex: 0, combatants: { pc, f: foe('f', 7, target) },
        rngSeed: 7, rngCursor: 0, eventSeq: 0, outcome: null, turnCount: 1,
        grid: { width: 14, height: 10, tiles: new Array(140).fill('floor') },
    };
    const state = { ...base, turn: freshTurn(base, 'pc') };
    const out = applyAction(state, { type: 'use_ability', actorId: 'pc', abilityId: 'a', aim: { x: 7, y: 5 } });
    return { state: out.state, events: out.events };
}

function ev(type: string, data: Record<string, unknown>, extra: Partial<CombatEvent> = {}): CombatEvent {
    return { seq: 1, round: 1, type, data, text: 'engine text', actorId: 'pc', targetId: 'f', ...extra };
}

describe('narration and log lines (H4)', () => {
    it('narrates an elemental hit, its rider and the mark it leaves, with no numbers', () => {
        const { state, events } = cast('fire');
        const lines = events.map(e => [e.type, narrationLine(e, state)]);
        const byType = (type: string) => lines.filter(([t]) => t === type).map(([, l]) => l);
        expect(byType('element_rider')).toEqual(['Ghoul catches fire.']);
        expect(byType('ability_damage')[0]).toMatch(/^Ghoul .* fire\.$/);
        expect(byType('placed')).toEqual(['Flames spread across the ground.']);
        for (const [, line] of lines) expect(line).not.toMatch(/\d/);
    });

    it('says weak, resisted and immune on the hit, in the story and in the log', () => {
        const weak = cast('fire', { weak: ['fire'] });
        const weakHit = weak.events.find(e => e.type === 'ability_damage') as CombatEvent;
        expect(narrationLine(weakHit, weak.state)).toMatch(/fire, which it is weak to\.$/);
        expect(elementLogText(weakHit, weak.state)).toBe(`${weakHit.text} (weak)`);
        const resist = cast('ice', { resist: ['ice'] });
        const resisted = resist.events.find(e => e.type === 'ability_damage') as CombatEvent;
        expect(narrationLine(resisted, resist.state)).toMatch(/ice, which it resists\.$/);
        expect(elementLogText(resisted, resist.state)).toBe(`${resisted.text} (resisted)`);
        const immune = cast('mental', { mindless: true });
        const untouched = immune.events.find(e => e.type === 'ability_damage') as CombatEvent;
        expect(untouched.data.immune).toBe(true);
        expect(narrationLine(untouched, immune.state)).toBe('Ghoul is untouched by the mental.');
        expect(elementLogText(untouched, immune.state)).toBe(`${untouched.text} (immune)`);
    });

    it('has a line for every new event type and each rider, reaction and placed kind', () => {
        const { state } = cast('fire');
        const cases: Array<[CombatEvent, RegExp]> = [
            ...['burning', 'soaked', 'staggered', 'chilled', 'revealed', 'blinded', 'sticky', 'coated', 'dazed', 'confused'].map(rider => [ev('element_rider', { rider }), /Ghoul/] as [CombatEvent, RegExp]),
            [ev('burn', { damage: 1 }), /^Ghoul burns\.$/],
            [ev('confused', {}), /^Kira is confused and turns on Ghoul\.$/],
            ...['douse', 'cool', 'melt', 'burn_away', 'brighten', 'freeze', 'conduct'].map(reaction => [ev('reaction', { reaction }), /\./] as [CombatEvent, RegExp]),
            [ev('placed', { kind: 'sigil', ability: 'Snap' }), /lays a sigil/],
            [ev('placed', { kind: 'mantle', ability: 'Ember Cloak' }), /wraps themselves in Ember Cloak/],
            [ev('placed', { kind: 'wall', ability: 'Bulwark' }), /raises a wall/],
            [ev('placed', { kind: 'delay', ability: 'Slow Fuse' }), /readies Slow Fuse/],
            [ev('placed_triggered', { kind: 'sigil', ability: 'Snap' }), /^A sigil flares under Ghoul\.$/],
            [ev('placed_triggered', { kind: 'mantle', ability: 'Ember Cloak' }), /lashes Ghoul/],
            [ev('placed_triggered', { kind: 'wall', ability: 'Bulwark' }), /wall lashes Ghoul/],
            [ev('placed_triggered', { kind: 'delay', ability: 'Slow Fuse' }), /^Slow Fuse goes off\.$/],
            [ev('placed_triggered', { kind: 'delay', ability: 'Slow Fuse', missed: true }), /no one is there/],
            [ev('placed_ended', { kind: 'sigil', why: 'expired' }), /fades/],
            [ev('placed_ended', { kind: 'mark', why: 'expired', placed: { mark: 'flames' } }), /clear of flames/],
            [ev('dispelled', { friend: true }), /freed/],
            [ev('dispelled', { friend: false }), /stripped/],
            [ev('decayed', { amount: 3 }), /withers/],
            [ev('rewound', {}), /slips back/],
            [ev('gravity', { ability: 'Well' }), /^Well drags everything/],
            [ev('mark_harm', { mark: 'flames', damage: 1 }), /burned by the flames/],
            [ev('mark_harm', { mark: 'molten', immune: true, damage: 0 }), /unharmed/],
            [ev('condition_added', { condition: 'snared', glyph: true }), /^Ghoul is held fast\.$/],
            [ev('condition_added', { condition: 'feared', glyph: true }), /afraid/],
            [ev('condition_added', { condition: 'vanished', glyph: true }), /hidden from sight/],
            [ev('pushed', { rider: true, element: 'water', squares: 1 }), /knocked back by the water/],
            [ev('pushed', { kind: 'slide', squares: 1 }), /slides across the slick ground/],
            [ev('ability_damage', { element: 'lightning', arc: true, damage: 2 }), /arcs on to Ghoul/],
        ];
        for (const [event, pattern] of cases) {
            const line = narrationLine(event, state);
            expect(line, event.type).toMatch(pattern);
            expect(line).not.toMatch(/\d/);
        }
        for (const [event] of cases) {
            if (event.type === 'pushed' || event.type === 'ability_damage') continue;
            if (event.type === 'condition_added' || event.type === 'placed_ended') continue;
            expect(elementLogText(event, state), event.type).toBeTruthy();
        }
    });

    it('leaves old events and an element-free log exactly as they were', () => {
        const { state } = cast('fire');
        const old = [ev('attack', { hit: true, damage: 3 }), ev('ability_damage', { damage: 2, damageType: 'force' }), ev('condition_added', { condition: 'stunned' }), ev('pushed', { squares: 1 })];
        expect(translateElementEvents(old, state)).toEqual(old);
        expect(narrationLine(old[2], state)).toBe('Ghoul is stunned.');
        expect(narrationLine(old[3], state)).toBe('Ghoul is thrown back.');
        expect(narrationLine(old[1], state)).toMatch(/^Ghoul .* force\.$/);
    });

    it('tags weak, resisted and immune hits, reactions and sprung traps as moments', () => {
        const weak = cast('fire', { weak: ['fire'], maxHp: 999, hp: 999 });
        const hit = weak.events.find(e => e.type === 'ability_damage') as CombatEvent;
        const tags = momentTags({ ...weak.state, combatants: { ...weak.state.combatants } }, weak.events, hit.seq + 100);
        expect([...tags.values()]).toContain('first blood');
        const second = { ...hit, seq: hit.seq + 50 };
        const more = momentTags(weak.state, [...weak.events, second], second.seq);
        expect(more.get(second.seq)).toBe('a weak spot is struck');
        const crafted = [
            ev('confused', {}, { seq: 501 }),
            ev('rewound', {}, { seq: 502 }),
            ev('condition_added', { condition: 'vanished', glyph: true }, { seq: 503 }),
            ev('reaction', { reaction: 'douse' }, { seq: 504 }),
            ev('placed_triggered', { kind: 'sigil', ability: 'Snap' }, { seq: 505 }),
            ev('placed_triggered', { kind: 'delay', ability: 'Fuse' }, { seq: 506 }),
        ];
        const extra = momentTags(weak.state, [...weak.events, ...crafted], 600);
        expect(crafted.map(e => extra.get(e.seq))).toEqual([
            'confusion takes hold', 'a moment is undone', 'someone vanishes', 'the elements react', 'a trap is sprung', 'a delayed spell goes off',
        ]);
    });

    it('names the elements of the stretch in the beat directive, and only then', () => {
        const { state, events } = cast('ice');
        expect(elementsInEvents(events)).toEqual(['ice']);
        const session: CombatSession = { state, log: events, narratedThroughSeq: 0, startedAtMessageId: 'm', reason: '' };
        const directive = directiveForRange(session, { fromSeq: 0, toSeq: 999 }, 'side', 'standard');
        expect(directive).toContain(elementStakes(['ice']));
        expect(directive).toContain('Elements: ice (frost and cold).');
        const plain = directiveForRange({ ...session, log: events.filter(e => !e.data.element && e.type !== 'placed') }, { fromSeq: 0, toSeq: 999 }, 'side', 'standard');
        expect(plain).not.toContain('Elements:');
        expect(beatDirective()).not.toContain('Elements:');
    });
});
