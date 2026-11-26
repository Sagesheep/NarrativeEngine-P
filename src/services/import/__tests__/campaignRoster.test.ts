import { describe, expect, it } from 'vitest';
import { prepareRosterFile } from '../campaignRoster';
import { buildCardPng } from './pngFixture';

const card = { spec: 'chara_card_v2', data: {
    name: 'Mira', description: 'An archivist.', personality: 'Curious',
    character_book: { entries: [{ keys: ['Library'], content: 'The library floats.', enabled: true }] },
} };
function jsonFile(value: unknown) {
    return { name: 'mira.json', text: async () => JSON.stringify(value) } as File;
}
describe('campaign roster staging', () => {
    it('creates a populated NPC while keeping embedded lore opt-in', async () => {
        const entry = await prepareRosterFile(jsonFile(card), false);
        expect(entry.npc.name).toBe('Mira');
        expect(entry.npc.populated).toBe(true);
        expect(entry.loreChunks).toHaveLength(1);
        expect(entry.includeLore).toBe(false);
        expect(entry.portraitFile).toBeUndefined();
    });
    it('retains the source PNG for portrait upload', async () => {
        const file = { name: 'mira.png', arrayBuffer: async () => buildCardPng(card) } as File;
        const entry = await prepareRosterFile(file, false);
        expect(entry.portraitFile).toBe(file);
        expect(entry.npc.name).toBe('Mira');
    });
    it('rejects ledger exports and lorebooks instead of creating an empty NPC', async () => {
        await expect(prepareRosterFile(jsonFile([{ name: 'Mira' }]), false)).rejects.toThrow('ledger exports');
        await expect(prepareRosterFile(jsonFile({ entries: [] }), false)).rejects.toThrow('not a character card');
    });
});
