import { describe, it, expect } from 'vitest';
import {
    CARD_OWNED_FIELDS,
    cardLoreGroup,
    findExistingByName,
    normalizeName,
    overwriteImportedNPC,
    replaceCardLoreGroup,
} from '../importOverwrite';
import { DEFAULT_VISUAL_PROFILE } from '../../../types';
import type { Goal, LoreChunk, NPCEntry } from '../../../types';

/** Every campaign-owned field the WO lists, each with a distinctive value. */
function existingRow(): NPCEntry {
    const goal: Goal = {
        text: 'settle a grudge',
        horizon: 'med',
        tier: 'default',
        base_heat: 4,
        lastAdvancedTick: 7,
        failStreak: 1,
        progress: 2,
        quota: 5,
        state: 'active',
    };
    return {
        id: 'stable-id-42',
        name: 'ARIA Vance',
        aliases: 'the Kestrel',
        appearance: 'Scar over the left brow, travel-worn coat',
        visualProfile: { ...DEFAULT_VISUAL_PROFILE, hairStyle: 'short silver braid', eyeColor: 'amber' },
        faction: 'Thieves Guild',
        storyRelevance: 'Old campaign projection',
        disposition: 'Guarded',
        status: 'Wounded in the vault job',
        goals: 'Recover the seal',
        voice: 'Clipped, dry',
        personality: 'Old campaign personality',
        exampleOutput: 'Old campaign examples',
        affinity: 78,
        portrait: '/uploads/aria-existing.png',
        tier: 'recurring',
        condition: 'wounded',
        drives: { coreWant: 'freedom', sessionWant: 'a safehouse', sceneWant: 'a way out' },
        behavioralTriggers: [{ keyword: 'guild', shift: 'goes cold' }],
        hardBoundaries: ['never betrays the guild'],
        softBoundaries: ['dislikes crowds'],
        pressure: { ignored: 2, engaged: 5, lastDecayTurn: 31, history: [] },
        archived: true,
        archivedAtTurn: 55,
        archivedReason: 'left for the coast',
        wants: { short: ['drink'], medium: ['earn wealth'], long: 'rebuild the guild' },
        personalityHex: { drive: 2, diligence: 1, boldness: 3, warmth: -1, empathy: 0, composure: 2 },
        signatureKit: { equipment: ['moonsilver picks'], abilities: ['Shadowstep'], element: 'shadow' },
        traits: ['scheming', 'loyal'],
        region: 'Ryuten',
        haunt: 'the garden',
        relations: { 'npc-9': 2 },
        pcRelation: 3,
        populated: true,
        agencyLocked: true,
        goalRecords: [goal],
        skillRung: 2,
        rungCeiling: 4,
        agencyActivity: { value: 6, tick: 30 },
        repressionPressure: 1,
        relationMeter: 12,
        primaryGroup: 'thieves',
        secondaryGroup: 'scholars',
        fieldTags: { voice: ['relationship_shift'] },
        lastUpdateScene: 41,
        transmigrated: true,
    };
}

/** A freshly converted card row: different values for literally everything. */
function incomingRow(over: Partial<NPCEntry> = {}): NPCEntry {
    return {
        id: 'fresh-id-1',
        name: 'aria vance',
        aliases: 'the Sparrow',
        appearance: 'Tall, dark hair',
        visualProfile: { ...DEFAULT_VISUAL_PROFILE, hairStyle: 'loose black waves' },
        faction: '',
        storyRelevance: 'Aria Vance — new card projection',
        disposition: '',
        status: 'Alive',
        goals: '',
        voice: '',
        personality: 'New card personality',
        exampleOutput: 'New card examples',
        affinity: 50,
        portrait: '/uploads/aria-card.png',
        tier: 'recurring',
        condition: 'healthy',
        wants: { short: ['eat'], medium: ['find a home'], long: '' },
        personalityHex: { drive: 0, diligence: 0, boldness: -2, warmth: 2, empathy: 1, composure: 0 },
        pcRelation: 0,
        populated: true,
        skillRung: 0,
        rungCeiling: 3,
        region: '',
        ...over,
    };
}

function chunk(over: Partial<LoreChunk> & { id: string }): LoreChunk {
    return {
        header: 'h',
        content: 'c',
        tokens: 3,
        alwaysInclude: false,
        triggerKeywords: [],
        scanDepth: 3,
        category: 'character',
        linkedEntities: [],
        priority: 5,
        ...over,
    };
}

describe('normalizeName / cardLoreGroup', () => {
    it('trims, collapses internal whitespace and lowercases', () => {
        expect(normalizeName('  ARIA   Vance \n')).toBe('aria vance');
        expect(normalizeName('')).toBe('');
    });

    it('stamps the ST provenance group', () => {
        expect(cardLoreGroup('Aria Vance')).toBe('ST:Aria Vance');
    });
});

describe('overwriteImportedNPC — card-owned fields (WO-C §9.4 / §10.10)', () => {
    it('replaces the card-owned text fields', () => {
        const out = overwriteImportedNPC(existingRow(), incomingRow());
        expect(out.personality).toBe('New card personality');
        expect(out.storyRelevance).toBe('Aria Vance — new card projection');
        expect(out.exampleOutput).toBe('New card examples');
        expect(out.aliases).toBe('the Sparrow');
        expect(out.portrait).toBe('/uploads/aria-card.png');
    });

    it('keeps the existing portrait when the incoming card has none', () => {
        const noPortrait = overwriteImportedNPC(existingRow(), incomingRow({ portrait: '' }));
        expect(noPortrait.portrait).toBe('/uploads/aria-existing.png');
        const undefPortrait = overwriteImportedNPC(existingRow(), incomingRow({ portrait: undefined }));
        expect(undefPortrait.portrait).toBe('/uploads/aria-existing.png');
    });

    it('keeps the existing aliases when the incoming card has none', () => {
        const out = overwriteImportedNPC(existingRow(), incomingRow({ aliases: '   ' }));
        expect(out.aliases).toBe('the Kestrel');
    });

    it('only fills appearance when the campaign row has none', () => {
        expect(overwriteImportedNPC(existingRow(), incomingRow()).appearance)
            .toBe('Scar over the left brow, travel-worn coat');
        const blank = overwriteImportedNPC({ ...existingRow(), appearance: '  ' }, incomingRow());
        expect(blank.appearance).toBe('Tall, dark hair');
    });

    it('only seeds visualProfile when the existing one is all-default', () => {
        expect(overwriteImportedNPC(existingRow(), incomingRow()).visualProfile?.hairStyle)
            .toBe('short silver braid');
        const pristine = overwriteImportedNPC(
            { ...existingRow(), visualProfile: { ...DEFAULT_VISUAL_PROFILE } },
            incomingRow(),
        );
        expect(pristine.visualProfile?.hairStyle).toBe('loose black waves');
        const missing = overwriteImportedNPC({ ...existingRow(), visualProfile: undefined }, incomingRow());
        expect(missing.visualProfile?.hairStyle).toBe('loose black waves');
    });

    it('never mutates either argument', () => {
        const existing = existingRow();
        const incoming = incomingRow();
        const beforeE = JSON.stringify(existing);
        const beforeI = JSON.stringify(incoming);
        const out = overwriteImportedNPC(existing, incoming);
        expect(JSON.stringify(existing)).toBe(beforeE);
        expect(JSON.stringify(incoming)).toBe(beforeI);
        expect(out).not.toBe(existing);
    });
});

describe('overwriteImportedNPC — campaign-owned preservation matrix', () => {
    const CAMPAIGN_OWNED: (keyof NPCEntry)[] = [
        'id', 'name', 'pcRelation', 'affinity', 'relationMeter', 'relations', 'status', 'condition',
        'region', 'haunt', 'faction', 'wants', 'goalRecords', 'signatureKit', 'pressure',
        'agencyActivity', 'skillRung', 'rungCeiling', 'traits', 'personalityHex', 'archived',
        'archivedAtTurn', 'archivedReason', 'lastUpdateScene', 'fieldTags', 'primaryGroup',
        'secondaryGroup', 'repressionPressure', 'behavioralTriggers', 'hardBoundaries',
        'softBoundaries', 'populated', 'tier', 'drives', 'goals', 'disposition', 'voice',
        'transmigrated', 'agencyLocked',
    ];

    it.each(CAMPAIGN_OWNED)('preserves %s', field => {
        const existing = existingRow();
        const out = overwriteImportedNPC(existing, incomingRow());
        expect(out[field]).toEqual(existing[field]);
    });

    it('keeps the stable id and the existing name casing', () => {
        const out = overwriteImportedNPC(existingRow(), incomingRow());
        expect(out.id).toBe('stable-id-42');
        expect(out.name).toBe('ARIA Vance');
    });

    it('cannot write a campaign-owned key: the whitelist is structural', () => {
        for (const field of CAMPAIGN_OWNED) {
            expect(CARD_OWNED_FIELDS).not.toContain(field);
        }
        expect([...CARD_OWNED_FIELDS].sort()).toEqual(
            ['aliases', 'appearance', 'exampleOutput', 'personality', 'portrait', 'storyRelevance', 'visualProfile'],
        );
    });
});

describe('replaceCardLoreGroup', () => {
    const before: LoreChunk[] = [
        chunk({ id: 'a', group: 'ST:Aria Vance' }),
        chunk({ id: 'b' }),                                  // ungrouped campaign chunk
        chunk({ id: 'c', group: 'ST:Bram' }),                // another card's group
        chunk({ id: 'd', group: 'st:  aria   vance  ' }),    // same card, sloppy casing/spacing
        chunk({ id: 'e', group: 'Campaign Notes' }),         // a campaign-created group
    ];

    it('drops only the matching card group and appends the new chunks', () => {
        const after = replaceCardLoreGroup(before, 'aria VANCE', [chunk({ id: 'new1', group: 'ST:Aria Vance' })]);
        expect(after.map(c => c.id)).toEqual(['b', 'c', 'e', 'new1']);
    });

    it('preserves order and leaves an unrelated card untouched', () => {
        const after = replaceCardLoreGroup(before, 'Bram', []);
        expect(after.map(c => c.id)).toEqual(['a', 'b', 'd', 'e']);
    });

    it('is a plain append when the card has no prior group', () => {
        const added = chunk({ id: 'n', group: 'ST:Cass' });
        expect(replaceCardLoreGroup(before, 'Cass', [added]).map(c => c.id))
            .toEqual(['a', 'b', 'c', 'd', 'e', 'n']);
    });

    it('does not mutate the input array', () => {
        const input = before.slice();
        replaceCardLoreGroup(input, 'Aria Vance', [chunk({ id: 'z' })]);
        expect(input.map(c => c.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });
});

describe('findExistingByName', () => {
    const ledger = [existingRow(), { ...existingRow(), id: 'other', name: 'Bram' }];

    it('matches on the normalized name', () => {
        expect(findExistingByName(ledger, '  aria   VANCE ')?.id).toBe('stable-id-42');
    });

    it('returns undefined for a miss or an empty name', () => {
        expect(findExistingByName(ledger, 'Nobody')).toBeUndefined();
        expect(findExistingByName(ledger, '   ')).toBeUndefined();
    });
});
