// Campaign copy. The clean-copy tests plant a marker in every place play writes
// and assert it appears nowhere in the copy, so "no trace of the player" is
// checked against the raw bytes rather than against a list of expected fields.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const SECRET = 'SECRETSTORYEVENT';
const SRC = 'source1';

let tmpDir;
let savedDataDir;
let request;
let CAMPAIGNS_DIR;
let copyCampaignEmbeddings;

const write = (suffix, value) => fs.writeFileSync(
    path.join(CAMPAIGNS_DIR, `${SRC}${suffix}`),
    typeof value === 'string' ? value : JSON.stringify(value),
);
const read = (id, suffix) => JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, `${id}${suffix}`), 'utf-8'));
const filesOf = (id) => fs.readdirSync(CAMPAIGNS_DIR).filter(f => f.startsWith(`${id}.`));
const bytesOf = (id) => filesOf(id).map(f => fs.readFileSync(path.join(CAMPAIGNS_DIR, f), 'utf-8')).join('\n');
const copy = (body) => request.post(`/api/campaigns/${SRC}/copy`).send(body);

function seedCampaign() {
    for (const f of fs.readdirSync(CAMPAIGNS_DIR)) fs.rmSync(path.join(CAMPAIGNS_DIR, f), { recursive: true, force: true });

    write('.json', { id: SRC, name: 'Cyberpunk 2076', coverImage: 'data:cover', createdAt: 1, lastPlayedAt: 2 });
    write('.state.json', {
        context: {
            loreRaw: 'Night City', rulesRaw: 'Roll d20', starter: 'You wake up.', worldVibe: 'neon',
            encounterEngineActive: false,
            diceSystem: { dieTypes: [], categories: [] },
            worldEventConfig: { initialDC: 300, dcReduction: 2 },
            worldEventDC: 12,
            promptInjections: [{ id: 'p1', content: 'be terse' }],
            notebook: [{ id: 'n1', text: SECRET }],
            sceneNote: SECRET, headerIndex: SECRET, inventory: SECRET, agencyDigest: SECRET,
            inventoryItems: [{ id: 'i1', name: SECRET }],
            characterProfile: { identity: { name: SECRET }, activeTraits: [] },
            worldDay: 135, currentPlaceId: 'loc_visited',
            playerCharacter: {
                id: 'pc', name: 'Vex', personality: 'wry', storyRelevance: 'Ex-corpo on the run', pcRelation: 2,
                lastUpdateScene: 9, signatureKit: { equipment: [SECRET], abilities: [] },
                wants: { short: ['eat'], medium: [SECRET], long: SECRET },
            },
        },
        messages: [
            { id: 'm1', content: SECRET, attachments: [{ url: `/assets/campaigns/${SRC}/scene-images/a.png` }] },
        ],
        condenser: { condensedUpToIndex: 4, condensedSummary: SECRET },
        pinnedExcerpts: [{ id: 'x', text: SECRET }],
    });
    write('.lore.json', [{ id: 'l1', content: 'Rita runs the Afterlife bar in Night City.' }]);
    write('.npcs.json', [
        {
            id: 'authored', name: 'Rita', tier: 'recurring', status: 'Dead', condition: 'critical',
            storyRelevance: 'Rita runs the Afterlife bar',
            personality: `Bitter since ${SECRET}`, previousSnapshot: { personality: 'Warm', voice: 'soft' },
            pcRelation: 3, relationMeter: 8, shiftNote: SECRET, lastUpdateScene: 40, pressure: { note: SECRET },
            goalRecords: [{ text: SECRET }], wants: { short: ['eat'], medium: ['find Vex'], long: 'kill Vex' },
        },
        {
            id: 'rewritten', name: 'Jax', tier: 'recurring', personality: 'loud', storyRelevance: `Saw ${SECRET}`,
            affinity: 90, goals: `Avenge ${SECRET}`, drives: { coreWant: SECRET },
        },
        { id: 'walkon', name: 'Passerby', tier: 'walkon', personality: 'none', storyRelevance: '' },
        { id: 'legacy-pc', name: 'Old Vex', isPC: true, personality: 'wry', shiftNote: SECRET },
    ]);
    write('.locations.json', [
        {
            id: 'loc_authored', name: 'Afterlife', source: 'manual', knowledge: 'visited', status: SECRET,
            knowledgeNote: SECRET, firstSeenScene: '12', lastSeenScene: '40', coordinates: { x: 1, y: 2 },
            connections: [{ toId: 'loc_llm', band: 'local' }, { toId: 'loc_other', band: 'far' }],
        },
        { id: 'loc_other', name: 'Docks', source: 'manual', connections: [] },
        { id: 'loc_llm', name: `${SECRET} alley`, source: 'llm', connections: [] },
        { id: 'loc_route', name: `${SECRET} road`, source: 'manual', recordKind: 'route', kind: 'transit', connections: [] },
        { id: 'point-abc-1-2', name: `${SECRET} point`, source: 'manual', recordKind: 'position', connections: [] },
        { id: 'site-abc-1-2', name: `${SECRET} site`, source: 'manual', recordKind: 'place', connections: [] },
    ]);
    write('.archive.md', `## SCENE 001\n${SECRET}\n/assets/campaigns/${SRC}/scene-images/a.png`);
    write('.archive.index.json', [{ sceneId: '001', summary: SECRET }]);
    write('.archive.chapters.json', [{ id: 'c1', title: SECRET }]);
    write('.timeline.json', [{ id: 't', text: SECRET }]);
    write('.entities.json', [{ id: 'e', name: SECRET }]);
    write('.facts.json', [{ id: 'f', text: SECRET }]);
    write('.divergence.json', { entries: [{ text: SECRET }] });
    write('.relationship-memory.npc-to-mc.json', [{ text: SECRET }]);
    write('.relationship-memory.npc-to-npc.json', [{ text: SECRET }]);
    write('.enemies.json', [{ id: 'goon', name: 'Goon' }]);
    write('.enemy-instances.json', [{ id: 'g1', note: SECRET }]);
    write('.mod-keeper-settings.json', { theme: 'dark' });
    write('.mod-keeper-history.json', [{ text: SECRET }]);
    write('.mod-unknown-log.json', [{ text: SECRET }]);

    const images = path.join(CAMPAIGNS_DIR, SRC, 'scene-images');
    fs.mkdirSync(images, { recursive: true });
    fs.writeFileSync(path.join(images, 'a.png'), 'png-bytes');
}

beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-campaign-copy-'));
    savedDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tmpDir;
    vi.resetModules();

    ({ CAMPAIGNS_DIR } = await import('../lib/fileStore.js'));
    fs.mkdirSync(CAMPAIGNS_DIR, { recursive: true });
    const { initDb, getDb } = await import('../lib/vectorStore.js');
    ({ copyCampaignEmbeddings } = await import('../lib/vectorStore.js'));
    initDb();
    globalThis.__copyTestDb = getDb;

    const { serverTableRegistry } = await import('../lib/tableRegistry.js');
    serverTableRegistry.register({ name: 'mod.keeper.settings', fileSuffix: '.mod-keeper-settings.json', recordShape: 'single-object', keepOnCleanCopy: true });
    serverTableRegistry.register({ name: 'mod.keeper.history', fileSuffix: '.mod-keeper-history.json', recordShape: 'array' });

    const { createCampaignsRouter } = await import('../routes/campaigns.js');
    const app = express();
    app.use(express.json());
    app.use(createCampaignsRouter());
    request = supertest(app);
});

beforeEach(seedCampaign);

afterAll(() => {
    process.env.DATA_DIR = savedDataDir;
    try { globalThis.__copyTestDb?.()?.close(); } catch { /* best effort */ }
    delete globalThis.__copyTestDb;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('POST /api/campaigns/:id/copy', () => {
    it('rejects an unknown mode and a missing campaign', async () => {
        expect((await copy({ mode: 'nope' })).status).toBe(400);
        expect((await request.post('/api/campaigns/missing/copy').send({ mode: 'full' })).status).toBe(404);
    });

    it('never changes the source', async () => {
        const before = bytesOf(SRC);
        await copy({ mode: 'full' });
        await copy({ mode: 'clean', keepNpcs: true, keepCharacter: true });
        expect(bytesOf(SRC)).toBe(before);
    });

    it('names copies uniquely and under a new id', async () => {
        const first = await copy({ mode: 'clean' });
        const second = await copy({ mode: 'clean' });
        expect(first.body.name).toBe('Cyberpunk 2076 (Fresh)');
        expect(second.body.name).toBe('Cyberpunk 2076 (Fresh) 2');
        expect(first.body.id).not.toBe(SRC);
        expect(first.body.id).not.toBe(second.body.id);
        expect(first.body.coverImage).toBe('data:cover');
    });
});

describe('full copy', () => {
    it('carries every file, including tables of mods the registry does not know', async () => {
        const { body } = await copy({ mode: 'full' });
        const suffixes = (id) => filesOf(id).map(f => f.slice(id.length)).sort();
        expect(suffixes(body.id)).toEqual(suffixes(SRC));
    });

    it('moves scene images and the URLs that point at them to the new id', async () => {
        const { body } = await copy({ mode: 'full' });
        const url = `/assets/campaigns/${body.id}/scene-images/a.png`;
        expect(read(body.id, '.state.json').messages[0].attachments[0].url).toBe(url);
        expect(bytesOf(body.id)).not.toContain(`/assets/campaigns/${SRC}/`);
        expect(fs.existsSync(path.join(CAMPAIGNS_DIR, body.id, 'scene-images', 'a.png'))).toBe(true);
    });
});

describe('clean copy', () => {
    it.each([
        [{ keepNpcs: true, keepCharacter: true }],
        [{ keepNpcs: true, keepCharacter: false }],
        [{ keepNpcs: false, keepCharacter: false }],
    ])('leaves no trace of play with %j', async (options) => {
        const { body } = await copy({ mode: 'clean', ...options });
        expect(bytesOf(body.id)).not.toContain(SECRET);
    });

    it('drops the story files and scene images entirely', async () => {
        const { body } = await copy({ mode: 'clean' });
        for (const suffix of [
            '.archive.md', '.archive.index.json', '.archive.chapters.json', '.timeline.json', '.entities.json',
            '.facts.json', '.divergence.json', '.relationship-memory.npc-to-mc.json',
            '.relationship-memory.npc-to-npc.json', '.enemy-instances.json',
        ]) {
            expect(filesOf(body.id)).not.toContain(`${body.id}${suffix}`);
        }
        expect(fs.existsSync(path.join(CAMPAIGNS_DIR, body.id))).toBe(false);
    });

    it('keeps world, rules and engine setup, and resets the clock', async () => {
        const { body } = await copy({ mode: 'clean' });
        const state = read(body.id, '.state.json');
        expect(state.messages).toEqual([]);
        expect(state.pinnedExcerpts).toEqual([]);
        expect(state.condenser).toEqual({ condensedUpToIndex: -1 });
        expect(state.context).toMatchObject({
            loreRaw: 'Night City', rulesRaw: 'Roll d20', starter: 'You wake up.', worldVibe: 'neon',
            encounterEngineActive: false, worldEventDC: 300,
            promptInjections: [{ id: 'p1', content: 'be terse' }],
        });
        expect(state.context.worldDay).toBeUndefined();
        expect(state.context.currentPlaceId).toBeUndefined();
        expect(read(body.id, '.lore.json')).toHaveLength(1);
    });

    it('keeps mod tables only when they are declared as setup', async () => {
        const { body } = await copy({ mode: 'clean' });
        const files = filesOf(body.id);
        expect(files).toContain(`${body.id}.mod-keeper-settings.json`);
        expect(files).not.toContain(`${body.id}.mod-keeper-history.json`);
        expect(files).not.toContain(`${body.id}.mod-unknown-log.json`);
        expect(files).toContain(`${body.id}.enemies.json`);
    });

    it('resets kept NPCs and keeps only authored text', async () => {
        const { body } = await copy({ mode: 'clean', keepNpcs: true });
        const npcs = read(body.id, '.npcs.json');
        expect(npcs.map(n => n.id)).toEqual(['authored', 'rewritten']);
        const rita = npcs[0];
        expect(rita).toMatchObject({
            status: 'Alive', condition: 'healthy', pcRelation: 0,
            personality: 'Warm', voice: 'soft', storyRelevance: 'Rita runs the Afterlife bar',
        });
        for (const field of ['relationMeter', 'previousSnapshot', 'shiftNote', 'lastUpdateScene', 'pressure', 'goalRecords']) {
            expect(rita[field]).toBeUndefined();
        }
        expect(rita.wants).toEqual({ short: ['eat'], medium: [], long: '' });
        expect(npcs[1].storyRelevance).toBe('');
        // Each of these would be folded back into a live field on first open.
        for (const field of ['affinity', 'goals', 'drives']) expect(npcs[1][field]).toBeUndefined();
    });

    it('drops all NPCs when asked', async () => {
        const { body } = await copy({ mode: 'clean', keepNpcs: false });
        expect(filesOf(body.id)).not.toContain(`${body.id}.npcs.json`);
    });

    it('asks for a new character by default and resets a kept one', async () => {
        const gone = await copy({ mode: 'clean' });
        expect(read(gone.body.id, '.state.json').context.playerCharacter).toBeUndefined();
        expect(read(gone.body.id, '.npcs.json').some(n => n.isPC)).toBe(false);

        const kept = await copy({ mode: 'clean', keepCharacter: true });
        expect(read(kept.body.id, '.state.json').context.playerCharacter).toMatchObject({
            name: 'Vex', personality: 'wry', storyRelevance: 'Ex-corpo on the run', pcRelation: 0,
            wants: { short: ['eat'], medium: [], long: '' },
        });
        expect(read(kept.body.id, '.state.json').context.playerCharacter.signatureKit).toBeUndefined();
    });

    it('keeps authored places, unvisited, with connections only between kept places', async () => {
        const { body } = await copy({ mode: 'clean' });
        const places = read(body.id, '.locations.json');
        expect(places.map(p => p.id)).toEqual(['loc_authored', 'loc_other']);
        expect(places[0]).toMatchObject({
            knowledge: 'known', firstSeenScene: '', lastSeenScene: '', coordinates: { x: 1, y: 2 },
            connections: [{ toId: 'loc_other', band: 'far' }],
        });
        expect(places[0].status).toBeUndefined();
    });
});

describe('copyCampaignEmbeddings', () => {
    const vector = () => new Float32Array(globalThis.__copyTestDims).fill(0.5);

    it('copies only the requested item types and keeps their versions', async () => {
        const db = globalThis.__copyTestDb();
        expect(db).toBeTruthy();
        const { storeArchiveEmbedding, storeLoreEmbedding } = await import('../lib/vectorStore.js');
        const dims = Number(/FLOAT\[(\d+)\]/i.exec(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'lore_vss'").get().sql)[1]);
        globalThis.__copyTestDims = dims;
        storeLoreEmbedding('emb-src', 'l1', vector());
        storeArchiveEmbedding('emb-src', '001', [vector(), vector()]);

        copyCampaignEmbeddings('emb-src', 'emb-clean', ['lore', 'rule']);
        copyCampaignEmbeddings('emb-src', 'emb-full', ['scene', 'lore', 'rule']);

        const count = (table, id) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE campaign_id = ?`).get(id).n;
        expect(count('lore_vss', 'emb-clean')).toBe(1);
        expect(count('archive_vss', 'emb-clean')).toBe(0);
        expect(count('lore_vss', 'emb-full')).toBe(1);
        expect(count('archive_vss', 'emb-full')).toBe(2);
        const meta = db.prepare('SELECT item_type FROM embedding_meta WHERE campaign_id = ?').all('emb-clean');
        expect(meta.map(m => m.item_type)).toEqual(['lore']);
    });
});
