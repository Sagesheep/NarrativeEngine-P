import { describe, expect, it } from 'vitest';
import { parsePresentHeader, resolvePresentNpcs } from '../presentHeader';
import type { NPCEntry } from '../../../types';

const npc = (id: string, name: string, aliases = '') => ({ id, name, aliases }) as NPCEntry;
const ledger = [npc('n1', 'Rin Holmes'), npc('n2', 'Helena Broadmarsh'), npc('n3', 'Lao Cheng'), npc('n4', 'The Broker', 'Name Unknown')];

describe('parsePresentHeader', () => {
    it('reads the default ruleset shape', () => {
        expect(parsePresentHeader('📅 [Time] Day 3 | 📍 [Location] Docks | 👥 [Present] Rin, Mira')).toEqual(['Rin', 'Mira']);
    });

    it('reads a labeled shape', () => {
        expect(parsePresentHeader('👥 Present: Rin; Mira')).toEqual(['Rin', 'Mira']);
    });

    it('reads a bold label (a closing header some GMs repeat at the end of the reply)', () => {
        expect(parsePresentHeader('👥 **Present:** [**Grey**], [**Rin**], [**Sanna**]')).toEqual(['Grey', 'Rin', 'Sanna']);
    });

    // The shapes the owner's campaigns actually use (none carry the "[Present]" label).
    it('reads bracketed, bold names', () => {
        expect(parsePresentHeader('Scene #250 | 📅 Night | 📍 Study | 👥 [**Rin**], [**Helena Broadmarsh**], The Voice (Sensed)'))
            .toEqual(['Rin', 'Helena Broadmarsh', 'The Voice']);
    });

    it('reads a bracketed list with descriptors', () => {
        expect(parsePresentHeader('📍 [A village] | 👥 [Headman **Lao Cheng**, grieving boy]')).toEqual(['Headman Lao Cheng', 'grieving boy']);
    });

    it('"Nobody" is an empty list, not a missing header', () => {
        expect(parsePresentHeader('📍 Smuggler\'s Ditch | 👥 Nobody')).toEqual([]);
    });

    it('a reply with no 👥 field is null', () => {
        expect(parsePresentHeader('The rain keeps falling.')).toBeNull();
    });

    it('the last 👥 field wins (the scene moved mid-reply)', () => {
        expect(parsePresentHeader('👥 [**Rin**]\n\nLater…\n\n📍 Study | 👥 [**Helena**]')).toEqual(['Helena']);
    });

    it('drops placeholders that name nobody', () => {
        expect(parsePresentHeader('👥 Unknown, Rin')).toEqual(['Rin']);
    });
});

describe('resolvePresentNpcs', () => {
    it('resolves short names, titles and bold, each NPC once; descriptors resolve to nothing', () => {
        const names = ['Rin', 'Headman Lao Cheng', 'grieving boy', 'Rin Holmes'];
        expect(resolvePresentNpcs(names, ledger).map(n => n.id)).toEqual(['n1', 'n3']);
    });
});
