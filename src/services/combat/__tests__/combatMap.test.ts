import { describe, it, expect } from 'vitest';
import { buildPcCombatant } from '@narrative/engine';
import { combatMapTexts, resolveCombatMap } from '../combatMap';
import { parseCombatArgs } from '../combatProposal';
import { positionPhrase, narrationLine } from '../combatEvents';
import { getToolDefinitions, handleStartCombatTool } from '../../turn/toolHandlers';
import { buildManualStartPrompt } from '../combatManualStart';
import { normalizeCombatSession } from '../../tables/combatTable';
import type { CombatEvent, CombatProposal, CombatSheet, CombatState, Combatant, LocationEntry } from '../../../types';

const location = (patch: Partial<LocationEntry>): LocationEntry => ({
    id: 'loc1', name: 'Somewhere', aliases: '', broadLocation: '', features: [], connections: [], description: '',
    firstSeenScene: '1', lastSeenScene: '1', source: 'llm', ...patch,
});

const proposal = (patch: Partial<CombatProposal> = {}): CombatProposal => ({
    id: 'p', messageId: 'm', reason: '', source: 'tool', combatants: [{ name: 'Rat', side: 'enemy', tier: 'minion' }], ...patch,
});

describe('T3 host inference order', () => {
    it('uses place, then reason, then the current location name, description and biome', () => {
        const ledger = [location({ name: 'The Rusty Anchor', description: 'A tavern by the docks', terrainBiome: 'swamp' })];
        const state = { context: { currentPlaceId: 'loc1' }, locationLedger: ledger };
        expect(combatMapTexts(proposal({ reason: 'They attack.' }), state)).toEqual(['They attack.', 'The Rusty Anchor', 'A tavern by the docks', 'swamp']);
        expect(resolveCombatMap(proposal({ map: { place: 'server room' }, reason: 'in the alley' }), state).area).toBe('rows');
        expect(resolveCombatMap(proposal({ reason: 'Ambush in the alley' }), state).area).toBe('street');
        expect(resolveCombatMap(proposal({ reason: 'They attack.' }), state).area).toBe('room');
        expect(resolveCombatMap(proposal({ reason: 'They attack.' }), { context: { currentPlaceId: null }, locationLedger: ledger }).area).toBe('scattered');
        expect(resolveCombatMap(proposal({ map: { area: 'cavern' }, reason: 'in the alley' }), state).area).toBe('cavern');
    });

    it('sizes the map from the roster unless the proposal fixed it', () => {
        const many = Array.from({ length: 8 }, (_, i) => ({ name: `Rat ${i}`, side: 'enemy' as const, tier: 'minion' as const }));
        expect(resolveCombatMap(proposal({ combatants: many }), { context: {} }).size).toBe('large');
        expect(resolveCombatMap(proposal({ map: { size: 'small' }, combatants: many }), { context: {} }).size).toBe('small');
        expect(resolveCombatMap(proposal({ reason: 'on the rampart' }), { context: {} }).size).toBe('medium');
    });
});

describe('T5 tool and parsing', () => {
    it('asks for an area, not a layout', () => {
        const tool = (getToolDefinitions({ allowDiceTool: false, allowCombatTool: true }) as Array<{ function: { name: string; parameters: { properties: Record<string, { properties?: Record<string, { enum?: string[] }> }> } } }>)
            .find(t => t.function.name === 'start_combat');
        const map = tool?.function.parameters.properties.map.properties ?? {};
        expect(Object.keys(map).sort()).toEqual(['area', 'density', 'hazard', 'labels', 'place']);
        expect(map.area.enum).toHaveLength(10);
    });

    it('accepts the new map shape, old fields and string-encoded objects, and drops the size the model sends', () => {
        const parsed = parseCombatArgs({ combatants: [{ name: 'Ghoul' }], reason: '', map: { area: 'Scattered', density: 'dense', hazard: 'toxic', labels: JSON.stringify({ cover: 'Tombstones' }), place: 'old graveyard', size: 'large' } });
        expect(parsed.ok && parsed.value.map).toEqual({ area: 'scattered', density: 'dense', hazard: 'toxic', labels: { cover: 'tombstones' }, place: 'old graveyard' });
        const legacy = handleStartCombatTool(JSON.stringify({ combatants: [{ name: 'Bandit' }], reason: 'x', map: JSON.stringify({ size: 'medium', theme: 'forest road', features: [{ kind: 'overturned cart', where: 'centre' }] }) }));
        expect(legacy.proposal?.map).toEqual({ place: 'forest road, overturned cart' });
    });

    it('asks the manual start extraction for the same map object', () => {
        const prompt = buildManualStartPrompt([], 'Kira');
        expect(prompt).toContain('"map":{"area":');
        expect(prompt).toContain('do not describe positions');
    });
});

describe('T5 narration uses the labels', () => {
    const sheet: CombatSheet = { abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 3, needsAllocation: false };
    const foe: Combatant = {
        id: 'e', name: 'Ghoul', side: 'enemy', controller: 'engine', tier: 'grunt', abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        maxHp: 10, hp: 10, ac: 11, attackBonus: 3, damage: { count: 1, sides: 6, bonus: 0, type: 'slashing' }, initiative: 1, status: 'up', conditions: [], position: { x: 4, y: 0 },
    };
    const state = (labels?: Record<string, string>): CombatState => ({
        id: 's', round: 1, order: ['pc', 'e'], turnIndex: 0, rngSeed: 1, rngCursor: 0, eventSeq: 0, outcome: null, turnCount: 1,
        combatants: { pc: { ...buildPcCombatant({ name: 'Kira', sheet }), position: { x: 0, y: 0 } }, e: foe },
        grid: { width: 6, height: 1, tiles: ['floor', 'floor', 'cover', 'floor', 'floor', 'floor'], ...(labels ? { labels } : {}) },
    });

    it('says behind the tombstones instead of behind cover, with no coordinates', () => {
        expect(positionPhrase(state({ cover: 'tombstones' }), foe)).toBe('behind the tombstones');
        expect(positionPhrase(state(), foe)).toBe('behind cover');
    });

    it('names the hazard by its label', () => {
        const event: CombatEvent = { seq: 1, round: 1, type: 'hazard', targetId: 'e', data: { damage: 3, damageType: 'electric' }, text: '' };
        expect(narrationLine(event, state({ hazard: 'plasma conduits' }))).toBe('Ghoul is hurt by the plasma conduits underfoot.');
    });
});

describe('T1 sessions saved by the previous build', () => {
    it('loads a stored session whose map and grid use the old shape', () => {
        const pc = { ...buildPcCombatant({ name: 'Kira', sheet: { abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 1, needsAllocation: false } }), position: { x: 0, y: 0 } };
        const raw = {
            state: {
                id: 'old', round: 2, order: ['pc'], turnIndex: 0, combatants: { pc }, rngSeed: 1, rngCursor: 4, eventSeq: 3, outcome: null, turnCount: 3,
                turn: { actorId: 'pc', moveLeft: 6, actionUsed: false },
                grid: { width: 4, height: 4, tiles: new Array(16).fill('floor'), theme: 'tavern', hazardType: 'fire' },
            },
            log: [], narratedThroughSeq: 0, startedAtMessageId: 'm', reason: 'Brawl',
            map: { size: 'small', theme: 'tavern', features: [{ kind: 'tables', where: 'scattered' }] },
        };
        const session = normalizeCombatSession(raw);
        expect(session?.state.grid?.area).toBe('open');
        expect(session?.state.grid?.labels).toEqual({ wall: 'wall', cover: 'crates', difficult: 'rough ground', hazard: 'fire' });
        expect(session?.state.grid?.tiles).toEqual(raw.state.grid.tiles);
        expect(session?.state.combatants.pc.position).toEqual({ x: 0, y: 0 });
    });
});
