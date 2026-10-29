import { describe, it, expect } from 'vitest';
import { migratePCIntoContext } from '../migratePC';
import type { NPCEntry, GameContext } from '../../../types';

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

function baseCtx(): GameContext {
    return {
        loreRaw: '',
        rulesRaw: '',
        canonState: '',
        headerIndex: '',
        starter: '',
        continuePrompt: '',
        inventory: '',
        inventoryLastScene: 'Never',
        characterProfile: { identity: {}, activeTraits: [] },
        characterProfileLastScene: 'Never',
        inventoryItems: [],
        characterProfileData: { name: '', race: '', class: '', level: 1, hp: { current: 20, max: 20 }, stats: {}, skills: [], abilities: [], traits: [], notes: '' },
        smartBookkeepingActive: true,
        surpriseEngineActive: false,
        encounterEngineActive: true,
        worldEngineActive: true,
        diceFairnessActive: true,
        canonStateActive: false,
        headerIndexActive: false,
        starterActive: false,
        continuePromptActive: false,
        inventoryActive: false,
        characterProfileActive: false,
        sceneNote: '',
        sceneNoteActive: false,
        sceneNoteDepth: 3,
        notebook: [],
        notebookActive: true,
        worldVibe: '',
        playerCharacter: null,
    } as unknown as GameContext;
}

describe('migratePCIntoContext', () => {
    it('moves an isPC row from npcLedger into context.playerCharacter', () => {
        const pc = makePc('Hero', { signatureKit: { equipment: ['Excalibur'], abilities: [] } });
        const npcA = makeNpc('Aria');
        const npcB = makeNpc('Bram');
        const ctx = baseCtx();
        const ledger = [npcA, pc, npcB];

        const { context, npcLedger, migrated } = migratePCIntoContext(ctx, ledger);

        expect(migrated).toBe(true);
        expect(npcLedger.map(n => n.name)).toEqual(['Aria', 'Bram']);
        expect(context.playerCharacter).toBeDefined();
        expect(context.playerCharacter!.name).toBe('Hero');
        expect(context.playerCharacter!.signatureKit?.equipment).toEqual(['Excalibur']);
    });

    it('is idempotent: a second call on already-migrated state is a no-op', () => {
        const pc = makePc('Hero');
        const npcA = makeNpc('Aria');
        const ctx = baseCtx();
        const ledger = [npcA, pc];

        const first = migratePCIntoContext(ctx, ledger);
        expect(first.migrated).toBe(true);

        const second = migratePCIntoContext(first.context, first.npcLedger);
        expect(second.migrated).toBe(false);
        expect(second.npcLedger.map(n => n.name)).toEqual(['Aria']);
        expect(second.context.playerCharacter!.name).toBe('Hero');
    });

    it('drops a stray isPC row when playerCharacter already exists (defensive — keeps existing PC)', () => {
        const existingPc = makePc('Original', { id: 'pc-original' });
        const strayPc = makePc('Stray', { id: 'pc-stray' });
        const npcA = makeNpc('Aria');
        const ctx = { ...baseCtx(), playerCharacter: existingPc };
        const ledger = [npcA, strayPc];

        const { context, npcLedger, migrated } = migratePCIntoContext(ctx, ledger);

        expect(migrated).toBe(false);
        expect(npcLedger.map(n => n.name)).toEqual(['Aria']);
        expect(context.playerCharacter!.name).toBe('Original');
        expect(context.playerCharacter!.id).toBe('pc-original');
    });

    it('returns unchanged state when there is no isPC row', () => {
        const npcA = makeNpc('Aria');
        const npcB = makeNpc('Bram');
        const ctx = baseCtx();
        const ledger = [npcA, npcB];

        const { context, npcLedger, migrated } = migratePCIntoContext(ctx, ledger);

        expect(migrated).toBe(false);
        expect(npcLedger.map(n => n.name)).toEqual(['Aria', 'Bram']);
        expect(context.playerCharacter).toBeNull();
    });

    it('strips multiple isPC rows (buggy state) and keeps the first as the PC', () => {
        const pcA = makePc('HeroA', { id: 'pc-a' });
        const pcB = makePc('HeroB', { id: 'pc-b' });
        const npcA = makeNpc('Aria');
        const ctx = baseCtx();
        const ledger = [pcA, npcA, pcB];

        const { context, npcLedger, migrated } = migratePCIntoContext(ctx, ledger);

        expect(migrated).toBe(true);
        expect(npcLedger.map(n => n.name)).toEqual(['Aria']);
        expect(context.playerCharacter!.name).toBe('HeroA');
    });

    it('does not mutate the input arrays', () => {
        const pc = makePc('Hero');
        const npcA = makeNpc('Aria');
        const ctx = baseCtx();
        const ledgerSnapshot = [npcA, pc];
        const ledger = [...ledgerSnapshot];

        migratePCIntoContext(ctx, ledger);

        expect(ledger.map(n => n.name)).toEqual(['Aria', 'Hero']);
    });
});