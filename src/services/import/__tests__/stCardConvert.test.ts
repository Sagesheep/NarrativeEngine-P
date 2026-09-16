import { describe, it, expect } from 'vitest';
import {
    cardToNPC,
    bookToLoreChunks,
    seedCardToCampaignParts,
    cardToPC,
    buildPcContextPatch,
    isStructuredText,
    wppToTraitLines,
    cutAtSentence,
    cutExampleAtStart,
} from '../stCardConvert';
import type { STCard, STLoreEntry } from '../stCardTypes';
import type { GameContext, CharacterProfile } from '../../../types';
import { countTokens } from '../../infrastructure/tokenizer';

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeCard(over: Partial<STCard> = {}): STCard {
    return {
        name: 'Rin',
        description: 'Rin is a quiet archivist. She keeps the tower records.',
        personality: 'Shy, bookish, fiercely loyal.',
        scenario: 'The tower archive floods every spring.',
        first_mes: 'Rin looks up from the ledger. "You came."',
        mes_example: '',
        alternate_greetings: [],
        system_prompt: '',
        post_history_instructions: '',
        tags: [],
        creator: 'someone',
        creator_notes: '',
        spec: 'v2',
        ...over,
    };
}

function makeEntry(over: Partial<STLoreEntry> = {}): STLoreEntry {
    return {
        keys: ['tower'],
        secondary_keys: [],
        content: 'The tower leans three degrees east.',
        comment: '',
        constant: false,
        enabled: true,
        insertion_order: 0,
        ...over,
    };
}

/** Deterministic id factory — every test that asserts ids builds its own. */
function idFactory(prefix = 'id'): () => string {
    let n = 0;
    return () => `${prefix}-${n++}`;
}

// ── §6.4 cardToNPC ──────────────────────────────────────────────────────────

describe('WO-C §6.4 — cardToNPC caps', () => {
    it('caps personality at 400 chars without cutting mid-word', () => {
        const card = makeCard({ personality: 'word '.repeat(200).trim() });
        const { npc } = cardToNPC(card, { userName: 'You', makeId: idFactory() });
        expect(npc.personality.length).toBeLessThanOrEqual(400);
        expect(npc.personality.length).toBeGreaterThan(380);
        expect(npc.personality.endsWith('word')).toBe(true);
    });

    it('cuts storyRelevance to ~300 chars at a sentence boundary', () => {
        const sentence = (n: number) =>
            `Sentence ${n} about the archivist which runs on for a good while indeed.`;
        const description = [1, 2, 3, 4, 5, 6].map(sentence).join(' ');
        const { npc } = cardToNPC(makeCard({ description }), { userName: 'You', makeId: idFactory() });
        expect(npc.storyRelevance.length).toBeLessThanOrEqual(300);
        expect(npc.storyRelevance.endsWith('.')).toBe(true);
        // Never a partial trailing sentence.
        expect(npc.storyRelevance.split('Sentence').length - 1).toBeGreaterThan(0);
        expect(description.startsWith(npc.storyRelevance)).toBe(true);
    });

    it('cuts exampleOutput at a <START> boundary, keeping whole blocks and stripping markers', () => {
        const blockA = 'A'.repeat(400);
        const blockB = 'B'.repeat(400);
        const card = makeCard({ mes_example: `<START>\n${blockA}\n<START>\n${blockB}` });
        const { npc } = cardToNPC(card, { userName: 'You', makeId: idFactory() });
        expect(npc.exampleOutput).toBe(blockA);
        expect(npc.exampleOutput).not.toContain('<START>');
        expect(npc.exampleOutput.length).toBeLessThanOrEqual(800);
    });

    it('keeps every example block that fits under the 800 cap', () => {
        const card = makeCard({
            mes_example: '<START>\n{{user}}: Hi.\n{{char}}: Tea?\n<START>\n{{user}}: Again.\n{{char}}: Indeed.',
        });
        const { npc } = cardToNPC(card, { userName: 'Mira', makeId: idFactory() });
        expect(npc.exampleOutput).toContain('Mira: Hi.');
        expect(npc.exampleOutput).toContain('Rin: Indeed.');
        expect(npc.exampleOutput).not.toContain('<START>');
    });
});

describe('WO-C §6.4 / §9.6.4 — W++ guard and personality precedence', () => {
    it('W++ description leaves no bracket garbage in storyRelevance and flags it', () => {
        const card = makeCard({
            description: '[Character("Rin"){Age("17") Likes("tea","rain") Body("slight")}]',
            creator_notes: 'An archivist from the leaning tower. Written for slow slice-of-life play.',
        });
        const { npc, loreChunks, flags } = cardToNPC(card, { userName: 'You', makeId: idFactory() });
        expect(flags.structuredDescription).toBe(true);
        expect(npc.storyRelevance).not.toMatch(/[[\]{}]/);
        expect(npc.storyRelevance).toContain('An archivist from the leaning tower.');
        expect(npc.storyRelevance.length).toBeLessThanOrEqual(200);
        // The sheet chunk still carries the raw description verbatim.
        expect(loreChunks[0].content).toContain('[Character("Rin")');
    });

    it('W++ description with no prose creator_notes falls back to the placeholder line', () => {
        const card = makeCard({
            description: '[Character("Rin"){Age("17")}]',
            creator_notes: 'Notes("also W++")',
        });
        const { npc, flags } = cardToNPC(card, { userName: 'You', makeId: idFactory() });
        expect(flags.structuredDescription).toBe(true);
        expect(npc.storyRelevance).toBe('Rin — imported character');
    });

    it('prose description is used as-is and does not raise the structured flag', () => {
        const { npc, flags } = cardToNPC(makeCard(), { userName: 'You', makeId: idFactory() });
        expect(flags.structuredDescription).toBe(false);
        expect(npc.storyRelevance).toBe('Rin is a quiet archivist. She keeps the tower records.');
    });

    it('W++ personality becomes readable trait lines, never raw brackets', () => {
        const card = makeCard({ personality: '[Character("Rin"){Age("17") Likes("tea","rain")}]' });
        const { npc, flags } = cardToNPC(card, { userName: 'You', makeId: idFactory() });
        expect(npc.personality).toBe('Age: 17\nLikes: tea, rain');
        expect(npc.personality).not.toMatch(/[[\]{}]/);
        expect(flags.personalityInferredFromTags).toBe(false);
    });

    it('empty personality falls back to tags and raises the inferred flag', () => {
        const card = makeCard({ personality: '   ', tags: ['shy', 'bookish', 'loyal'] });
        const { npc, flags } = cardToNPC(card, { userName: 'You', makeId: idFactory() });
        expect(npc.personality).toBe('shy, bookish, loyal');
        expect(flags.personalityInferredFromTags).toBe(true);
    });

    it('empty personality with no tags stays empty and is not flagged as inferred', () => {
        const card = makeCard({ personality: '', tags: [] });
        const { npc, flags } = cardToNPC(card, { userName: 'You', makeId: idFactory() });
        expect(npc.personality).toBe('');
        expect(flags.personalityInferredFromTags).toBe(false);
    });

    it('never mines description for personality', () => {
        const card = makeCard({ personality: '', tags: [], description: 'Extremely brave and reckless.' });
        const { npc } = cardToNPC(card, { userName: 'You', makeId: idFactory() });
        expect(npc.personality).toBe('');
    });
});

describe('WO-C §10.7 — fixed entry values', () => {
    it('sets the verified fixed values and leaves the agency fields to the populate pass', () => {
        const { npc } = cardToNPC(makeCard(), { userName: 'You', makeId: idFactory() });
        expect(npc.id).toBe('id-0');
        expect(npc.status).toBe('Alive');
        expect(npc.tier).toBe('recurring');
        expect(npc.condition).toBe('healthy');
        expect(npc.affinity).toBe(50);
        expect(npc.aliases).toBe('');
        expect(npc.appearance).toBe('');
        expect(npc.faction).toBe('');
        expect(npc.disposition).toBe('');
        expect(npc.goals).toBe('');
        expect(npc.voice).toBe('');
        expect(npc.visualProfile).toEqual({
            race: '', gender: '', ageRange: '', build: '', symmetry: '',
            hairStyle: '', eyeColor: '', skinTone: '', gait: '', distinctMarks: '',
            clothing: '', artStyle: 'Stylized Game Realism',
        });
        expect(npc.portrait).toBeUndefined();
        // §3.4 owns these — the converter must not pre-empt it.
        expect(npc.populated).toBeUndefined();
        expect(npc.wants).toBeUndefined();
        expect(npc.personalityHex).toBeUndefined();
        expect(npc.skillRung).toBeUndefined();
        expect(npc.rungCeiling).toBeUndefined();
        expect(npc.pcRelation).toBeUndefined();
        expect(npc.region).toBeUndefined();
        expect(npc.signatureKit).toBeUndefined();
    });

    it('attaches the portrait url when one is supplied', () => {
        const { npc } = cardToNPC(makeCard(), {
            userName: 'You',
            portraitUrl: '/assets/portraits/rin.png',
            makeId: idFactory(),
        });
        expect(npc.portrait).toBe('/assets/portraits/rin.png');
    });
});

describe('WO-C §3.1 — character-sheet lore chunk', () => {
    it('carries the raw description, provenance group, linked entities and token count', () => {
        const card = makeCard({ creator_notes: 'Written for slow play.', tags: ['shy', 'archivist'] });
        const { loreChunks } = cardToNPC(card, { userName: 'You', makeId: idFactory() });
        const sheet = loreChunks[0];
        expect(sheet.header).toBe('Rin — character sheet');
        expect(sheet.category).toBe('character');
        expect(sheet.group).toBe('ST:Rin');
        expect(sheet.linkedEntities).toEqual(['Rin']);
        expect(sheet.triggerKeywords).toEqual(['Rin']);
        expect(sheet.alwaysInclude).toBe(false);
        expect(sheet.ragMode).toBe('keyword');
        expect(sheet.scanDepth).toBe(3);
        expect(sheet.priority).toBe(5);
        expect(sheet.content).toContain('Rin is a quiet archivist.');
        expect(sheet.content).toContain('---');
        expect(sheet.content).toContain('Creator notes: Written for slow play.');
        expect(sheet.content).toContain('Tags: shy, archivist');
        expect(sheet.tokens).toBe(countTokens(`${sheet.header}\n${sheet.content}`));
    });

    it('omits the reference block when there are no notes or tags', () => {
        const { loreChunks } = cardToNPC(makeCard(), { userName: 'You', makeId: idFactory() });
        expect(loreChunks[0].content).not.toContain('---');
    });

    it('emits no sheet chunk when the card has no description, notes or tags', () => {
        const card = makeCard({ description: '', creator_notes: '', tags: [] });
        const { loreChunks } = cardToNPC(card, { userName: 'You', makeId: idFactory() });
        expect(loreChunks).toHaveLength(0);
    });

    it('appends the embedded lorebook after the sheet and surfaces the demoted count', () => {
        const card = makeCard({
            character_book: {
                entries: [
                    makeEntry({ constant: true, insertion_order: 1, comment: 'One' }),
                    makeEntry({ constant: true, insertion_order: 2, comment: 'Two' }),
                    makeEntry({ constant: true, insertion_order: 3, comment: 'Three' }),
                    makeEntry({ constant: true, insertion_order: 4, comment: 'Four' }),
                ],
            },
        });
        const { loreChunks, flags } = cardToNPC(card, { userName: 'You', makeId: idFactory() });
        expect(loreChunks).toHaveLength(5);
        expect(loreChunks[0].header).toBe('Rin — character sheet');
        expect(flags.constantDemoted).toBe(1);
    });
});

describe('WO-C §2.4 — macros are applied to every text field', () => {
    it('replaces {{char}}/<BOT>/{{user}}/<USER> case-insensitively and leaves others alone', () => {
        const card = makeCard({
            name: 'Rin',
            description: '{{Char}} watches <USER> from the stacks. {{unknown}} stays.',
            personality: 'Devoted to {{user}}.',
            scenario: '<BOT> waits for {{USER}}.',
            first_mes: '{{char}} says hello, {{user}}.',
            mes_example: '{{user}}: Hi.\n{{char}}: Hello.',
            creator_notes: 'Notes about {{char}}.',
            tags: ['{{user}}-bound'],
            system_prompt: 'You are {{char}}.',
            character_book: {
                entries: [makeEntry({ keys: ['{{char}}'], comment: 'About {{char}}', content: '{{char}} loves {{user}}.' })],
            },
        });
        const { npc, loreChunks } = cardToNPC(card, { userName: 'Mira', makeId: idFactory() });
        expect(npc.storyRelevance).toContain('Rin watches Mira from the stacks.');
        expect(npc.storyRelevance).toContain('{{unknown}} stays.');
        expect(npc.personality).toBe('Devoted to Mira.');
        expect(npc.exampleOutput).toBe('Mira: Hi.\nRin: Hello.');
        expect(loreChunks[0].content).toContain('Notes about Rin.');
        expect(loreChunks[0].content).toContain('Tags: Mira-bound');
        expect(loreChunks[1].header).toBe('About Rin');
        expect(loreChunks[1].content).toBe('Rin loves Mira.');
        expect(loreChunks[1].triggerKeywords).toEqual(['Rin']);

        const parts = seedCardToCampaignParts(card, 0, 'Mira', idFactory('seed'));
        expect(parts.premiseChunk?.content).toBe('Rin waits for Mira.');
        expect(parts.opening?.content).toBe('Rin says hello, Mira.');
        expect(parts.quarantineChunk?.content).toContain('You are Rin.');
    });
});

describe('WO-C — determinism', () => {
    it('produces identical output for identical input with an injected makeId', () => {
        const card = makeCard({
            character_book: { entries: [makeEntry(), makeEntry({ keys: ['archive'] })] },
        });
        const a = cardToNPC(card, { userName: 'You', makeId: idFactory() });
        const b = cardToNPC(card, { userName: 'You', makeId: idFactory() });
        expect(a).toEqual(b);
        expect(a.npc.id).toBe('id-0');
        expect(a.loreChunks.map(c => c.id)).toEqual(['id-1', 'id-2', 'id-3']);
    });
});

// ── §6.6 bookToLoreChunks ───────────────────────────────────────────────────

describe('WO-C §6.6 / §9.6.6 — bookToLoreChunks', () => {
    it('keeps at most 3 constant entries always-included, lowest insertion_order winning', () => {
        const entries = [
            makeEntry({ constant: true, insertion_order: 40, comment: 'D' }),
            makeEntry({ constant: true, insertion_order: 10, comment: 'A' }),
            makeEntry({ constant: true, insertion_order: 30, comment: 'C' }),
            makeEntry({ constant: true, insertion_order: 20, comment: 'B' }),
            makeEntry({ constant: true, insertion_order: 50, comment: 'E' }),
            makeEntry({ constant: false, insertion_order: 1, comment: 'plain' }),
        ];
        const { chunks, demotedCount } = bookToLoreChunks({ entries }, 'Rin', 'You', idFactory());
        const byHeader = Object.fromEntries(chunks.map(c => [c.header, c]));

        for (const h of ['A', 'B', 'C']) {
            expect(byHeader[h].alwaysInclude).toBe(true);
            expect(byHeader[h].ragMode).toBe('always');
        }
        for (const h of ['D', 'E', 'plain']) {
            expect(byHeader[h].alwaysInclude).toBe(false);
            expect(byHeader[h].ragMode).toBe('keyword');
        }
        // Only the demoted *constant* entries are disclosed, not the plain one.
        expect(demotedCount).toBe(2);
        // Source order is preserved.
        expect(chunks.map(c => c.header)).toEqual(['D', 'A', 'C', 'B', 'E', 'plain']);
    });

    it('does not let a disabled entry compete for an always-on slot', () => {
        const entries = [
            makeEntry({ constant: true, enabled: false, insertion_order: 1, comment: 'off-but-first' }),
            makeEntry({ constant: true, enabled: true, insertion_order: 2, comment: 'A' }),
            makeEntry({ constant: true, enabled: true, insertion_order: 3, comment: 'B' }),
            makeEntry({ constant: true, enabled: true, insertion_order: 4, comment: 'C' }),
        ];
        const { chunks, demotedCount } = bookToLoreChunks({ entries }, 'Rin', 'You', idFactory());
        const byHeader = Object.fromEntries(chunks.map(c => [c.header, c]));

        // All three live entries keep their slots despite the lower-ordered dead one.
        for (const h of ['A', 'B', 'C']) {
            expect(byHeader[h].alwaysInclude).toBe(true);
            expect(byHeader[h].ragMode).toBe('always');
            expect(byHeader[h].disabled).toBe(false);
        }
        // The disabled entry is still imported, just never retrieved.
        expect(byHeader['off-but-first'].disabled).toBe(true);
        expect(byHeader['off-but-first'].alwaysInclude).toBe(false);
        expect(byHeader['off-but-first'].ragMode).toBe('keyword');
        // It was never a candidate, so it is not a disclosure-worthy demotion.
        expect(demotedCount).toBe(0);
    });

    it('breaks insertion_order ties in stable source order', () => {
        const entries = [
            makeEntry({ constant: true, insertion_order: 0, comment: 'first' }),
            makeEntry({ constant: true, insertion_order: 0, comment: 'second' }),
            makeEntry({ constant: true, insertion_order: 0, comment: 'third' }),
            makeEntry({ constant: true, insertion_order: 0, comment: 'fourth' }),
        ];
        const { chunks, demotedCount } = bookToLoreChunks({ entries }, 'Rin', 'You', idFactory());
        expect(chunks.map(c => c.alwaysInclude)).toEqual([true, true, true, false]);
        expect(demotedCount).toBe(1);
    });

    it('marks disabled entries and sets the provenance group on every chunk', () => {
        const entries = [
            makeEntry({ enabled: false, comment: 'off' }),
            makeEntry({ enabled: true, comment: 'on' }),
        ];
        const { chunks } = bookToLoreChunks({ entries }, 'Rin', 'You', idFactory());
        expect(chunks[0].disabled).toBe(true);
        expect(chunks[1].disabled).toBe(false);
        expect(chunks.every(c => c.group === 'ST:Rin')).toBe(true);
        expect(chunks.every(c => c.linkedEntities.length === 1 && c.linkedEntities[0] === 'Rin')).toBe(true);
        expect(chunks.every(c => c.category === 'misc' && c.scanDepth === 3)).toBe(true);
    });

    it('falls back header → comment, first key, "<card> lore"', () => {
        const entries = [
            makeEntry({ comment: 'Tower history', keys: ['tower'] }),
            makeEntry({ comment: '', keys: ['archive', 'ledger'] }),
            makeEntry({ comment: '', keys: [] }),
        ];
        const { chunks } = bookToLoreChunks({ entries }, 'Rin', 'You', idFactory());
        expect(chunks.map(c => c.header)).toEqual(['Tower history', 'archive', 'Rin lore']);
    });

    it('maps keys, secondary keys and a clamped priority', () => {
        const entries = [
            makeEntry({ keys: ['tower', 'archive'], secondary_keys: ['flood'], insertion_order: 7 }),
            makeEntry({ secondary_keys: [], insertion_order: 99 }),
            makeEntry({ secondary_keys: [], insertion_order: -5 }),
        ];
        const { chunks } = bookToLoreChunks({ entries }, 'Rin', 'You', idFactory());
        expect(chunks[0].triggerKeywords).toEqual(['tower', 'archive']);
        expect(chunks[0].secondaryKeywords).toEqual(['flood']);
        expect(chunks[0].priority).toBe(7);
        expect(chunks[1].secondaryKeywords).toBeUndefined();
        expect(chunks[1].priority).toBe(10);
        expect(chunks[2].priority).toBe(0);
        expect(chunks[0].tokens).toBe(countTokens(`${chunks[0].header}\n${chunks[0].content}`));
    });

    it('returns nothing for a missing book or content-less entries', () => {
        expect(bookToLoreChunks(undefined, 'Rin', 'You', idFactory())).toEqual({ chunks: [], demotedCount: 0 });
        const empty = bookToLoreChunks({ entries: [makeEntry({ content: '  ' })] }, 'Rin', 'You', idFactory());
        expect(empty.chunks).toHaveLength(0);
    });
});

// ── §6.7 seedCardToCampaignParts ────────────────────────────────────────────

describe('WO-C §6.7 — seedCardToCampaignParts', () => {
    const seed = makeCard({
        first_mes: 'The archive door swings open.',
        alternate_greetings: ['Rain on the tower roof.', 'A ledger lands on the desk.'],
    });

    it('index 0 selects first_mes', () => {
        const { opening } = seedCardToCampaignParts(seed, 0, 'You', idFactory());
        expect(opening?.content).toBe('The archive door swings open.');
        expect(opening?.role).toBe('assistant');
        expect(typeof opening?.timestamp).toBe('number');
        expect(Object.keys(opening ?? {}).sort()).toEqual(['content', 'id', 'role', 'timestamp']);
    });

    it('index n selects alternate_greetings[n-1]', () => {
        expect(seedCardToCampaignParts(seed, 1, 'You', idFactory()).opening?.content)
            .toBe('Rain on the tower roof.');
        expect(seedCardToCampaignParts(seed, 2, 'You', idFactory()).opening?.content)
            .toBe('A ledger lands on the desk.');
    });

    it('an out-of-range or negative index falls back to first_mes', () => {
        expect(seedCardToCampaignParts(seed, 9, 'You', idFactory()).opening?.content)
            .toBe('The archive door swings open.');
        expect(seedCardToCampaignParts(seed, -1, 'You', idFactory()).opening?.content)
            .toBe('The archive door swings open.');
    });

    it('returns a null opening when the chosen greeting is empty', () => {
        const blank = makeCard({ first_mes: '   ', alternate_greetings: [] });
        expect(seedCardToCampaignParts(blank, 0, 'You', idFactory()).opening).toBeNull();
    });

    it('builds an always-included premise chunk from scenario, or null when empty', () => {
        const { premiseChunk } = seedCardToCampaignParts(seed, 0, 'You', idFactory());
        expect(premiseChunk?.header).toBe('Premise — Rin');
        expect(premiseChunk?.content).toBe('The tower archive floods every spring.');
        expect(premiseChunk?.alwaysInclude).toBe(true);
        expect(premiseChunk?.ragMode).toBe('always');
        expect(premiseChunk?.category).toBe('world_overview');
        expect(premiseChunk?.group).toBe('ST:Rin');
        expect(premiseChunk?.priority).toBe(10);
        expect(premiseChunk?.tokens)
            .toBe(countTokens(`${premiseChunk?.header}\n${premiseChunk?.content}`));

        const noScenario = makeCard({ scenario: '' });
        expect(seedCardToCampaignParts(noScenario, 0, 'You', idFactory()).premiseChunk).toBeNull();
    });

    it('quarantines the system prompt as a disabled chunk carrying both sections', () => {
        const card = makeCard({
            system_prompt: 'Always answer in character.',
            post_history_instructions: 'Never break the fourth wall.',
        });
        const { quarantineChunk } = seedCardToCampaignParts(card, 0, 'You', idFactory());
        expect(quarantineChunk?.header).toBe('ST system prompt (reference — not injected)');
        expect(quarantineChunk?.disabled).toBe(true);
        expect(quarantineChunk?.alwaysInclude).toBe(false);
        expect(quarantineChunk?.ragMode).toBe('keyword');
        expect(quarantineChunk?.category).toBe('rules');
        expect(quarantineChunk?.group).toBe('ST:Rin');
        expect(quarantineChunk?.content).toContain('System prompt:');
        expect(quarantineChunk?.content).toContain('Always answer in character.');
        expect(quarantineChunk?.content).toContain('Post-history instructions:');
        expect(quarantineChunk?.content).toContain('Never break the fourth wall.');
    });

    it('emits no quarantine chunk when both prompt fields are empty', () => {
        const { quarantineChunk } = seedCardToCampaignParts(makeCard(), 0, 'You', idFactory());
        expect(quarantineChunk).toBeNull();
    });

    it('emits a quarantine chunk when only post_history_instructions is set', () => {
        const card = makeCard({ post_history_instructions: 'Stay in scene.' });
        const { quarantineChunk } = seedCardToCampaignParts(card, 0, 'You', idFactory());
        expect(quarantineChunk).not.toBeNull();
        expect(quarantineChunk?.content).toContain('Post-history instructions:');
        expect(quarantineChunk?.content).not.toContain('System prompt:');
    });

    it('is deterministic with an injected makeId', () => {
        const card = makeCard({ system_prompt: 'x' });
        const a = seedCardToCampaignParts(card, 0, 'You', idFactory('s'));
        expect(a.premiseChunk?.id).toBe('s-0');
        expect(a.opening?.id).toBe('s-1');
        expect(a.quarantineChunk?.id).toBe('s-2');
    });
});

// ── §10.2 cardToPC + buildPcContextPatch ────────────────────────────────────

describe('WO-C §10.2 — cardToPC', () => {
    it('yields a PC with no personalityHex and no traits (WO-A2 §0 invariant)', () => {
        const card = makeCard({ personality: 'Shy, bookish.', tags: ['brave'] });
        const pc = cardToPC(card, {});
        expect(pc.personalityHex).toBeUndefined();
        expect(pc.traits).toBeUndefined();
    });

    it('carries the assembled PC fixed values', () => {
        const pc = cardToPC(makeCard(), {});
        expect(pc.isPC).toBe(true);
        expect(pc.populated).toBe(true);
        expect(pc.affinity).toBe(50);
        expect(pc.status).toBe('Alive');
        expect(pc.name).toBe('Rin');
        expect(pc.appearance).toBe('');
        expect(pc.visualProfile?.artStyle).toBe('Stylized Game Realism');
    });

    it('maps the story slice to storyRelevance and the first example line to voice', () => {
        const card = makeCard({
            mes_example: '<START>\n{{user}}: Are you well?\n{{char}}: Ink-stained, but well.',
        });
        const pc = cardToPC(card, { userName: 'Mira' });
        expect(pc.storyRelevance).toBe('Rin is a quiet archivist. She keeps the tower records.');
        expect(pc.voice).toBe('Mira: Are you well?');
        expect(pc.exampleOutput).toContain('Rin: Ink-stained, but well.');
        expect(pc.exampleOutput).not.toContain('<START>');
    });

    it('applies the same personality precedence and caps as the NPC path', () => {
        const wpp = cardToPC(makeCard({ personality: '[Character("Rin"){Age("17") Likes("tea")}]' }), {});
        expect(wpp.personality).toBe('Age: 17\nLikes: tea');

        const tagsOnly = cardToPC(makeCard({ personality: '', tags: ['shy', 'loyal'] }), {});
        expect(tagsOnly.personality).toBe('shy, loyal');

        const long = cardToPC(makeCard({ personality: 'word '.repeat(200).trim() }), {});
        expect(long.personality.length).toBeLessThanOrEqual(400);
    });

    it('attaches the portrait when given, defaults {{user}} to "You"', () => {
        const card = makeCard({ description: '{{char}} greets {{user}}.' });
        const pc = cardToPC(card, { portraitUrl: '/assets/portraits/pc.png' });
        expect(pc.portrait).toBe('/assets/portraits/pc.png');
        expect(pc.storyRelevance).toBe('Rin greets You.');
    });
});

describe('WO-C §10.2 — buildPcContextPatch', () => {
    it('mirrors commitCharacterDraft on an empty base', () => {
        const pc = cardToPC(makeCard(), {});
        const patch = buildPcContextPatch(pc, {});
        expect(patch.characterProfileData).toEqual({
            name: 'Rin', race: '', class: '', level: 1, hp: { current: 20, max: 20 },
        });
        expect(patch.characterProfile).toEqual({ identity: { name: 'Rin' }, activeTraits: [] });
        expect(patch.characterProfileActive).toBe(true);
        expect(patch.creationDraft).toBeNull();
        expect('playerCharacter' in patch).toBe(false);
    });

    it('preserves existing profile data and traits, overwriting only the name', () => {
        const pc = cardToPC(makeCard(), {});
        const base: Partial<GameContext> = {
            characterProfileData: {
                name: 'Old', race: 'elf', class: 'scribe', level: 4,
                hp: { current: 11, max: 30 }, stats: { str: 8 }, skills: ['lore'],
                abilities: [], traits: [], notes: 'kept',
            } as CharacterProfile,
            characterProfile: {
                identity: { name: 'Old', race: 'elf' },
                activeTraits: [],
                legacyNotes: 'kept',
            },
        };
        const patch = buildPcContextPatch(pc, base);
        expect(patch.characterProfileData?.name).toBe('Rin');
        expect(patch.characterProfileData?.level).toBe(4);
        expect(patch.characterProfileData?.hp).toEqual({ current: 11, max: 30 });
        expect(patch.characterProfileData?.race).toBe('elf');
        expect(patch.characterProfile?.identity).toEqual({ name: 'Rin', race: 'elf' });
        expect(patch.characterProfile?.legacyNotes).toBe('kept');
    });
});

// ── Exported helpers ────────────────────────────────────────────────────────

describe('WO-C §3.1 — exported text helpers', () => {
    it('isStructuredText detects W++ and bare key("value") runs', () => {
        expect(isStructuredText('[Character("Rin")]')).toBe(true);
        expect(isStructuredText('Age("17") Likes("tea")')).toBe(true);
        expect(isStructuredText("Age('17')")).toBe(true);
        expect(isStructuredText('Rin is a quiet archivist.')).toBe(false);
        expect(isStructuredText('')).toBe(false);
        // Far past the 200-char sniff window → treated as prose.
        expect(isStructuredText(`${'prose '.repeat(40)}Age("17")`)).toBe(false);
    });

    it('wppToTraitLines drops the wrapper key and joins multi-values', () => {
        expect(wppToTraitLines('[Character("Rin"){Age("17") Likes("tea","rain")}]'))
            .toBe('Age: 17\nLikes: tea, rain');
        expect(wppToTraitLines('Mind(curious + patient)')).toBe('Mind: curious, patient');
        expect(wppToTraitLines('[ nothing parseable here ]')).toBe('nothing parseable here');
        expect(wppToTraitLines('')).toBe('');
    });

    it('cutAtSentence returns short text untouched and never exceeds the cap', () => {
        expect(cutAtSentence('Short.', 300)).toBe('Short.');
        const long = 'One sentence here. Two sentence here. Three sentence here.';
        const cut = cutAtSentence(long, 25);
        expect(cut).toBe('One sentence here.');
        expect(cutAtSentence('nopunctuationatallhereatall', 10).length).toBeLessThanOrEqual(10);
    });

    it('cutExampleAtStart never cuts mid-line even when one block is over the cap', () => {
        const lines = Array.from({ length: 40 }, (_, i) => `line ${i} ${'x'.repeat(30)}`);
        const out = cutExampleAtStart(`<START>\n${lines.join('\n')}`, 800);
        expect(out.length).toBeLessThanOrEqual(800);
        for (const line of out.split('\n')) expect(lines).toContain(line);
        expect(cutExampleAtStart('', 800)).toBe('');
        expect(cutExampleAtStart('<START>\n<START>', 800)).toBe('');
    });
});
