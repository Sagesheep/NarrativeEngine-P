import { describe, it, expect } from 'vitest';
import {
    applyOverwrite,
    describeQuickAddFailure,
    planQuickAdd,
    routeQuickAddFile,
    summarizeQuickAdd,
    type QuickAddRouted,
} from '../ledgerQuickAdd';
import { CARD_OWNED_FIELDS } from '../importOverwrite';
import { buildCardPng, buildPlainPng } from './pngFixture';
import type { NPCEntry } from '../../../types';
import type { STCard } from '../stCardTypes';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function v2Payload(over: Record<string, unknown> = {}) {
    return {
        spec: 'chara_card_v2',
        data: {
            name: 'Mira',
            description: 'A quiet archivist who keeps the lamp burning after dark.',
            personality: 'shy, kind',
            scenario: 'The archive at midnight.',
            first_mes: 'Hello, {{user}}.',
            mes_example: '',
            tags: ['librarian'],
            ...over,
        },
    };
}

function card(over: Partial<STCard> = {}): STCard {
    return {
        name: 'Mira',
        description: 'A quiet archivist.',
        personality: 'shy, kind',
        scenario: '',
        first_mes: '',
        mes_example: '',
        alternate_greetings: [],
        system_prompt: '',
        post_history_instructions: '',
        tags: [],
        creator: '',
        creator_notes: '',
        spec: 'v2',
        ...over,
    };
}

function routedCard(c: STCard, fileName = `${c.name}.png`): QuickAddRouted {
    return { kind: 'card', fileName, card: c };
}

/** A fixed-sequence rng so hex fill and want draws are reproducible. */
function seededRng(seed = 1): () => number {
    let s = seed;
    return () => {
        s = (s * 1664525 + 1013904223) % 4294967296;
        return s / 4294967296;
    };
}

function counterId(prefix = 'id'): () => string {
    let n = 0;
    return () => `${prefix}-${++n}`;
}

function ledgerRow(over: Partial<NPCEntry> = {}): NPCEntry {
    return {
        id: 'ledger-1',
        name: 'mira',
        aliases: '',
        appearance: 'Ink-stained cuffs',
        faction: 'The Archive',
        storyRelevance: 'Campaign-era projection',
        disposition: 'Wary',
        status: 'Alive',
        goals: 'Find the missing folio',
        voice: 'Soft',
        personality: 'Campaign-era personality',
        exampleOutput: 'Campaign-era examples',
        affinity: 81,
        pcRelation: 2,
        relations: { 'npc-9': 1 },
        ...over,
    };
}

const opts = { userName: 'Reyna', matureMode: false };

/* ------------------------------------------------------------------ *
 * routeQuickAddFile
 * ------------------------------------------------------------------ */

describe('routeQuickAddFile', () => {
    it('routes a card PNG to a parsed card', () => {
        const routed = routeQuickAddFile('mira.png', 'png', buildCardPng(v2Payload()));
        expect(routed.kind).toBe('card');
        if (routed.kind !== 'card') throw new Error('unreachable');
        expect(routed.card.name).toBe('Mira');
        expect(routed.fileName).toBe('mira.png');
    });

    it('reports the parser reason for a PNG with no embedded card', () => {
        const routed = routeQuickAddFile('screenshot.png', 'png', buildPlainPng());
        expect(routed).toEqual({ kind: 'failed', fileName: 'screenshot.png', reason: 'no-card-payload' });
    });

    it('reports a non-PNG buffer as not-png', () => {
        const buf = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 5]).buffer;
        const routed = routeQuickAddFile('card.png', 'png', buf);
        expect(routed).toEqual({ kind: 'failed', fileName: 'card.png', reason: 'not-png' });
    });

    it('reports a clipped chunk table as truncated', () => {
        const routed = routeQuickAddFile('half.png', 'png', buildCardPng(v2Payload(), { truncateTail: true }));
        expect(routed).toEqual({ kind: 'failed', fileName: 'half.png', reason: 'truncated' });
    });

    it('routes a JSON array to the legacy NPC-export path', () => {
        const entries = [{ name: 'Old Friend' }, { name: 'Old Foe' }];
        const routed = routeQuickAddFile('ledger.json', 'json', JSON.stringify(entries));
        expect(routed).toEqual({ kind: 'legacy-npc-array', fileName: 'ledger.json', entries });
    });

    it('routes a JSON card object to a parsed card', () => {
        const routed = routeQuickAddFile('mira.json', 'json', JSON.stringify(v2Payload()));
        expect(routed.kind).toBe('card');
        if (routed.kind !== 'card') throw new Error('unreachable');
        expect(routed.card.name).toBe('Mira');
    });

    it('reports unparseable JSON as not-json', () => {
        const routed = routeQuickAddFile('broken.json', 'json', '{ this is not json');
        expect(routed).toEqual({ kind: 'failed', fileName: 'broken.json', reason: 'not-json' });
    });

    it('reports valid JSON that is not a card as not-card', () => {
        const routed = routeQuickAddFile('settings.json', 'json', JSON.stringify({ theme: 'dark' }));
        expect(routed).toEqual({ kind: 'failed', fileName: 'settings.json', reason: 'not-card' });
    });

    it('gives every failure reason a human sentence', () => {
        for (const reason of ['not-png', 'no-card-payload', 'malformed-payload', 'truncated', 'not-json', 'not-card'] as const) {
            expect(describeQuickAddFailure(reason).length).toBeGreaterThan(0);
        }
    });
});

/* ------------------------------------------------------------------ *
 * planQuickAdd
 * ------------------------------------------------------------------ */

describe('planQuickAdd', () => {
    it('populates every added NPC (§3.4 — an unpopulated import never wanders)', () => {
        const plan = planQuickAdd([routedCard(card())], [], { ...opts, rng: seededRng(), makeId: counterId() });

        expect(plan.additions).toHaveLength(1);
        expect(plan.collisions).toHaveLength(0);
        const { npc } = plan.additions[0];
        expect(npc.populated).toBe(true);
        expect(npc.tier).toBe('recurring');
        expect(npc.personalityHex).toBeDefined();
        expect(Object.keys(npc.personalityHex ?? {})).toEqual(
            expect.arrayContaining(['drive', 'diligence', 'boldness', 'warmth', 'empathy', 'composure']),
        );
        expect(npc.wants?.short.length).toBeGreaterThan(0);
        expect(npc.wants?.long).toBe('');
    });

    it('bakes {{user}} with the supplied userName', () => {
        const withMacro = card({
            description: '{{char}} has known {{user}} for years.',
            personality: 'devoted to {{user}}',
        });
        const plan = planQuickAdd([routedCard(withMacro)], [], { ...opts, rng: seededRng(), makeId: counterId() });

        expect(plan.additions[0].npc.personality).toBe('devoted to Reyna');
        expect(plan.additions[0].loreChunks[0].content).toContain('Mira has known Reyna for years.');
    });

    it('detects a ledger collision case-insensitively', () => {
        const existing = ledgerRow({ name: '  MIRA  ' });
        const plan = planQuickAdd([routedCard(card())], [existing], { ...opts, rng: seededRng(), makeId: counterId() });

        expect(plan.additions).toHaveLength(0);
        expect(plan.collisions).toHaveLength(1);
        expect(plan.collisions[0].existing).toBe(existing);
        expect(plan.collisions[0].incoming.name).toBe('Mira');
    });

    it('turns a repeated name inside one drop into a collision against the earlier addition', () => {
        const first = card({ personality: 'first take' });
        const second = card({ name: 'mira', personality: 'second take' });
        const plan = planQuickAdd([routedCard(first, 'a.png'), routedCard(second, 'b.png')], [], {
            ...opts, rng: seededRng(), makeId: counterId(),
        });

        expect(plan.additions).toHaveLength(1);
        expect(plan.collisions).toHaveLength(1);
        expect(plan.collisions[0].existing).toBe(plan.additions[0].npc);
        expect(plan.collisions[0].fileName).toBe('b.png');
        expect(plan.collisions[0].incoming.personality).toBe('second take');
    });

    it('collects legacy arrays and failures without blocking the cards', () => {
        const routed: QuickAddRouted[] = [
            { kind: 'failed', fileName: 'bad.png', reason: 'no-card-payload' },
            { kind: 'legacy-npc-array', fileName: 'ledger.json', entries: [{ name: 'Old Friend' }] },
            routedCard(card()),
            { kind: 'legacy-npc-array', fileName: 'more.json', entries: [{ name: 'Old Foe' }] },
        ];
        const plan = planQuickAdd(routed, [], { ...opts, rng: seededRng(), makeId: counterId() });

        expect(plan.additions).toHaveLength(1);
        expect(plan.failures).toEqual([{ fileName: 'bad.png', reason: 'no-card-payload' }]);
        expect(plan.legacyEntries).toEqual([{ name: 'Old Friend' }, { name: 'Old Foe' }]);
    });

    it('is deterministic given an injected rng and makeId', () => {
        const build = () => planQuickAdd([routedCard(card())], [], { ...opts, rng: seededRng(7), makeId: counterId() });
        expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
    });
});

/* ------------------------------------------------------------------ *
 * applyOverwrite
 * ------------------------------------------------------------------ */

describe('applyOverwrite', () => {
    it('never carries id, and carries only card-owned keys', () => {
        const existing = ledgerRow();
        const plan = planQuickAdd([routedCard(card())], [existing], { ...opts, rng: seededRng(), makeId: counterId() });
        const patch = applyOverwrite(existing, plan.collisions[0].incoming);

        expect(patch).not.toHaveProperty('id');
        for (const key of Object.keys(patch)) {
            expect(CARD_OWNED_FIELDS as readonly string[]).toContain(key);
        }
    });

    it('replaces card-owned prose and leaves campaign-owned state to the store', () => {
        const existing = ledgerRow();
        const incoming = planQuickAdd([routedCard(card({ personality: 'freshly authored' }))], [existing], {
            ...opts, rng: seededRng(), makeId: counterId(),
        }).collisions[0].incoming;
        const patch = applyOverwrite(existing, incoming);

        expect(patch.personality).toBe('freshly authored');
        expect(patch.storyRelevance).toBe(incoming.storyRelevance);
        // `appearance` is only filled when blank; the campaign wrote one already.
        expect(patch).not.toHaveProperty('appearance');
        expect(patch).not.toHaveProperty('affinity');
        expect(patch).not.toHaveProperty('relations');
        expect(patch).not.toHaveProperty('personalityHex');
    });

    it('omits portrait when the incoming card brought none', () => {
        const existing = ledgerRow({ portrait: '/assets/portraits/old.png' });
        const incoming = planQuickAdd([routedCard(card())], [existing], {
            ...opts, rng: seededRng(), makeId: counterId(),
        }).collisions[0].incoming;

        expect(applyOverwrite(existing, incoming)).not.toHaveProperty('portrait');
    });
});

/* ------------------------------------------------------------------ *
 * summarizeQuickAdd
 * ------------------------------------------------------------------ */

describe('summarizeQuickAdd', () => {
    it('counts cards, lore, overwrites and skips', () => {
        const plan = planQuickAdd(
            [routedCard(card({ name: 'Rin' })), routedCard(card({ name: 'Mira' })), routedCard(card({ name: 'Tal' }))],
            [ledgerRow({ name: 'Mira' }), ledgerRow({ id: 'ledger-2', name: 'Tal' })],
            { ...opts, rng: seededRng(), makeId: counterId() },
        );
        const text = summarizeQuickAdd(plan, { collisions: ['overwrite', 'skip'] });

        expect(text).toContain('Imported 2 card(s)');
        expect(text).toContain('1 overwritten');
        expect(text).toContain('1 skipped');
    });

    it('names the NPCs whose personality was inferred from tags (§9.6.4c)', () => {
        const inferred = card({ name: 'Rin', personality: '', tags: ['tsundere', 'swordswoman'] });
        const authored = card({ name: 'Mira', personality: 'shy, kind', tags: [] });
        const plan = planQuickAdd([routedCard(inferred), routedCard(authored)], [], {
            ...opts, rng: seededRng(), makeId: counterId(),
        });
        const text = summarizeQuickAdd(plan, { collisions: [] });

        expect(text).toMatch(/personality inferred from tags for:/i);
        expect(text).toContain('Rin');
        expect(text.split('Personality inferred from tags for:')[1]).not.toContain('Mira');
    });

    it('lists every rejected file with its reason (§9.5)', () => {
        const plan = planQuickAdd(
            [{ kind: 'failed', fileName: 'screenshot.png', reason: 'no-card-payload' }],
            [],
            { ...opts, rng: seededRng(), makeId: counterId() },
        );
        const text = summarizeQuickAdd(plan, { collisions: [] });

        expect(text).toContain('screenshot.png');
        expect(text).toContain('download the original card file');
    });

    it('discloses portrait failures without pretending the import failed', () => {
        const plan = planQuickAdd([routedCard(card())], [], { ...opts, rng: seededRng(), makeId: counterId() });
        const text = summarizeQuickAdd(plan, { collisions: [], portraitFailures: ['Mira'] });

        expect(text).toContain('Imported 1 card(s)');
        expect(text).toContain('No portrait for: Mira');
    });

    it('discloses constant-lore entries routed to searchable memory (§9.6.6)', () => {
        const flooded = card({
            character_book: {
                entries: Array.from({ length: 5 }, (_v, i) => ({
                    keys: [`k${i}`],
                    secondary_keys: [],
                    content: `fact ${i}`,
                    comment: `entry ${i}`,
                    constant: true,
                    enabled: true,
                    insertion_order: i,
                })),
            },
        });
        const plan = planQuickAdd([routedCard(flooded)], [], { ...opts, rng: seededRng(), makeId: counterId() });

        expect(summarizeQuickAdd(plan, { collisions: [] })).toContain('2 always-on lore entries routed to searchable memory');
    });
});
