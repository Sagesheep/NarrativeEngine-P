// Turn Prep Experiment — what does meaning search return for each probe?
//
//   node scripts/turn-prep-experiment/retrieval-check.mjs old   → the pre-2026-10-03 scheme, rebuilt in memory:
//                                                                 one vector per scene from names + keywords +
//                                                                 120 chars of the player's message; plain query
//   node scripts/turn-prep-experiment/retrieval-check.mjs new   → data/embeddings.db as stored now (prose passages,
//                                                                 nearest passage per scene); query with the
//                                                                 retrieval instruction
//
// Prints each probe's top 10 and where the criteria's scene numbers rank. The criteria
// numbers are NOT a complete relevance set (P6's frame-up is 113–119, its criteria cite
// 446–448), so judge the top 10s by reading them (describe-scenes.mjs).
// Run while the app server is stopped (it loads the embedding model itself).

import fs from 'fs';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const mode = process.argv[2];
if (!['old', 'new', 'hybrid-old', 'hybrid-cast'].includes(mode)) { console.error('usage: retrieval-check.mjs old|new|hybrid-old|hybrid-cast'); process.exit(2); }
// hybrid-*: the stored passages plus one card vector per scene, built in memory, each scene
// ranked by its best row; query with the retrieval instruction.
//   hybrid-old  — card = the old scheme's text (names + keywords + 120 chars of the player's message)
//   hybrid-cast — card = the names only (witnesses + mentioned NPCs)
const { embedText, embedQuery, embedBatch, warmup } = await import('../../server/lib/embedder.js');

const PROBES = [
    ['P2', 'exp-c1-rebuilt', 'I open the letter from the Soll household.', ['533', '534', '568']],
    ['P3', 'exp-c1-rebuilt', 'I tell Rin: "Therese is going to want what we promised her back at the Soll study."', ['533', '534']],
    ['P5', 'exp-c1-rebuilt', 'On the way back from the market I spot Helena Broadmarsh across the square. I walk over.', ['144', '145', '235', '282', '435', '436']],
    ['P6', 'exp-c1-rebuilt', 'I remind Rin how we pinned everything on Pell with that forged IOU, back in Marken.', ['446', '447', '448']],
    ['P10', 'exp-c2', 'I ask Zhang Fei how far it is to the next village.', ['046']],
    ['P11', 'exp-c2', 'Further down the road a column of conscripts is being marched toward Ye. I look over their faces.', ['018', '019']],
    ['P12', 'exp-c2', 'I tell Zhang Fei about the boy at Huang Ridge whose brother was taken toward Ye.', ['021']],
    ['P13', 'exp-c2', 'I ask the scout what his general actually knows about me.', ['034', '040', '046', '047']],
    ['P14', 'exp-c2', "I ask Zhang Fei if he thinks that woman's husband is still stuck at the northern garrison.", ['039']],
];

// The scheme scenes were embedded with before 2026-10-03 (server/lib/embedder.js buildArchiveText).
const oldSceneText = (e) => [
    e.witnesses?.length ? e.witnesses.join(' ') : '',
    e.npcsMentioned?.length ? e.npcsMentioned.join(' ') : '',
    e.keywords?.length ? e.keywords.join(' ') : '',
    e.userSnippet ?? '',
].filter(Boolean).join(' ').slice(0, 500);
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

await warmup();
let rank;
if (mode === 'old') {
    const vectors = new Map();
    for (const campaign of new Set(PROBES.map(p => p[1]))) {
        const index = JSON.parse(fs.readFileSync(`data/campaigns/${campaign}.archive.index.json`, 'utf8'));
        const vecs = await embedBatch(index.map(oldSceneText), 16, 0);
        vectors.set(campaign, index.map((e, i) => [e.sceneId, vecs[i]]));
    }
    rank = async (campaign, query) => {
        const q = await embedText(query);
        return vectors.get(campaign).map(([id, v]) => [id, dot(q, v)]).sort((a, b) => b[1] - a[1]).map(([id]) => id);
    };
} else if (mode.startsWith('hybrid')) {
    const db = new Database('data/embeddings.db', { readonly: true, fileMustExist: true });
    sqliteVec.load(db);
    const castText = (e) => [...new Set([...(e.witnesses ?? []), ...(e.npcsMentioned ?? [])])].join(', ');
    const rows = new Map();
    for (const campaign of new Set(PROBES.map(p => p[1]))) {
        const list = db.prepare('SELECT scene_id, embedding FROM archive_vss WHERE campaign_id = ?').all(campaign)
            .map(r => [r.scene_id, new Float32Array(new Uint8Array(r.embedding).buffer)]);
        const index = JSON.parse(fs.readFileSync(`data/campaigns/${campaign}.archive.index.json`, 'utf8'));
        const cards = index.map(mode === 'hybrid-old' ? oldSceneText : castText);
        const cardVecs = await embedBatch(cards, 16, 0);
        index.forEach((e, i) => { if (cards[i]) list.push([e.sceneId, cardVecs[i]]); });
        rows.set(campaign, list);
    }
    rank = async (campaign, query) => {
        const q = await embedQuery(query);
        const best = new Map();
        for (const [id, v] of rows.get(campaign)) best.set(id, Math.max(best.get(id) ?? -1, dot(q, v)));
        return [...best].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    };
} else {
    const db = new Database('data/embeddings.db', { readonly: true, fileMustExist: true });
    sqliteVec.load(db);
    const knn = db.prepare('SELECT scene_id FROM archive_vss WHERE embedding MATCH ? AND campaign_id = ? ORDER BY distance LIMIT ?');
    rank = async (campaign, query) => {
        const ranked = [];
        for (const r of knn.all(await embedQuery(query), campaign, 1000)) if (!ranked.includes(r.scene_id)) ranked.push(r.scene_id);
        return ranked;
    };
}

for (const [probe, campaign, query, cited] of PROBES) {
    const ranked = await rank(campaign, query);
    const ranks = cited.map(t => { const i = ranked.indexOf(t); return i < 0 ? '-' : String(i + 1); });
    console.log(`${probe.padEnd(4)} top10 ${ranked.slice(0, 10).join(',')}   cited ${cited.map((t, i) => `${t}:${ranks[i]}`).join(' ')}`);
}
