import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '../../../store/useAppStore';
import { filterNPCs, filterPCOut } from '../../../utils/ledgerFilters';
import { buildPcKitLine } from '../../../services/payload/volatile';
import { selectPcBonds } from '../pcBonds';
import { buildPayload } from '../../../services/payload/payloadBuilder';
import type { NPCEntry, GameContext, AppSettings, CharacterProfileState } from '../../../types';

function makeNpc(name: string, extra: Partial<NPCEntry> = {}): NPCEntry {
    return {
        id: name.toLowerCase(),
        name,
        aliases: '',
        appearance: '',
        faction: '',
        storyRelevance: '',
        disposition: '',
        status: 'Alive',
        goals: '',
        voice: '',
        personality: '',
        exampleOutput: '',
        affinity: 50,
        ...extra,
    };
}

function makePc(name: string, extra: Partial<NPCEntry> = {}): NPCEntry {
    return makeNpc(name, { isPC: true, ...extra });
}

// ── Test 1: pcMeta typed write survives addNPC (regression for cast-after-add bug) ──
describe('WO-A §6.1: pcMeta typed write', () => {
    beforeEach(() => {
        useAppStore.setState({ npcLedger: [], activeCampaignId: 'test-campaign' } as Partial<ReturnType<typeof useAppStore.getState>>);
    });

    it('addNPC preserves pcMeta on the store copy when the entry has pcMeta set before addNPC', () => {
        const pcEntry = makePc('Hero', {
            pcMeta: { archetype: 'skirmisher', combatTier: 'Grunt', stats: { str: 14, dex: 12 } },
        });
        useAppStore.getState().addNPC(pcEntry);
        const stored = useAppStore.getState().npcLedger.find(n => n.isPC);
        expect(stored).toBeDefined();
        expect(stored!.pcMeta).toBeDefined();
        expect(stored!.pcMeta!.archetype).toBe('skirmisher');
        expect(stored!.pcMeta!.combatTier).toBe('Grunt');
        expect(stored!.pcMeta!.stats).toEqual({ str: 14, dex: 12 });
    });

    it('a PC entry without pcMeta does not synthesise one', () => {
        const pcEntry = makePc('Bare');
        useAppStore.getState().addNPC(pcEntry);
        const stored = useAppStore.getState().npcLedger.find(n => n.isPC);
        expect(stored).toBeDefined();
        expect(stored!.pcMeta).toBeUndefined();
    });
});

// ── Test 2: PC excluded from the NPC ledger ──
describe('WO-A §6.2: PC filtered out of the NPC ledger', () => {
    const npcA = makeNpc('Aria');
    const pc = makePc('PC');
    const npcB = makeNpc('Bram');

    it('filterPCOut drops the PC and keeps every other entry', () => {
        expect(filterPCOut([npcA, pc, npcB]).map(n => n.name)).toEqual(['Aria', 'Bram']);
        expect(filterPCOut([pc, npcA, npcB]).map(n => n.name)).toEqual(['Aria', 'Bram']);
        expect(filterPCOut([npcA, npcB, pc]).map(n => n.name)).toEqual(['Aria', 'Bram']);
    });

    it('does not mutate the input array', () => {
        const input = [npcA, pc, npcB];
        const snapshot = input.map(n => n.name);
        filterPCOut(input);
        expect(input.map(n => n.name)).toEqual(snapshot);
    });

    it('filterNPCs excludes the PC under all sort orders', () => {
        expect(filterNPCs([npcA, pc, npcB], '', 'none').map(n => n.name)).toEqual(['Aria', 'Bram']);
        expect(filterNPCs([npcB, pc, npcA], '', 'az').map(n => n.name)).toEqual(['Aria', 'Bram']);
        expect(filterNPCs([npcA, pc, npcB], '', 'za').map(n => n.name)).toEqual(['Bram', 'Aria']);
    });

    it('no PC in the list leaves order unchanged', () => {
        expect(filterPCOut([npcA, npcB]).map(n => n.name)).toEqual(['Aria', 'Bram']);
    });
});

// ── Test 3: bonds selector — non-archived, non-zero pcRelation, |value| desc ──
describe('WO-A §6.3: selectPcBonds', () => {
    it('returns only non-archived, non-PC NPCs with non-zero pcRelation, sorted by |value| desc', () => {
        const ledger: NPCEntry[] = [
            makeNpc('Zero', { pcRelation: 0 }),
            makeNpc('Undefined'),
            makeNpc('Foe', { pcRelation: -3 }),
            makeNpc('Ally', { pcRelation: 2 }),
            makeNpc('Archived', { pcRelation: 3, archived: true }),
            makePc('PC', { pcRelation: 3 }),
            makeNpc('Rival', { pcRelation: -1 }),
        ];
        const bonds = selectPcBonds(ledger);
        expect(bonds.map(n => n.name)).toEqual(['Foe', 'Ally', 'Rival']);
    });

    it('returns empty when no NPC has a non-zero pcRelation', () => {
        expect(selectPcBonds([makeNpc('A', { pcRelation: 0 }), makeNpc('B')])).toEqual([]);
    });

    it('ignores archived NPCs even with strong pcRelation', () => {
        const ledger: NPCEntry[] = [
            makeNpc('Gone', { pcRelation: 3, archived: true }),
            makeNpc('Here', { pcRelation: 1 }),
        ];
        expect(selectPcBonds(ledger).map(n => n.name)).toEqual(['Here']);
    });
});

// ── Test 4: volatile.ts PC kit line — present with kit, byte-identical without ──
describe('WO-A §6.4: buildPcKitLine + volatile payload', () => {
    const baseCtx = (): GameContext => ({
        loreRaw: '',
        rulesRaw: '',
        canonState: '',
        headerIndex: '',
        starter: '',
        continuePrompt: '',
        inventory: '',
        inventoryLastScene: 'Never',
        characterProfile: '',
        characterProfileLastScene: 'Never',
        surpriseDC: 95,
        encounterDC: 198,
        worldEventDC: 498,
        canonStateActive: false,
        headerIndexActive: false,
        starterActive: false,
        continuePromptActive: false,
        inventoryActive: false,
        characterProfileActive: false,
        surpriseEngineActive: true,
        encounterEngineActive: true,
        worldEngineActive: true,
        diceFairnessActive: true,
        sceneNote: '',
        sceneNoteActive: false,
        sceneNoteDepth: 3,
        diceConfig: { catastrophe: 2, failure: 6, success: 15, triumph: 19, crit: 20 },
        surpriseConfig: { initialDC: 95, dcReduction: 3, types: [], tones: [] },
        encounterConfig: { initialDC: 198, dcReduction: 2, types: [], tones: [] },
        worldVibe: '',
        notebook: [],
        notebookActive: true,
        worldEventConfig: { initialDC: 498, dcReduction: 2, who: [], where: [], why: [], what: [] },
        playerCharacter: null,
    } as GameContext);

    const baseSettings = (): AppSettings => ({ debugMode: true, contextLimit: 8192 } as unknown as AppSettings);

    const profileState: CharacterProfileState = {
        identity: { name: 'Hero', class: 'Fighter', level: 3 },
        activeTraits: [{
            id: 't1', subject: 'Hero', category: 'party_facts', text: 'A seasoned fighter',
            importance: 7, eventTags: ['other'], sceneEstablished: '', superseded: false, source: 'seed',
        }],
    };

    it('buildPcKitLine emits "Kit:" line when PC has a kit with equipment', () => {
        const pc = makePc('Hero', { signatureKit: { equipment: ['Excalibur', 'shield'], abilities: ['fire magic'], element: 'fire' } });
        const line = buildPcKitLine(pc);
        expect(line).toContain('Kit:');
        expect(line).toContain('Excalibur, shield');
        expect(line).toContain('Powers: fire magic');
        expect(line).toContain('element: fire');
    });

    it('buildPcKitLine omits empty segments', () => {
        const pc = makePc('Hero', { signatureKit: { equipment: ['sword'], abilities: [] } });
        const line = buildPcKitLine(pc);
        expect(line).toContain('Kit: sword');
        expect(line).not.toContain('Powers:');
        expect(line).not.toContain('element:');
    });

    it('buildPcKitLine returns empty string when PC has no kit', () => {
        expect(buildPcKitLine(makePc('Hero'))).toBe('');
    });

    it('buildPcKitLine returns empty string when there is no PC', () => {
        expect(buildPcKitLine(null)).toBe('');
        expect(buildPcKitLine(undefined)).toBe('');
    });

    it('buildPcKitLine falls back to legacy npcLedger.isPC when playerCharacter is null (defensive)', () => {
        const pc = makePc('Hero', { signatureKit: { equipment: ['x'], abilities: [] } });
        expect(buildPcKitLine(null, [pc])).toContain('Kit: x');
    });

    it('volatile profile block contains "Kit:" when PC has a kit (integration via buildPayload)', () => {
        const ctx = {
            ...baseCtx(),
            smartBookkeepingActive: false,
            characterProfileActive: true,
            characterProfile: profileState,
            characterProfileLastScene: 'Never',
            playerCharacter: makePc('Hero', { signatureKit: { equipment: ['Excalibur'], abilities: ['fire magic'], element: 'fire' } }),
        } as unknown as GameContext;
        const result = buildPayload({
            settings: baseSettings(),
            context: ctx,
            history: [],
            userMessage: 'What do I have?',
            npcLedger: [],
        });
        const allContent = result.messages.map(m => m.content as string).join('\n');
        expect(allContent).toContain('[CHARACTER PROFILE]');
        expect(allContent).toContain('Kit: Excalibur');
        expect(allContent).toContain('Powers: fire magic');
        expect(allContent).toContain('element: fire');
    });

    it('volatile profile block is byte-identical to pre-kit when PC has no kit (regression guard)', () => {
        const ctx = {
            ...baseCtx(),
            smartBookkeepingActive: false,
            characterProfileActive: true,
            characterProfile: profileState,
            characterProfileLastScene: 'Never',
            playerCharacter: makePc('Hero'),
        } as unknown as GameContext;
        const withPcResult = buildPayload({
            settings: baseSettings(),
            context: ctx,
            history: [],
            userMessage: 'What do I have?',
            npcLedger: [],
        });
        const noPcResult = buildPayload({
            settings: baseSettings(),
            context: { ...ctx, playerCharacter: null },
            history: [],
            userMessage: 'What do I have?',
            npcLedger: [],
        });
        const withPc = withPcResult.messages.map(m => m.content as string).join('\n');
        const noPc = noPcResult.messages.map(m => m.content as string).join('\n');
        // A PC entry without a kit must not change the profile block.
        expect(withPc).toBe(noPc);
        expect(withPc).not.toContain('Kit:');
    });
});