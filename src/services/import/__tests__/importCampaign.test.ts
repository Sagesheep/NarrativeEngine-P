import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    buildImportPlan,
    createCampaignFromImport,
    rosterTilesForImport,
    type CreateDeps,
    type ImportChoices,
    type ImportPlan,
} from '../importCampaign';
import type { ShelfTile } from '../shelf';
import type { STCard } from '../stCardTypes';
import type { Campaign, LoreChunk, NPCEntry } from '../../../types';
import type { CampaignState } from '../../../store/campaignStore';
import { countTokens } from '../../infrastructure/tokenizer';
import { buildCardPng } from './pngFixture';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function card(over: Partial<STCard> = {}): STCard {
    return {
        name: 'Aria',
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
        spec: 'v2',
        ...over,
    };
}

function tile(id: string, c: STCard, over: Partial<ShelfTile> = {}): ShelfTile {
    return { id, fileName: `${id}.png`, card: c, star: false, persona: false, ...over };
}

/** A real `File` so the portrait/cover paths have something to hand their deps. */
function pngFile(name: string): File {
    return new File([buildCardPng({ name })], `${name}.png`, { type: 'image/png' });
}

function makeIdFactory(): () => string {
    let n = 0;
    return () => `id-${++n}`;
}

const rng = () => 0.42;

function choices(over: Partial<ImportChoices> = {}): ImportChoices {
    return {
        mode: 'seeded',
        greetingIndex: 0,
        who: { kind: 'build-own', playerName: 'Kaito' },
        campaignName: '',
        duplicateResolutions: {},
        ...over,
    };
}

const SEED = card({
    name: 'Aria',
    scenario: 'The tower has stood empty for a hundred years.',
    first_mes: 'Aria looks up as {{user}} enters.',
    description: 'A tall archivist who never sleeps. She keeps the tower ledgers.',
    personality: 'patient, watchful',
});

const PLAIN = card({
    name: 'Bram',
    description: 'A blacksmith with soot under his nails.',
    personality: 'gruff',
});

function seededTiles(): ShelfTile[] {
    return [tile('t-bram', PLAIN), tile('t-aria', SEED, { star: true })];
}

function seededFiles(): Map<string, File> {
    return new Map([
        ['t-bram', pngFile('bram')],
        ['t-aria', pngFile('aria')],
    ]);
}

// ─── buildImportPlan ─────────────────────────────────────────────────────────

describe('buildImportPlan — roster (§4 Step 4, §8)', () => {
    it('puts the ★ seed first in the roster AND keeps it as an NPC', () => {
        const plan = buildImportPlan(seededTiles(), seededFiles(), choices(), {
            matureMode: false, rng, makeId: makeIdFactory(),
        });

        expect(plan.roster.map(e => e.npc.name)).toEqual(['Aria', 'Bram']);
        expect(plan.seedParts?.premiseChunk?.content).toBe('The tower has stood empty for a hundred years.');
        // The seed is the world's anchor character, never consumed by the premise.
        expect(plan.roster[0].tileId).toBe('t-aria');
    });

    it('runs populateImportedNPC on every roster entry (§3.4 — the agency gate)', () => {
        const plan = buildImportPlan(seededTiles(), seededFiles(), choices(), {
            matureMode: false, rng, makeId: makeIdFactory(),
        });

        for (const entry of plan.roster) {
            expect(entry.npc.populated).toBe(true);
            expect(entry.npc.tier).toBe('recurring');
            expect(entry.npc.personalityHex).toBeDefined();
            expect(entry.npc.wants?.short.length).toBeGreaterThan(0);
            expect(entry.npc.wants?.long).toBe('');
        }
    });

    it('bakes {{user}} against the typed player name, and "You" when it is blank', () => {
        const tiles = [tile('t-aria', card({
            name: 'Aria',
            scenario: 'A tower.',
            description: '{{user}} met {{char}} once.',
        }), { star: true })];

        const named = buildImportPlan(tiles, new Map(), choices(), { matureMode: false, rng, makeId: makeIdFactory() });
        expect(named.playerName).toBe('Kaito');
        expect(named.roster[0].npc.storyRelevance).toBe('Kaito met Aria once.');

        const blank = buildImportPlan(tiles, new Map(), choices({
            who: { kind: 'build-own', playerName: '   ' },
        }), { matureMode: false, rng, makeId: makeIdFactory() });
        expect(blank.playerName).toBe('You');
        expect(blank.roster[0].npc.storyRelevance).toBe('You met Aria once.');
    });

    it('names the campaign after the seed card, or the user override', () => {
        const auto = buildImportPlan(seededTiles(), seededFiles(), choices(), {
            matureMode: false, rng, makeId: makeIdFactory(),
        });
        expect(auto.campaign.name).toBe('Aria');
        expect(auto.campaign.coverFile?.name).toBe('aria.png');

        const named = buildImportPlan(seededTiles(), seededFiles(), choices({ campaignName: '  The Tower  ' }), {
            matureMode: false, rng, makeId: makeIdFactory(),
        });
        expect(named.campaign.name).toBe('The Tower');
    });
});

describe('buildImportPlan — §10.2 who the player is', () => {
    it('build-own seeds a creation draft and leaves the PC null', () => {
        const plan = buildImportPlan(seededTiles(), seededFiles(), choices(), {
            matureMode: false, rng, makeId: makeIdFactory(),
        });
        expect(plan.persona).toBeNull();
        expect(plan.creationDraft).toEqual({ name: 'Kaito', step: 0 });
    });

    it('persona: the tile leaves the roster and becomes the PC, with no hex and no traits', () => {
        const tiles = seededTiles();
        const plan = buildImportPlan(tiles, seededFiles(), choices({
            who: { kind: 'persona', tileId: 't-bram' },
        }), { matureMode: false, rng, makeId: makeIdFactory() });

        expect(plan.roster.map(e => e.npc.name)).toEqual(['Aria']);
        expect(plan.persona?.pc.name).toBe('Bram');
        expect(plan.persona?.pc.isPC).toBe(true);
        // WO-A2 §0 invariant — hex and traits are the quiz's or the user's alone.
        expect(plan.persona?.pc.personalityHex).toBeUndefined();
        expect(plan.persona?.pc.traits).toBeUndefined();
        // `{{user}}` now means the persona card.
        expect(plan.playerName).toBe('Bram');
        expect(plan.creationDraft).toBeNull();
        expect(plan.persona?.pngFile?.name).toBe('bram.png');
        // §4 Step 3 — the persona's full description still lands as a lore chunk.
        expect(plan.persona?.loreChunks.some(c => c.group === 'ST:Bram' && /character sheet/.test(c.header))).toBe(true);
        expect(plan.roster.flatMap(e => e.loreChunks).some(c => c.group === 'ST:Bram')).toBe(false);
    });

    it('flags a roster card that shares the player character name', () => {
        const tiles = [
            tile('t-aria', SEED, { star: true }),
            tile('t-twin', card({ name: 'Kaito', description: 'Another Kaito entirely.' })),
        ];
        const plan = buildImportPlan(tiles, new Map(), choices(), { matureMode: false, rng, makeId: makeIdFactory() });
        expect(plan.summary.personaNameCollision).toBe(true);
    });
});

describe('buildImportPlan — npcs-only (§4 Step 1 ghost button)', () => {
    it('imports the roster with no seed parts, no draft and an unnamed player', () => {
        const plan = buildImportPlan(seededTiles(), seededFiles(), choices({
            mode: 'npcs-only',
            campaignName: '',
        }), { matureMode: false, rng, makeId: makeIdFactory() });

        expect(plan.seedParts).toBeNull();
        expect(plan.creationDraft).toBeNull();
        expect(plan.persona).toBeNull();
        expect(plan.playerName).toBe('You');
        expect(plan.campaign.coverFile).toBeNull();
        expect(plan.campaign.name).toBe('Imported cast');
        // The star is ignored in this mode — the roster keeps drop order.
        expect(plan.roster.map(e => e.npc.name)).toEqual(['Bram', 'Aria']);
    });
});

describe('buildImportPlan — §9.2 premise / opening overrides', () => {
    it('replaces the text and recounts tokens', () => {
        const plan = buildImportPlan(seededTiles(), seededFiles(), choices({
            premiseOverride: 'A drowned city under a green sky.',
            openingOverride: 'Rain hammers the dock as you step off the boat.',
        }), { matureMode: false, rng, makeId: makeIdFactory() });

        const premise = plan.seedParts?.premiseChunk;
        expect(premise?.content).toBe('A drowned city under a green sky.');
        expect(premise?.tokens).toBe(countTokens(`${premise?.header}\nA drowned city under a green sky.`));
        expect(premise?.alwaysInclude).toBe(true);
        expect(plan.seedParts?.opening?.content).toBe('Rain hammers the dock as you step off the boat.');
    });

    it('a blank override keeps the source text', () => {
        const plan = buildImportPlan(seededTiles(), seededFiles(), choices({
            premiseOverride: '   ',
            openingOverride: '',
        }), { matureMode: false, rng, makeId: makeIdFactory() });

        expect(plan.seedParts?.premiseChunk?.content).toBe('The tower has stood empty for a hundred years.');
        expect(plan.seedParts?.opening?.content).toBe('Aria looks up as Kaito enters.');
    });
});

describe('buildImportPlan — §9.4 intra-drop duplicates', () => {
    const early = card({
        name: 'Aria',
        scenario: 'A tower.',
        description: 'The early Aria, written first.',
        personality: 'patient',
    });
    const late = card({
        name: 'aria',
        description: 'The later Aria, written second.',
        personality: 'restless',
    });

    function dupTiles(): ShelfTile[] {
        return [tile('t-early', early, { star: true }), tile('t-late', late)];
    }

    it('overwrite merges the later card into the earlier row and replaces its lore group', () => {
        const plan = buildImportPlan(dupTiles(), new Map(), choices({
            duplicateResolutions: { 't-late': 'overwrite' },
        }), { matureMode: false, rng, makeId: makeIdFactory() });

        expect(plan.roster).toHaveLength(1);
        const entry = plan.roster[0];
        // Campaign-owned identity survives; card-owned fields come from the later card.
        expect(entry.tileId).toBe('t-early');
        expect(entry.npc.name).toBe('Aria');
        expect(entry.npc.personality).toBe('restless');
        expect(entry.npc.storyRelevance).toBe('The later Aria, written second.');
        // The earlier card's ST: group is gone, not appended alongside.
        const bodies = entry.loreChunks.map(c => c.content).join('\n');
        expect(bodies).toContain('The later Aria, written second.');
        expect(bodies).not.toContain('The early Aria, written first.');
        expect(plan.summary.overwrittenDuplicates).toEqual(['aria']);
        expect(plan.summary.skippedDuplicates).toEqual([]);
    });

    it('skip drops the later card entirely', () => {
        const plan = buildImportPlan(dupTiles(), new Map(), choices({
            duplicateResolutions: { 't-late': 'skip' },
        }), { matureMode: false, rng, makeId: makeIdFactory() });

        expect(plan.roster).toHaveLength(1);
        expect(plan.roster[0].npc.personality).toBe('patient');
        expect(plan.summary.skippedDuplicates).toEqual(['aria']);
        expect(plan.summary.overwrittenDuplicates).toEqual([]);
    });

    it('an unanswered duplicate is skipped, never silently merged', () => {
        const plan = buildImportPlan(dupTiles(), new Map(), choices(), {
            matureMode: false, rng, makeId: makeIdFactory(),
        });
        expect(plan.roster).toHaveLength(1);
        expect(plan.summary.skippedDuplicates).toEqual(['aria']);
    });
});

describe('buildImportPlan — §9.6 disclosures', () => {
    it('reports tag-inferred personalities, W++ descriptions and demoted constants', () => {
        const wpp = card({
            name: 'Rin',
            description: '[Character("Rin"){Age("17") Likes("tea")}]',
            personality: '',
            tags: ['shy', 'scholar'],
            character_book: {
                entries: [0, 1, 2, 3, 4].map(i => ({
                    keys: [`k${i}`],
                    secondary_keys: [],
                    content: `Constant lore ${i}`,
                    comment: `Entry ${i}`,
                    constant: true,
                    enabled: true,
                    insertion_order: i,
                })),
            },
        });
        const tiles = [tile('t-aria', SEED, { star: true }), tile('t-rin', wpp)];

        const plan = buildImportPlan(tiles, new Map(), choices(), {
            matureMode: false, rng, makeId: makeIdFactory(),
        });

        expect(plan.summary.inferredFromTags).toEqual(['Rin']);
        expect(plan.summary.structuredDescriptions).toEqual(['Rin']);
        // 5 constants, 3 slots kept → 2 routed to searchable memory.
        expect(plan.summary.constantDemoted).toBe(2);
    });
});

describe('rosterTilesForImport', () => {
    it('drops unparsed tiles and the persona, and honours the star only when seeding', () => {
        const tiles = [
            { id: 't-bad', fileName: 'bad.png', card: null, failure: 'no-card-payload' as const, star: false, persona: false },
            tile('t-bram', PLAIN),
            tile('t-aria', SEED, { star: true }),
        ];
        expect(rosterTilesForImport(tiles, 'seeded', null).map(t => t.id)).toEqual(['t-aria', 't-bram']);
        expect(rosterTilesForImport(tiles, 'seeded', 't-bram').map(t => t.id)).toEqual(['t-aria']);
        expect(rosterTilesForImport(tiles, 'npcs-only', null).map(t => t.id)).toEqual(['t-bram', 't-aria']);
    });
});

// ─── createCampaignFromImport (§10.3) ────────────────────────────────────────

type Recorded = {
    calls: string[];
    campaign: Campaign | null;
    chunks: LoreChunk[];
    npcs: NPCEntry[];
    state: CampaignState | null;
    deps: CreateDeps;
};

function recordingDeps(over: Partial<CreateDeps> = {}): Recorded {
    const rec: Recorded = {
        calls: [], campaign: null, chunks: [], npcs: [], state: null,
        deps: {} as CreateDeps,
    };
    rec.deps = {
        saveCampaign: async (c) => { rec.calls.push('saveCampaign'); rec.campaign = c; },
        saveLoreChunks: async (_id, chunks) => { rec.calls.push('saveLoreChunks'); rec.chunks = chunks; },
        saveNPCLedger: async (_id, npcs) => { rec.calls.push('saveNPCLedger'); rec.npcs = npcs; },
        saveCampaignState: async (_id, state) => { rec.calls.push('saveCampaignState'); rec.state = state; },
        hydrateCampaign: async () => { rec.calls.push('hydrateCampaign'); },
        uploadImageToLocal: async (_file, name) => { rec.calls.push(`upload:${name}`); return `/assets/portraits/${name}.png`; },
        downscaleCover: async () => { rec.calls.push('downscaleCover'); return 'data:image/jpeg;base64,COVER'; },
        makeId: () => 'camp-1',
        now: () => 1700000000000,
        ...over,
    };
    return rec;
}

function seededPlan(over: Partial<ImportChoices> = {}): ImportPlan {
    return buildImportPlan(seededTiles(), seededFiles(), choices(over), {
        matureMode: false, rng, makeId: makeIdFactory(),
    });
}

describe('createCampaignFromImport — write order (§10.3)', () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => { warn.mockRestore(); });

    it('writes campaign → portraits → lore → ledger → state → hydrate', async () => {
        const rec = recordingDeps();
        const result = await createCampaignFromImport(seededPlan(), rec.deps);

        expect(rec.calls).toEqual([
            'downscaleCover',
            'saveCampaign',
            'upload:Aria',
            'upload:Bram',
            'saveLoreChunks',
            'saveNPCLedger',
            'saveCampaignState',
            'hydrateCampaign',
        ]);
        expect(result.campaignId).toBe('camp-1');
        expect(result.portraitFailures).toEqual([]);
        expect(rec.campaign).toEqual({
            id: 'camp-1',
            name: 'Aria',
            coverImage: 'data:image/jpeg;base64,COVER',
            createdAt: 1700000000000,
            lastPlayedAt: 1700000000000,
        });
        expect(rec.npcs.map(n => n.portrait)).toEqual([
            '/assets/portraits/Aria.png',
            '/assets/portraits/Bram.png',
        ]);
        // Premise leads the lore; every roster chunk follows.
        expect(rec.chunks[0].header).toBe('Premise — Aria');
        expect(rec.chunks.length).toBeGreaterThan(1);
    });

    it('a failed portrait upload costs the portrait, not the import (§9.5)', async () => {
        const rec = recordingDeps({
            uploadImageToLocal: async (_file, name) => {
                if (name === 'Bram') throw new Error('asset server down');
                return `/assets/portraits/${name}.png`;
            },
        });
        const result = await createCampaignFromImport(seededPlan(), rec.deps);

        expect(result.portraitFailures).toEqual(['Bram']);
        const bram = rec.npcs.find(n => n.name === 'Bram');
        expect(bram).toBeDefined();
        expect(bram?.portrait).toBeUndefined();
        expect(rec.calls).toContain('hydrateCampaign');
    });

    it('a JSON-sourced card has no portrait to upload and is never a portrait failure', async () => {
        const files = new Map<string, File>([
            ['t-aria', pngFile('aria')],
            ['t-bram', new File(['{}'], 'bram.json', { type: 'application/json' })],
        ]);
        const plan = buildImportPlan(seededTiles(), files, choices(), { matureMode: false, rng, makeId: makeIdFactory() });
        expect(plan.roster.find(r => r.card.name === 'Bram')?.pngFile).toBeNull();

        const rec = recordingDeps({
            uploadImageToLocal: async (_file, name) => {
                if (name === 'Bram') throw new Error('Selected file is not an image');
                return `/assets/portraits/${name}.png`;
            },
        });
        const result = await createCampaignFromImport(plan, rec.deps);
        expect(rec.calls).not.toContain('upload:Bram');
        expect(result.portraitFailures).toEqual([]);
        expect(rec.npcs.find(n => n.name === 'Bram')?.portrait).toBeUndefined();
    });

    it('a failed cover downscale yields an empty cover, not a failed import', async () => {
        const rec = recordingDeps({
            downscaleCover: async () => { throw new Error('downscaleCover: no DOM available'); },
        });
        await createCampaignFromImport(seededPlan(), rec.deps);
        expect(rec.campaign?.coverImage).toBe('');
        expect(rec.calls).toContain('hydrateCampaign');
    });
});

describe('createCampaignFromImport — saved state', () => {
    it('seeded + build-own: one opening message, null PC, a seeded draft', async () => {
        const rec = recordingDeps();
        await createCampaignFromImport(seededPlan(), rec.deps);

        expect(rec.state?.messages).toHaveLength(1);
        expect(rec.state?.messages[0].role).toBe('assistant');
        expect(rec.state?.messages[0].content).toBe('Aria looks up as Kaito enters.');
        expect(rec.state?.context.playerCharacter).toBeNull();
        expect(rec.state?.context.creationDraft).toEqual({ name: 'Kaito', step: 0 });
        expect(rec.state?.context.characterProfileActive).toBe(false);
        expect(rec.state?.context.rulesRaw).toBe('');
        expect(rec.state?.condenser).toEqual({ condensedUpToIndex: -1 });
    });

    it('persona: the PC and its context patch land before hydration', async () => {
        const rec = recordingDeps();
        const plan = seededPlan({ who: { kind: 'persona', tileId: 't-bram' } });
        await createCampaignFromImport(plan, rec.deps);

        expect(rec.state?.context.playerCharacter?.name).toBe('Bram');
        expect(rec.state?.context.playerCharacter?.portrait).toBe('/assets/portraits/Bram.png');
        expect(rec.state?.context.characterProfileActive).toBe(true);
        expect(rec.state?.context.characterProfileData?.name).toBe('Bram');
        expect(rec.state?.context.characterProfile?.identity?.name).toBe('Bram');
        expect(rec.state?.context.creationDraft).toBeNull();
    });

    it('npcs-only: no opening message and no premise chunk', async () => {
        const plan = buildImportPlan(seededTiles(), seededFiles(), choices({ mode: 'npcs-only' }), {
            matureMode: false, rng, makeId: makeIdFactory(),
        });
        const rec = recordingDeps();
        await createCampaignFromImport(plan, rec.deps);

        expect(rec.state?.messages).toHaveLength(0);
        expect(rec.chunks.some(c => c.header.startsWith('Premise —'))).toBe(false);
        expect(rec.state?.context.playerCharacter).toBeNull();
        expect(rec.state?.context.creationDraft).toBeNull();
        expect(rec.calls).not.toContain('downscaleCover');
    });
});
