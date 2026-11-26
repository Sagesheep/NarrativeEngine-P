import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cardFromDraft, createWorldCard, draftFromCard, emptyWorldDraft, parseWorldJson, readWorldFile } from '../worldCard';
import { MAX_WORLD_FILE_BYTES, readWorldPng, writeWorldPng } from '../worldCardPng';
import { parsePngCard, parseJsonCard } from '../../import/stCardParser';
import { buildCardPng, encodeCardPayload } from '../../import/__tests__/pngFixture';
import { exportDraftToMarkdown } from '../worldLoreExport';

const fixture = JSON.parse(readFileSync('Example_Setup/World_compendium/Franchisee/Persona 3/Persona 3.world.json', 'utf8'));
const plainPng = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
const book = { name: 'Persona 3', entries: [{ comment: 'Tartarus', content: 'A labyrinth in the Dark Hour.', keys: ['Tartarus'], enabled: true }] };
const stCard = { spec: 'chara_card_v2', data: { name: 'Someone', character_book: book, description: 'CHARACTER ONLY', first_mes: 'GREETING ONLY', system_prompt: 'PROMPT ONLY' } };
function file(bytes: Uint8Array<ArrayBuffer>, name = 'world.png') {
    return { name, size: bytes.length, arrayBuffer: async () => bytes.buffer, text: async () => new TextDecoder().decode(bytes) };
}

describe('native world sharing', () => {
    it('round trips Persona 3 text, Unicode, keywords, modes and disabled status', async () => {
        const original = parseWorldJson(fixture).card;
        const png = writeWorldPng(plainPng, original);
        const imported = await readWorldFile(file(png));
        expect(imported.source).toBe('native');
        expect(imported.card).toEqual(original);
        expect(imported.card.world.chunks[1].header).toContain('月光館学園');
        expect(imported.card.world.chunks[2].secondaryKeywords).toEqual(['Dark Hour', 'explore']);
        expect(imported.card.world.chunks[4].disabled).toBe(true);
        expect(imported.card.world.chunks[0].tokens).toBeGreaterThan(0);
    });
    it('exports no ST card, even when the cover used to be a character card', () => {
        const cover = new Uint8Array(buildCardPng(stCard));
        const png = writeWorldPng(cover, parseWorldJson(fixture).card);
        expect(parsePngCard(png.buffer)).toEqual({ ok: false, reason: 'no-card-payload' });
        expect(parseJsonCard(JSON.stringify(fixture))).toBeNull();
        expect(new TextDecoder().decode(png)).not.toContain(encodeCardPayload(stCard));
    });
    it('replaces prior world metadata instead of duplicating it', () => {
        const first = writeWorldPng(plainPng, fixture);
        const second = writeWorldPng(first, { ...fixture, version: 7 });
        expect(readWorldPng(second)).toEqual({ ...fixture, version: 7 });
    });
    it('preserves builder sections and imported entries without exporting raw source', () => {
        const draft = emptyWorldDraft('Persona 3');
        draft.background = 'School days and the Dark Hour.';
        draft.locations = [{ id: 'place', title: 'Tartarus', body: 'A labyrinth.' }];
        draft.characterCreationQuestions = 'What do you want from school life?';
        draft.rawSource = 'PRIVATE SCRATCH SOURCE';
        draft.importedLoreChunks = parseWorldJson(fixture).card.world.chunks;
        const card = cardFromDraft(draft);
        card.world.author = 'Test author';
        const restored = draftFromCard(parseWorldJson(readWorldPng(writeWorldPng(plainPng, card))).card);
        expect(restored.background).toBe(draft.background);
        expect(restored.locations[0].body).toBe('A labyrinth.');
        expect(restored.characterCreationQuestions).toBe(draft.characterCreationQuestions);
        expect(restored.importedLoreChunks).toHaveLength(5);
        expect(restored.worldCardMetadata?.author).toBe('Test author');
        expect(JSON.stringify(card)).not.toContain('PRIVATE SCRATCH SOURCE');
        expect(exportDraftToMarkdown(restored)).not.toContain('This entry exists only');
        expect(cardFromDraft(restored).world.chunks.filter(c => c.header === 'Tartarus')).toHaveLength(2);
    });
    it('allowlists data instead of sharing extra campaign fields', () => {
        const chunks = [{ ...fixture.world.chunks[0], apiKey: 'SECRET', transcript: 'PRIVATE' }];
        expect(JSON.stringify(createWorldCard('World', chunks))).not.toMatch(/SECRET|PRIVATE/);
    });
    it('rejects unsupported versions, damaged metadata, truncated PNGs and ordinary images', async () => {
        expect(() => parseWorldJson({ ...fixture, version: 2 })).toThrow(/newer/);
        expect(() => readWorldPng(plainPng.slice(0, -6))).toThrow(/truncated/);
        const png = writeWorldPng(plainPng, fixture);
        const corrupt = png.slice();
        corrupt[corrupt.length - 17] ^= 1;
        expect(() => readWorldPng(corrupt)).toThrow(/integrity/);
        await expect(readWorldFile(file(plainPng))).rejects.toThrow(/No world lore/);
        await expect(readWorldFile({ ...file(plainPng), size: MAX_WORLD_FILE_BYTES + 1 })).rejects.toThrow(/20 MB/);
    });
    it('rejects malformed schemas and duplicate entry ids', () => {
        expect(() => parseWorldJson({ ...fixture, world: { ...fixture.world, chunks: [{}] } })).toThrow(/Invalid lore/);
        expect(() => createWorldCard('x', [fixture.world.chunks[0], fixture.world.chunks[0]])).toThrow(/Duplicate/);
    });
});

describe('one-way SillyTavern lore adaptation', () => {
    it.each(['chara', 'ccv3'] as const)('imports embedded lore from %s, excluding character fields', async keyword => {
        const result = await readWorldFile(file(new Uint8Array(buildCardPng(stCard, { keyword }))));
        expect(result.source).toBe('sillytavern');
        expect(result.card.world.name).toBe('Persona 3');
        expect(result.card.world.chunks).toHaveLength(1);
        expect(JSON.stringify(result.card)).not.toMatch(/CHARACTER ONLY|GREETING ONLY|PROMPT ONLY|Someone/);
        expect(result.warnings.length).toBeGreaterThan(0);
    });
    it('prefers V3 lore when both ST payloads are present', async () => {
        const png = buildCardPng(stCard, { keyword: 'ccv3', extraText: [{ keyword: 'chara', text: encodeCardPayload({ ...stCard, data: { name: 'No book' } }) }] });
        expect((await readWorldFile(file(new Uint8Array(png)))).card.world.name).toBe('Persona 3');
    });
    it('imports standalone entry dictionaries and maps enabled, constant, secondary and depth', () => {
        const result = parseWorldJson({ name: 'World', entries: {
            0: { content: 'Hidden', key: ['Dark Hour'], keysecondary: ['midnight'], selective: true, selectiveLogic: 0, constant: false, disable: true, scanDepth: 5 },
            1: { content: 'Always', keys: ['world'], constant: true },
        } });
        expect(result.card.world.chunks[0]).toMatchObject({ disabled: true, secondaryKeywords: ['midnight'], scanDepth: 5, triggerKeywords: ['Dark Hour'] });
        expect(result.card.world.chunks[1]).toMatchObject({ alwaysInclude: true, ragMode: 'always' });
    });
    it('does not apply secondary keys when selective is off', () => {
        const result = parseWorldJson({ entries: [{ content: 'Lore', keysecondary: ['ignored'], selective: false }] });
        expect(result.card.world.chunks[0].secondaryKeywords).toBeUndefined();
    });
    it('disables unsupported gates and unresolved macros for review', () => {
        const result = parseWorldJson({ entries: [
            { content: 'Gated lore', keysecondary: ['x'], selective: true, selectiveLogic: 2 },
            { content: '{{char}} lives here.' },
        ] });
        expect(result.card.world.chunks.every(c => c.disabled)).toBe(true);
        expect(result.warnings.join(' ')).toMatch(/macros/);
    });
    it('rejects character-only files and empty lorebooks', () => {
        expect(() => parseWorldJson({ spec: 'chara_card_v2', data: { name: 'Someone', description: 'hello' } })).toThrow(/No embedded lorebook/);
        expect(() => parseWorldJson({ entries: [] })).toThrow(/no lore text/);
    });
});
