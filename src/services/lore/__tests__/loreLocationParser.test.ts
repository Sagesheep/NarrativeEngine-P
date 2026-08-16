import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseLocationsFromLore, parseLocationHeaderName, trimToSentences } from '../loreLocationParser';
import { chunkLoreFile } from '../loreChunker';
import type { LoreChunk } from '../../../types';

/** Build a minimal location-classified LoreChunk with the given header + body. */
function locChunk(header: string, content: string): LoreChunk {
    return {
        id: `test-${Math.random().toString(36).slice(2, 8)}`,
        header,
        content,
        tokens: 100,
        alwaysInclude: false,
        triggerKeywords: [],
        category: 'location',
        linkedEntities: [],
        priority: 6,
        scanDepth: 3,
    };
}

describe('parseLocationHeaderName', () => {
    it('splits the trailing parenthetical into the broad location', () => {
        expect(parseLocationHeaderName('LOCATION -- Caldera City (Caldera)'))
            .toEqual({ name: 'Caldera City', broadLocation: 'Caldera' });
    });

    it('handles a multi-word region', () => {
        expect(parseLocationHeaderName('LOCATION -- The Marrow Clans (North of Caldera)'))
            .toEqual({ name: 'The Marrow Clans', broadLocation: 'North of Caldera' });
    });

    it('handles an em-dash marker and a bare header', () => {
        expect(parseLocationHeaderName('LOCATION — Veythar City').name).toBe('Veythar City');
        expect(parseLocationHeaderName('Karsos City')).toEqual({ name: 'Karsos City', broadLocation: '' });
    });

    it('strips a [CHUNK: ...] marker', () => {
        expect(parseLocationHeaderName('[CHUNK: LOCATION] Iron Citadel (Plains)'))
            .toEqual({ name: 'Iron Citadel', broadLocation: 'Plains' });
    });
});

describe('trimToSentences', () => {
    it('leaves short text untouched', () => {
        expect(trimToSentences('A small keep.')).toBe('A small keep.');
    });

    it('cuts on a sentence boundary, never mid-sentence', () => {
        const text = `${'A'.repeat(100)}. ${'B'.repeat(100)}. ${'C'.repeat(100)}.`;
        const out = trimToSentences(text, 240);
        expect(out.length).toBeLessThanOrEqual(240);
        expect(out.endsWith('.')).toBe(true);
        expect(out).not.toContain('C');
    });

    it('word-boundary truncates when the first sentence alone overruns', () => {
        const out = trimToSentences(`${'word '.repeat(100)}end.`, 60);
        expect(out.length).toBeLessThanOrEqual(60);
        expect(out.endsWith('…')).toBe(true);
    });
});

describe('parseLocationsFromLore — field mapping', () => {
    const BLOCK = `**Type:** Capital city
**Status:** Flourishing, politically tense
The seat of the Calderan Crown. A walled city of stone and timber.`;

    it('maps Status and leads the description with Type', () => {
        const [loc] = parseLocationsFromLore([locChunk('LOCATION -- Caldera City (Caldera)', BLOCK)]);
        expect(loc.name).toBe('Caldera City');
        expect(loc.broadLocation).toBe('Caldera');
        expect(loc.status).toBe('Flourishing, politically tense');
        expect(loc.description).toBe('Capital city. The seat of the Calderan Crown. A walled city of stone and timber.');
    });

    it('marks lore-seeded entries as manual and unvisited', () => {
        const [loc] = parseLocationsFromLore([locChunk('LOCATION -- Caldera City (Caldera)', BLOCK)]);
        expect(loc.source).toBe('manual');
        expect(loc.firstSeenScene).toBe('');
        expect(loc.lastSeenScene).toBe('');
        expect(loc.id).toMatch(/^loc_/);
    });

    it('ignores non-location chunks', () => {
        const chunk = locChunk('CHARACTER -- Ser Caitlin', BLOCK);
        expect(parseLocationsFromLore([{ ...chunk, category: 'character' }])).toHaveLength(0);
    });

    it('does not duplicate the Type when the prose already opens with it', () => {
        const [loc] = parseLocationsFromLore([locChunk('LOCATION -- Keep', '**Type:** Border region\nBorder region on the frontier.')]);
        expect(loc.description).toBe('Border region on the frontier.');
    });

    it('omits status when the block has none', () => {
        const [loc] = parseLocationsFromLore([locChunk('LOCATION -- Keep', 'Just prose.')]);
        expect(loc.status).toBeUndefined();
    });

    it('collapses duplicate headers from windowed chunks', () => {
        const locs = parseLocationsFromLore([
            locChunk('LOCATION -- Caldera City (Caldera)', BLOCK),
            locChunk('LOCATION -- Caldera City (Caldera)', BLOCK),
        ]);
        expect(locs).toHaveLength(1);
    });
});

describe('parseLocationsFromLore — optional authored fields', () => {
    it('reads aliases, features, and an explicit description', () => {
        const [loc] = parseLocationsFromLore([locChunk('LOCATION -- Caldera City (Caldera)', `
**Aliases:** the capital, Calderaton
**Features:** [Royal Keep, horse market, lower city]
**Description:** A short authored line.
Prose that should lose to the explicit Description field.`)]);
        expect(loc.aliases).toBe('the capital, Calderaton');
        expect(loc.features).toEqual(['Royal Keep', 'horse market', 'lower city']);
        expect(loc.description).toBe('A short authored line.');
    });

    it('lets BroadLocation override the header parenthetical', () => {
        const [loc] = parseLocationsFromLore([locChunk('LOCATION -- Keep (Wrong)', '**BroadLocation:** Right\nProse.')]);
        expect(loc.broadLocation).toBe('Right');
    });

    it('caps features at 20', () => {
        const many = Array.from({ length: 30 }, (_, i) => `f${i}`).join(', ');
        const [loc] = parseLocationsFromLore([locChunk('LOCATION -- Keep', `**Features:** [${many}]\nProse.`)]);
        expect(loc.features).toHaveLength(20);
    });
});

describe('parseLocationsFromLore — connections', () => {
    it('resolves ConnectedTo bidirectionally, including forward references', () => {
        const [a, b] = parseLocationsFromLore([
            locChunk('LOCATION -- Caldera City', '**ConnectedTo:** [The Northern Marches]\nProse.'),
            locChunk('LOCATION -- The Northern Marches', 'Prose.'),
        ]);
        expect(a.connections).toEqual([{ toId: b.id, band: 'local' }]);
        expect(b.connections).toEqual([{ toId: a.id, band: 'local' }]);
    });

    it('resolves through an alias', () => {
        const [a, b] = parseLocationsFromLore([
            locChunk('LOCATION -- Caldera City', '**ConnectedTo:** [the marches]\nProse.'),
            locChunk('LOCATION -- The Northern Marches', '**Aliases:** the marches\nProse.'),
        ]);
        expect(a.connections[0].toId).toBe(b.id);
    });

    it('drops names that match nothing in the file, and self-references', () => {
        const [a] = parseLocationsFromLore([
            locChunk('LOCATION -- Caldera City', '**ConnectedTo:** [Atlantis, Caldera City]\nProse.'),
        ]);
        expect(a.connections).toEqual([]);
    });

    it('caps connections at 8', () => {
        const targets = Array.from({ length: 12 }, (_, i) => locChunk(`LOCATION -- P${i}`, 'Prose.'));
        const hub = locChunk('LOCATION -- Hub', `**ConnectedTo:** [${targets.map((_, i) => `P${i}`).join(', ')}]\nProse.`);
        const [parsedHub] = parseLocationsFromLore([hub, ...targets]);
        expect(parsedHub.connections).toHaveLength(8);
    });
});

describe('parseLocationsFromLore — Aethelgard compendium (real file)', () => {
    const lore = readFileSync(
        resolve(
            __dirname,
            '../../../../Example_Setup/World_compendium/Original World/Aethelgard - Medieval Fire Emblem Fantasy/world_lore_aethelgard.md',
        ),
        'utf-8',
    );
    const locations = parseLocationsFromLore(chunkLoreFile(lore));

    it('extracts all seven canon places with their regions', () => {
        expect(locations.map(l => l.name)).toEqual([
            'Caldera City',
            'The Northern Marches',
            'Veythar City',
            'Karsos City',
            'Ser Elenwin Academy',
            'The Marrow Clans',
            'The Drevat Bank Holdings',
        ]);
        expect(locations.find(l => l.name === 'Karsos City')?.broadLocation).toBe('Karsos');
        expect(locations.find(l => l.name === 'Ser Elenwin Academy')?.broadLocation).toBe('Neutral Ground');
    });

    it('carries Status through to the ledger', () => {
        expect(locations.find(l => l.name === 'The Northern Marches')?.status)
            .toBe('Contested (perennial border raids)');
    });

    it('keeps every description inside the [LOCATION] block budget', () => {
        // payload/volatile.ts caps the whole block at 400 chars and blind-slices
        // as a last resort; a lore paragraph must not be what triggers that.
        for (const loc of locations) {
            expect(loc.description.length).toBeLessThanOrEqual(240);
            expect(loc.description).not.toMatch(/\*\*/);
        }
    });

    it('leads descriptions with the lore Type', () => {
        expect(locations.find(l => l.name === 'Caldera City')?.description)
            .toMatch(/^Capital city\. The seat of the Calderan Crown\./);
    });
});
