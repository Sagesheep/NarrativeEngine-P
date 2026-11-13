import { describe, it, expect } from 'vitest';
import { COMBAT_EVENT_TYPES, STARTER_ABILITIES, buildPcCombatant, createCombat, applyAction, chooseEngineTurn, currentActorId, runEngineTurns } from '@narrative/engine';
import type { CombatEvent, CombatState, GlyphAbility } from '@narrative/engine';
import { applyCombatSheet, guardMpPatch, isSheetMirrorStale, remirrorCombatSheet } from '../combatSheet';
import { applyProfilePatch } from '../../characterProfileParser';
import { buildPcInput, buildResultText, equippedKit } from '../combatController';
import { NARRATED_EVENT_TYPES, groupEventsByTurn, narrationLine, stateAtSeq, turnLines } from '../combatEvents';
import { buildCombatBlock } from '../combatNarration';
import { migrateLegacyContext, normalizeSpellbook, DEFAULT_COMBAT_CONFIG } from '../../../types';
import type { CombatSheet, GameContext } from '../../../types';

const sheet: CombatSheet = {
    abilities: { STR: 10, DEX: 14, CON: 14, INT: 16, WIS: 10, CHA: 8 },
    budget: 'NORMAL',
    level: 3,
    needsAllocation: false,
};

const bolt = STARTER_ABILITIES.find(a => a.id === 'fire-bolt') as GlyphAbility;
const fireball = STARTER_ABILITIES.find(a => a.id === 'fireball') as GlyphAbility;

function contextWith(patch: Partial<GameContext> = {}): GameContext {
    return migrateLegacyContext({
        combatModeActive: true,
        combatSheet: sheet,
        characterProfileData: {
            name: 'Kira', race: 'Human', class: 'Mage', level: 3,
            hp: { current: 20, max: 20 }, stats: {}, skills: [], abilities: ['Old free-text ability'], traits: [], notes: '',
        },
        ...patch,
    });
}

describe('MP on the sheet (T4)', () => {
    it('mirrors max MP from the sheet and keeps current MP within it', () => {
        const patch = applyCombatSheet(contextWith(), sheet);
        expect(patch.characterProfileData?.mp).toEqual({ current: 16, max: 16 });
        const low = applyCombatSheet(contextWith({ characterProfileData: { ...contextWith().characterProfileData, mp: { current: 3, max: 99 } } }), sheet);
        expect(low.characterProfileData?.mp).toEqual({ current: 3, max: 16 });
    });

    it('locks max MP against AI edits while combat is on', () => {
        expect(guardMpPatch({ current: 5, max: 16 }, { current: 40, max: 40 }, true)).toEqual({ current: 16, max: 16 });
        expect(guardMpPatch({ current: 5, max: 16 }, { current: 40, max: 40 }, false)).toEqual({ current: 40, max: 40 });
        const profile = { ...contextWith().characterProfileData, mp: { current: 10, max: 16 } };
        expect(applyProfilePatch(profile, { mp: { current: 2, max: 50 } }, true).mp).toEqual({ current: 2, max: 16 });
        expect(applyProfilePatch(profile, { mp: { current: 2, max: 50 } }, false).mp).toEqual({ current: 2, max: 50 });
    });

    it('re-mirrors a drifted max HP or MP and leaves a matching one alone (C11)', () => {
        const fresh = { ...contextWith(), ...applyCombatSheet(contextWith(), sheet) } as GameContext;
        expect(isSheetMirrorStale(fresh)).toBe(false);
        expect(remirrorCombatSheet(fresh)).toEqual({});
        const drifted = { ...fresh, characterProfileData: { ...fresh.characterProfileData, mp: { current: 30, max: 30 } } };
        expect(isSheetMirrorStale(drifted)).toBe(true);
        expect(remirrorCombatSheet(drifted).characterProfileData?.mp).toEqual({ current: 16, max: 16 });
        expect(remirrorCombatSheet({ ...drifted, combatModeActive: false })).toEqual({});
    });
});

describe('spellbook storage (C10)', () => {
    it('gives old campaigns an empty spellbook and keeps the free-text abilities', () => {
        const ctx = migrateLegacyContext({ loreRaw: 'old world' });
        expect(ctx.spellbook).toEqual({ abilities: [], equippedIds: [] });
        expect(contextWith().characterProfileData.abilities).toEqual(['Old free-text ability']);
    });

    it('normalises shape only: drops broken entries, duplicate ids and unknown equipped ids', () => {
        const book = normalizeSpellbook({
            abilities: [bolt, { ...bolt }, { id: 'x', name: 'Bad', form: { id: 'laser', augments: [] }, effects: [] }, 'junk',
                { ...fireball, effects: [{ id: 'damage', augments: ['amplify', 'bogus'] }] }],
            equippedIds: ['fire-bolt', 'missing', 'fire-bolt', 'fireball'],
        });
        expect(book.abilities.map(a => a.id)).toEqual(['fire-bolt', 'fireball']);
        expect(book.abilities[1].effects[0].augments).toEqual(['amplify']);
        expect(book.equippedIds).toEqual(['fire-bolt', 'fireball']);
        expect(normalizeSpellbook(undefined)).toEqual({ abilities: [], equippedIds: [] });
        expect(migrateLegacyContext(migrateLegacyContext({ spellbook: book })).spellbook).toEqual(book);
    });
});

describe('the fight snapshots the equipped abilities (C1)', () => {
    it('copies only valid equipped abilities, up to the equip limit, into the PC kit with its MP', () => {
        const overLong: GlyphAbility = { ...fireball, id: 'big', effects: [{ id: 'damage', augments: ['amplify', 'amplify'] }, { id: 'slow', augments: ['extend'] }], form: { id: 'burst', augments: ['widen'] } };
        const ctx = contextWith({
            spellbook: { abilities: [bolt, fireball, overLong], equippedIds: ['fireball', 'big', 'fire-bolt'] },
            combatConfig: { ...DEFAULT_COMBAT_CONFIG, maxEquippedAbilities: 1 },
            characterProfileData: { ...contextWith().characterProfileData, mp: { current: 5, max: 16 } },
        });
        expect(equippedKit(ctx).map(a => a.id)).toEqual(['fireball']);
        const input = buildPcInput({ context: ctx, inventoryItems: [] })!;
        expect(input.mpCurrent).toBe(5);
        const pc = buildPcCombatant(input);
        expect(pc).toMatchObject({ mp: 5, maxMp: 16, castingAbility: 'INT' });
        expect(pc.kit?.map(a => a.id)).toEqual(['fireball']);
        expect(buildPcInput({ context: contextWith(), inventoryItems: [] })!.kit).toEqual([]);
    });
});

function playCasterFight(): { state: CombatState; log: CombatEvent[] } {
    const pc = buildPcCombatant({ name: 'Kira', sheet, kit: [bolt, fireball, STARTER_ABILITIES.find(a => a.id === 'aqua-elemental') as GlyphAbility] });
    const start = createCombat({
        id: 'beats',
        combatants: [
            { name: 'Bandit 1', side: 'enemy', tier: 'grunt' },
            { name: 'Bandit 2', side: 'enemy', tier: 'grunt' },
            { name: 'Hexer', side: 'enemy', tier: 'elite', archetype: 'caster', look: 'frost hexer' },
        ],
        mapSeed: 9,
    }, pc, 2024);
    let state = start.state;
    const log = [...start.events];
    let summoned = false;
    for (let i = 0; i < 400 && !state.outcome; i++) {
        const engine = runEngineTurns(state);
        state = engine.state;
        log.push(...engine.events);
        if (state.outcome) break;
        const id = currentActorId(state)!;
        let action = chooseEngineTurn(state, id).actions[0];
        if (!summoned && state.turn?.actionUsed === false) {
            const adj = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]
                .map(d => ({ x: state.combatants.pc.position!.x + d.x, y: state.combatants.pc.position!.y + d.y }));
            for (const aim of adj) {
                const tried = applyAction(state, { type: 'use_ability', actorId: id, abilityId: 'aqua-elemental', aim });
                if (!tried.events.some(e => e.type === 'rejected')) {
                    action = { type: 'use_ability', actorId: id, abilityId: 'aqua-elemental', aim };
                    summoned = true;
                    break;
                }
            }
        }
        let step = applyAction(state, action);
        if (step.events.some(e => e.type === 'rejected')) step = applyAction(state, { type: 'end_turn', actorId: id });
        state = step.state;
        log.push(...step.events);
    }
    return { state, log };
}

describe('log and narration for ability events (T8, C14)', () => {
    it('has an explicit number-free line for every event type the engine produces', () => {
        expect([...COMBAT_EVENT_TYPES].sort()).toEqual([...NARRATED_EVENT_TYPES].sort());
    });

    it('a golden fight with abilities produces beat lines with no numbers and log lines with them', () => {
        const { state, log } = playCasterFight();
        const types = new Set(log.map(e => e.type));
        expect(types.has('ability')).toBe(true);
        expect(types.has('summoned')).toBe(true);
        const names = Object.values(state.combatants).map(c => c.name);
        const beats = groupEventsByTurn(log).flatMap(g => turnLines(g, state, { numbers: false }));
        const stripped = beats.map(line => names.reduce((l, n) => l.split(n).join(''), line));
        expect(stripped.filter(l => /\d/.test(l))).toEqual([]);
        expect(beats.some(l => /uses Fire(ball| bolt) \(fire\)/.test(l))).toBe(true);
        expect(beats.some(l => /calls up Aqua elemental/.test(l))).toBe(true);
        const logs = groupEventsByTurn(log).flatMap(g => turnLines(g, state, { numbers: true }));
        expect(logs.some(l => /\(\d+ MP\)/.test(l))).toBe(true);
        const lines = log.map(e => names.reduce((l, n) => l.split(n).join(''), narrationLine(e, state)));
        expect(lines.filter(l => /\d/.test(l))).toEqual([]);
    });

    it('rebuilds past state for beats: positions, HP and summons before they existed', () => {
        const { state, log } = playCasterFight();
        const summon = log.find(e => e.type === 'summoned')!;
        const before = stateAtSeq(state, log, summon.seq - 1);
        expect(before.combatants[summon.targetId!].status).toBe('gone');
        const block = buildCombatBlock(state, log, { fromSeq: 1, toSeq: summon.seq - 1 });
        const roster = block.split('\n').filter(l => l.startsWith('- '));
        expect(roster.some(l => l.includes(state.combatants[summon.targetId!].name))).toBe(false);
        const after = buildCombatBlock(state, log, { fromSeq: summon.seq, toSeq: summon.seq });
        expect(after.split('\n').filter(l => l.startsWith('- ')).some(l => l.includes(state.combatants[summon.targetId!].name))).toBe(true);
        const start = stateAtSeq(state, log, 2);
        for (const c of Object.values(start.combatants)) {
            if (!c.summonerId) expect(c.hp).toBe(c.maxHp);
        }
        expect(start.barriers ?? []).toEqual([]);
    });

    it('leaves summons out of the result text', () => {
        const { state } = playCasterFight();
        expect(buildResultText(state)).not.toContain('Aqua elemental');
    });
});
