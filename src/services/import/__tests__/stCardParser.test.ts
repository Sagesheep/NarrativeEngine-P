import { describe, it, expect } from 'vitest';
import { parsePngCard, parseJsonCard, normalizeCard, applyCardMacros } from '../stCardParser';
import { buildCardPng, buildPlainPng, encodeCardPayload } from './pngFixture';
import type { STCard } from '../stCardTypes';

// A representative V2 card body: the fields ST actually writes, plus an
// embedded lorebook using the *official* V2 spellings.
function v2Body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        name: 'Rin Kagamine',
        description: 'A tall archivist with ink-stained fingers.',
        personality: 'Shy, kind, meticulous',
        scenario: 'The archive is flooding and {{char}} needs help.',
        first_mes: 'Hello, {{user}}. You came.',
        mes_example: '<START>\n{{user}}: Hi\n{{char}}: Hello.',
        alternate_greetings: ['A second greeting.', 'A third.'],
        system_prompt: 'You are Rin.',
        post_history_instructions: 'Stay in character.',
        tags: ['fantasy', 'archivist'],
        creator: 'someone',
        creator_notes: 'Made for a library setting.',
        character_book: {
            name: 'Archive lore',
            entries: [
                {
                    keys: ['archive', 'library'],
                    secondary_keys: ['flood'],
                    content: 'The archive holds ten thousand scrolls.',
                    comment: 'The Archive',
                    constant: true,
                    enabled: true,
                    insertion_order: 2,
                },
            ],
        },
        ...overrides,
    };
}

function v2Card(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { spec: 'chara_card_v2', spec_version: '2.0', data: v2Body(overrides) };
}

describe('parsePngCard — chunk walk', () => {
    it('parses a V2 `chara` chunk out of a PNG', () => {
        const result = parsePngCard(buildCardPng(v2Card()));

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.card.name).toBe('Rin Kagamine');
        expect(result.card.spec).toBe('v2');
        expect(result.card.personality).toBe('Shy, kind, meticulous');
        expect(result.card.alternate_greetings).toEqual(['A second greeting.', 'A third.']);
        expect(result.card.character_book?.entries).toHaveLength(1);
    });

    it('prefers `ccv3` over `chara` when both chunks are present', () => {
        // `chara` written FIRST, `ccv3` second.
        const charaFirst = buildCardPng(
            { spec: 'chara_card_v3', data: v2Body({ name: 'V3 Rin' }) },
            {
                keyword: 'ccv3',
                extraText: [{ keyword: 'chara', text: encodeCardPayload(v2Card({ name: 'V2 Rin' })) }],
            },
        );
        const a = parsePngCard(charaFirst);
        expect(a.ok).toBe(true);
        if (a.ok) {
            expect(a.card.name).toBe('V3 Rin');
            expect(a.card.spec).toBe('v3');
        }

        // ...and the other way round, so precedence is not just "last one wins".
        const ccv3First = buildCardPng(v2Card({ name: 'V2 Rin' }), {
            keyword: 'chara',
            extraText: [
                {
                    keyword: 'ccv3',
                    text: encodeCardPayload({ spec: 'chara_card_v3', data: v2Body({ name: 'V3 Rin' }) }),
                },
            ],
        });
        const b = parsePngCard(ccv3First);
        expect(b.ok).toBe(true);
        if (b.ok) expect(b.card.name).toBe('V3 Rin');
    });

    it('survives the base64 -> UTF-8 path with non-ASCII text', () => {
        const result = parsePngCard(
            buildCardPng(v2Card({ name: 'Renée ❤', description: 'Café — 日本語 — ñ' })),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.card.name).toBe('Renée ❤');
        expect(result.card.description).toBe('Café — 日本語 — ñ');
    });

    it('ignores tEXt chunks that are not card payloads', () => {
        const result = parsePngCard(
            buildCardPng(v2Card(), {
                extraText: [
                    { keyword: 'Software', text: 'Some Image Editor' },
                    { keyword: 'Comment', text: 'not a card' },
                ],
            }),
        );

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.card.name).toBe('Rin Kagamine');
    });
});

describe('parsePngCard — failure reasons (§9.5)', () => {
    it('bad signature -> not-png', () => {
        const buffer = new ArrayBuffer(64);
        new Uint8Array(buffer).set([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00]); // "RIFF" (WebP)

        const result = parsePngCard(buffer);
        expect(result).toEqual({ ok: false, reason: 'not-png' });
    });

    it('an empty buffer -> not-png', () => {
        expect(parsePngCard(new ArrayBuffer(0))).toEqual({ ok: false, reason: 'not-png' });
    });

    it('a chunk length that runs past the buffer -> truncated', () => {
        const result = parsePngCard(buildCardPng(v2Card(), { truncateTail: true }));
        expect(result).toEqual({ ok: false, reason: 'truncated' });
    });

    it('a plain PNG with no card chunk -> no-card-payload', () => {
        const result = parsePngCard(buildPlainPng());
        expect(result).toEqual({ ok: false, reason: 'no-card-payload' });
    });

    // `extraText` writes chunk text verbatim, so a bad payload rides in under
    // `ccv3` — which the parser prefers unconditionally, even when the `chara`
    // chunk beside it is perfectly good.
    it('garbage base64 in the winning chunk -> malformed-payload', () => {
        const result = parsePngCard(
            buildCardPng(v2Card(), {
                keyword: 'chara',
                extraText: [{ keyword: 'ccv3', text: '!!!! not base64 !!!!' }],
            }),
        );
        expect(result).toEqual({ ok: false, reason: 'malformed-payload' });
    });

    it('valid base64 that is not JSON -> malformed-payload', () => {
        const result = parsePngCard(
            buildCardPng(v2Card(), {
                keyword: 'chara',
                extraText: [{ keyword: 'ccv3', text: btoa('this is plain text, not json') }],
            }),
        );
        expect(result).toEqual({ ok: false, reason: 'malformed-payload' });
    });

    it('valid JSON that is not a card -> malformed-payload', () => {
        const notACard = buildCardPng({ some: 'object', without: 'a name' });
        expect(parsePngCard(notACard)).toEqual({ ok: false, reason: 'malformed-payload' });
    });

    it('a card whose name is blank -> malformed-payload', () => {
        const blankName = buildCardPng(v2Card({ name: '   ' }));
        expect(parsePngCard(blankName)).toEqual({ ok: false, reason: 'malformed-payload' });
    });
});

describe('normalizeCard — spec shapes', () => {
    const shared = {
        description: 'A tall archivist with ink-stained fingers.',
        personality: 'Shy, kind, meticulous',
        scenario: 'The archive is flooding.',
        first_mes: 'Hello.',
        mes_example: '<START>\nhi',
        alternate_greetings: ['second'],
        system_prompt: 'You are Rin.',
        post_history_instructions: 'Stay in character.',
        tags: ['fantasy'],
        creator: 'someone',
        creator_notes: 'notes',
        character_book: {
            entries: [{ keys: ['archive'], content: 'Ten thousand scrolls.', insertion_order: 1 }],
        },
    };

    it('V1 flat, V2 and V3 normalize to identical cards given equivalent content', () => {
        const v1 = normalizeCard({ name: 'Rin', ...shared });
        const v2 = normalizeCard({ spec: 'chara_card_v2', data: { name: 'Rin', ...shared } });
        const v3 = normalizeCard({ spec: 'chara_card_v3', data: { name: 'Rin', ...shared } });

        expect(v1).not.toBeNull();
        expect(v2).not.toBeNull();
        expect(v3).not.toBeNull();
        expect(v1?.spec).toBe('v1');
        expect(v2?.spec).toBe('v2');
        expect(v3?.spec).toBe('v3');

        // Everything but the spec tag is identical.
        const strip = (card: STCard | null) => {
            const copy = { ...(card as STCard) } as Partial<STCard>;
            delete copy.spec;
            return copy;
        };
        expect(strip(v1)).toEqual(strip(v2));
        expect(strip(v2)).toEqual(strip(v3));
    });

    it('treats a bare `{ data: {...} }` envelope with no spec as V2', () => {
        const card = normalizeCard({ data: { name: 'Rin', description: 'nested' } });
        expect(card?.spec).toBe('v2');
        expect(card?.description).toBe('nested');
    });

    it('defaults every absent field', () => {
        const card = normalizeCard({ name: 'Bare' });

        expect(card).toEqual({
            name: 'Bare',
            description: '',
            personality: '',
            scenario: '',
            first_mes: '',
            mes_example: '',
            alternate_greetings: [],
            system_prompt: '',
            post_history_instructions: '',
            tags: [],
            creator: '',
            creator_notes: '',
            spec: 'v1',
        });
        expect(card?.character_book).toBeUndefined();
    });

    it('maps the legacy TavernAI spellings on a flat card', () => {
        const card = normalizeCard({
            char_name: 'Aqua',
            char_persona: 'A goddess, easily flustered.',
            char_greeting: 'Do you know who I am?',
            world_scenario: 'A dungeon town called Axel.',
            example_dialogue: '<START>\nAqua: I am a goddess!',
        });

        expect(card).not.toBeNull();
        expect(card?.spec).toBe('v1');
        expect(card?.name).toBe('Aqua');
        expect(card?.description).toBe('A goddess, easily flustered.');
        expect(card?.first_mes).toBe('Do you know who I am?');
        expect(card?.scenario).toBe('A dungeon town called Axel.');
        expect(card?.mes_example).toBe('<START>\nAqua: I am a goddess!');
        // No legacy counterpart — old cards folded personality into char_persona.
        expect(card?.personality).toBe('');
    });

    it('prefers the modern keys when a card carries both spellings', () => {
        const card = normalizeCard({
            name: 'Modern',
            char_name: 'Legacy',
            description: 'modern description',
            char_persona: 'legacy persona',
            first_mes: 'modern greeting',
            char_greeting: 'legacy greeting',
            scenario: 'modern scenario',
            world_scenario: 'legacy scenario',
            mes_example: 'modern example',
            example_dialogue: 'legacy example',
        });

        expect(card?.name).toBe('Modern');
        expect(card?.description).toBe('modern description');
        expect(card?.first_mes).toBe('modern greeting');
        expect(card?.scenario).toBe('modern scenario');
        expect(card?.mes_example).toBe('modern example');
    });

    it('returns null when there is no usable name', () => {
        expect(normalizeCard({ description: 'orphan text' })).toBeNull();
        expect(normalizeCard({ name: '   ' })).toBeNull();
        expect(normalizeCard({ spec: 'chara_card_v2', data: { description: 'x' } })).toBeNull();
        expect(normalizeCard(null)).toBeNull();
        expect(normalizeCard('a string')).toBeNull();
        expect(normalizeCard([{ name: 'array member' }])).toBeNull();
    });

    it('coerces non-string scalars and trims the name', () => {
        const card = normalizeCard({ name: '  Rin  ', description: 42, personality: true });
        expect(card?.name).toBe('Rin');
        expect(card?.description).toBe('42');
        expect(card?.personality).toBe('true');
    });

    it('splits tags delivered as a comma-separated string', () => {
        const card = normalizeCard({ name: 'Rin', tags: 'fantasy, archivist , , elf' });
        expect(card?.tags).toEqual(['fantasy', 'archivist', 'elf']);
    });

    it('keeps alternate_greetings a string array, dropping non-strings', () => {
        const card = normalizeCard({
            name: 'Rin',
            alternate_greetings: ['ok', 7, null, { a: 1 }, 'also ok'],
        });
        expect(card?.alternate_greetings).toEqual(['ok', 'also ok']);
    });
});

describe('normalizeCard — character_book spellings', () => {
    it('maps the ST-internal spellings (key / keysecondary / name / disable)', () => {
        const card = normalizeCard({
            name: 'Rin',
            character_book: {
                entries: [
                    {
                        key: ['archive'],
                        keysecondary: ['flood'],
                        name: 'The Archive',
                        content: 'Ten thousand scrolls.',
                        disable: true,
                        constant: 1,
                        insertion_order: '5',
                    },
                ],
            },
        });

        expect(card?.character_book?.entries).toEqual([
            {
                keys: ['archive'],
                secondary_keys: ['flood'],
                content: 'Ten thousand scrolls.',
                comment: 'The Archive',
                constant: true,
                enabled: false, // `disable: true` inverted
                insertion_order: 5,
            },
        ]);
    });

    it('maps the spec spellings (keys / secondary_keys / comment / enabled)', () => {
        const card = normalizeCard({
            name: 'Rin',
            character_book: {
                entries: [
                    {
                        keys: ['archive'],
                        secondary_keys: ['flood'],
                        comment: 'The Archive',
                        content: 'Ten thousand scrolls.',
                        enabled: false,
                        constant: false,
                        insertion_order: 5,
                    },
                ],
            },
        });

        expect(card?.character_book?.entries[0]).toEqual({
            keys: ['archive'],
            secondary_keys: ['flood'],
            content: 'Ten thousand scrolls.',
            comment: 'The Archive',
            constant: false,
            enabled: false,
            insertion_order: 5,
        });
    });

    it('splits keys delivered as a comma-separated string', () => {
        const card = normalizeCard({
            name: 'Rin',
            character_book: { entries: [{ key: 'archive, library', content: 'x' }] },
        });
        expect(card?.character_book?.entries[0].keys).toEqual(['archive', 'library']);
    });

    it('defaults constant/enabled/insertion_order and drops content-less entries', () => {
        const card = normalizeCard({
            name: 'Rin',
            character_book: {
                name: 'Archive lore',
                entries: [
                    { keys: ['a'], content: 'kept' },
                    { keys: ['b'], content: '   ' },
                    { keys: ['c'] },
                    'not an object',
                ],
            },
        });

        expect(card?.character_book?.name).toBe('Archive lore');
        expect(card?.character_book?.entries).toEqual([
            {
                keys: ['a'],
                secondary_keys: [],
                content: 'kept',
                comment: '',
                constant: false,
                enabled: true,
                insertion_order: 0,
            },
        ]);
    });

    it('omits character_book entirely when nothing usable survives', () => {
        const card = normalizeCard({
            name: 'Rin',
            character_book: { name: 'Empty', entries: [{ keys: ['a'], content: '' }] },
        });
        expect(card?.character_book).toBeUndefined();
    });
});

describe('applyCardMacros', () => {
    const ctx = { charName: 'Rin', userName: 'Alex' };

    it('replaces {{char}} / {{user}} case-tolerantly and globally', () => {
        expect(applyCardMacros('{{char}} greets {{user}}, then {{CHAR}} waves at {{User}}.', ctx)).toBe(
            'Rin greets Alex, then Rin waves at Alex.',
        );
    });

    it('tolerates whitespace inside the braces', () => {
        expect(applyCardMacros('{{ char }} and {{  user  }}', ctx)).toBe('Rin and Alex');
    });

    it('replaces the legacy <BOT> / <USER> markers', () => {
        expect(applyCardMacros('<BOT> waves at <USER>.', ctx)).toBe('Rin waves at Alex.');
    });

    it('leaves unknown macros untouched', () => {
        const text = '{{char}} rolls {{roll:1d6}} at {{time}} in {{original}}.';
        expect(applyCardMacros(text, ctx)).toBe('Rin rolls {{roll:1d6}} at {{time}} in {{original}}.');
    });

    it('treats replacement names literally (no $-pattern interpretation)', () => {
        expect(applyCardMacros('{{char}} & {{user}}', { charName: '$& Rin', userName: '$1' })).toBe(
            '$& Rin & $1',
        );
    });

    it('returns empty string for empty input', () => {
        expect(applyCardMacros('', ctx)).toBe('');
    });
});

describe('parseJsonCard', () => {
    it('parses a bare V2 JSON export', () => {
        const card = parseJsonCard(JSON.stringify(v2Card()));
        expect(card?.name).toBe('Rin Kagamine');
        expect(card?.spec).toBe('v2');
    });

    it('parses a V1 flat JSON export', () => {
        const card = parseJsonCard(JSON.stringify({ name: 'Old Card', description: 'flat' }));
        expect(card?.spec).toBe('v1');
    });

    it('returns null for an NPC-roster export array', () => {
        const npcExport = [
            { id: 'npc-1', name: 'John Roleplay', personality: 'Guarded' },
            { id: 'npc-2', name: 'Someone Else' },
        ];
        expect(parseJsonCard(JSON.stringify(npcExport))).toBeNull();
    });

    it('returns null for malformed JSON and for non-card objects', () => {
        expect(parseJsonCard('{ not json')).toBeNull();
        expect(parseJsonCard('')).toBeNull();
        expect(parseJsonCard('null')).toBeNull();
        expect(parseJsonCard(JSON.stringify({ settings: { theme: 'dark' } }))).toBeNull();
    });
});
