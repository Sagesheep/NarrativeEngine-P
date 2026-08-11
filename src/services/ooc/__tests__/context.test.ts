import { describe, expect, it } from 'vitest';
import { buildOocContext } from '../context';
import type { OocCampaignSnapshot } from '../types';

/**
 * Phase 8.3 — the enemy OOC section left core with the rest of the enemy
 * logic. The mod (8.5) registers its own OOC section through
 * `ctx.oocSections.register(...)`, which `buildOocContext` splices in
 * through the generic registry. The three enemy-specific assertions that
 * were here (the live encounter roster, the compendium lookup, the
 * word-boundary guard) retired with the in-tree section; the mod's own
 * test suite will cover them post-8.5.
 */

const snapshot = {
    campaignId: 'campaign-1', provider: undefined, messages: [], semanticFacts: [], loreChunks: [], archiveIndex: [], npcLedger: [], locationLedger: [],
    context: {
        canonStateActive: false, canonState: '', sceneNoteActive: false, sceneNote: '', currentFeature: null, worldVibe: '',
        characterProfile: { identity: { name: 'Ari', race: 'Elf', class: 'Ranger', level: 4 }, stats: { dex: 16, wis: 14 }, activeTraits: [], legacyNotes: 'Do not include me.' },
        inventoryItems: Array.from({ length: 13 }, (_, index) => ({ id: `item-${index}`, name: `Item ${index}`, qty: index + 1, category: 'misc', equipped: index === 0, status: index === 1 ? 'damaged' : undefined })),
        notebookActive: true,
        notebook: Array.from({ length: 10 }, (_, index) => ({ id: `note-${index}`, text: `Note ${index}`, timestamp: index })),
    },
} as unknown as OocCampaignSnapshot;

const npc = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id, name, aliases: '', appearance: '', faction: '', storyRelevance: '', disposition: '',
    status: '', goals: '', voice: '', personality: '', exampleOutput: '', affinity: 0, ...extra,
});

const place = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id, name, aliases: '', broadLocation: '', features: [], connections: [], description: '',
    firstSeenScene: '1', lastSeenScene: '1', source: 'manual', ...extra,
});

const withLedgers = (patch: Partial<OocCampaignSnapshot>, contextPatch: Record<string, unknown> = {}) => ({
    ...snapshot, ...patch, context: { ...snapshot.context, ...contextPatch },
} as unknown as OocCampaignSnapshot);

describe('buildOocContext', () => {
    it('includes bounded data-only PC, inventory, and active notebook state', () => {
        const result = buildOocContext(snapshot, 'What equipment does Ari have?');
        expect(result.text).toContain('PC identity: Ari | Elf | Ranger | Level 4');
        expect(result.text).toContain('PC stats: DEX 16 | WIS 14');
        expect(result.text).toContain('Item 11 x12');
        expect(result.text).not.toContain('Item 12 x13');
        expect(result.text).toContain('Note 9');
        expect(result.text).not.toContain('Note 3');
        expect(result.text).not.toContain('Do not include me.');
        expect(result.sources).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'pc-identity' }),
            expect.objectContaining({ id: 'inventory-item-0' }),
            expect.objectContaining({ id: 'notebook-note-9' }),
        ]));
    });

    it('includes the character ledger sheet and non-superseded PC record traits', () => {
        const result = buildOocContext(withLedgers({}, {
            playerCharacter: npc('pc-1', 'Ari', {
                faction: 'Wardens',
                signatureKit: { equipment: ['Yew longbow'], abilities: ['hunters mark'] },
                pcRelation: 3,
            }),
            characterProfile: {
                ...snapshot.context.characterProfile,
                activeTraits: [
                    { id: 't1', subject: 'Ari', text: 'Sworn to the Wardens', importance: 9, superseded: false },
                    { id: 't2', subject: 'Ari', text: 'Stale oath', importance: 10, superseded: true },
                ],
            },
        }), 'Who am I loyal to?');
        expect(result.text).toContain('PC sheet (Ari): faction: Wardens');
        expect(result.text).toContain('kit: Yew longbow');
        expect(result.text).toContain('powers: hunters mark');
        expect(result.text).not.toContain('toward PC:');
        expect(result.text).toContain('Ari: Sworn to the Wardens');
        expect(result.text).not.toContain('Stale oath');
        expect(result.sources).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'pc-sheet' }),
            expect.objectContaining({ id: 'pc-trait-t1' }),
        ]));
    });

    it('pulls NPC ledger entries the question names and NPCs on stage in the recent transcript', () => {
        const result = buildOocContext(withLedgers({
            npcLedger: [
                npc('npc-1', 'Kaelen', { aliases: 'The Grey Fox', pcRelation: -2, condition: 'wounded' }),
                npc('npc-2', 'Mira', { goals: 'Reopen the north road' }),
                npc('npc-3', 'Ghost', { archived: true }),
                npc('npc-4', 'Unrelated', {}),
            ],
            messages: [{ id: 'm1', role: 'assistant', content: 'Mira waves from the gate.' }],
        }), 'Is the Grey Fox still hostile?');
        expect(result.text).toContain('Kaelen - aka The Grey Fox');
        expect(result.text).toContain('toward PC: Hostile');
        expect(result.text).toContain('condition: wounded');
        expect(result.text).toContain('Mira - goal: Reopen the north road');
        expect(result.text).not.toContain('Unrelated');
        expect(result.sources).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'npc', id: 'npc-1' })]));
    });

    it('keeps archived NPCs out unless the question names them directly', () => {
        const ledger = { npcLedger: [npc('npc-3', 'Ghost', { archived: true })], messages: [{ id: 'm1', role: 'assistant', content: 'The Ghost drifts past.' }] };
        expect(buildOocContext(withLedgers(ledger), 'What happens next?').text).not.toContain('Known characters');
        expect(buildOocContext(withLedgers(ledger), 'What became of Ghost?').text).toContain('Ghost - no longer in the active cast');
    });

    it('always includes the current place and any place the question names', () => {
        const result = buildOocContext(withLedgers({
            locationLedger: [
                place('loc-1', 'Ninja Academy', { broadLocation: 'Konoha', features: ['training yard'], connections: [{ toId: 'loc-2' }] }),
                place('loc-2', 'Market Square', { description: 'Crowded stalls.' }),
                place('loc-3', 'Far Tower', {}),
            ],
        }, { currentPlaceId: 'loc-1', currentFeature: 'training yard' }), 'How far is Market Square?');
        expect(result.text).toContain('Ninja Academy [PC is here now, at: training yard]');
        expect(result.text).toContain('region: Konoha');
        expect(result.text).toContain('connects to: Market Square');
        expect(result.text).toContain('Market Square - Crowded stalls.');
        expect(result.text).not.toContain('Far Tower');
        expect(result.sources).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'place', id: 'loc-1' })]));
    });

    it('does not match ledger names embedded inside longer words', () => {
        const result = buildOocContext(withLedgers({
            npcLedger: [npc('npc-1', 'Ari')],
            locationLedger: [place('loc-1', 'Mar')],
        }), 'What are the marching orders for the orchid?');
        expect(result.text).not.toContain('Known characters');
        expect(result.text).not.toContain('Known places');
    });
});
