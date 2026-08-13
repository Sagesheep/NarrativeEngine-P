// WO-3.5 §6 — seed fixture for the 3.9 checkpoint.
//
// Dev tooling only. Takes a campaign id, writes three NPC→MC relationship-memory edges into
// that campaign's file store, and prints what it wrote. Ships nothing, adds no app surface.
//
// The three edges in one load produce every case the 3.9 checkpoint asks for:
//   dense    — deep tier, warm-history-in-hostile-room, the inverse, strain range
//   sparse   — the thin-history NPC (the fabrication check)
//   middling — the ensemble scene, tier boundary
//
// Usage:  node scripts/seed-relationship-memory.mjs <campaignId>
//         DATA_DIR=/path node scripts/seed-relationship-memory.mjs <campaignId>

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || join(PROJECT_ROOT, 'data');
const CAMPAIGNS_DIR = join(DATA_DIR, 'campaigns');

const campaignId = process.argv[2];
if (!campaignId) {
    console.error('Usage: node scripts/seed-relationship-memory.mjs <campaignId>');
    process.exit(1);
}

const targetFile = join(CAMPAIGNS_DIR, `${campaignId}.relationship-memory.npc-to-mc.json`);

let existing = [];
if (existsSync(targetFile)) {
    try {
        const parsed = JSON.parse(readFileSync(targetFile, 'utf8'));
        if (Array.isArray(parsed)) existing = parsed;
    } catch {
        console.warn(`[seed] Existing file at ${targetFile} was not valid JSON; overwriting.`);
    }
}

// NPC ids used by the fixture. These must match NPCs present in the campaign ledger for the
// 3.9 checkpoint to surface them. The script does not create ledger entries — it only seeds
// memory, which is the dependency that was circular.
const DENSE_NPC = 'edelgard';
const SPARSE_NPC = 'innkeeper';
const MIDDLING_NPC = 'linhardt';

let sceneCounter = 0;
const nextSceneId = () => String(++sceneCounter).padStart(3, '0');

function record(subject, mood, impact, event, outcome, extra = {}) {
    return {
        sceneId: nextSceneId(),
        subject,
        target: 'MC',
        mood,
        impact,
        event,
        outcome,
        source: 'recorded',
        ...extra,
    };
}

// ─── DENSE: ~40 records. One carried with note, six formative split across both valences,
//     the rest passing/remembered. Scene numbers spread 010–380. At least one grave and one
//     logistical. Realistic event/outcome pairs — the fixture is read by a model. ───
const dense = [];
sceneCounter = 9;
dense.push(record(DENSE_NPC, 'tender', 'carried', 'put a hand on her head', 'went red and said nothing', { carriedNote: 'that he chose which of her students lived' }));
dense.push(record(DENSE_NPC, 'tender', 'carried', 'spared some of her students, killed others', 'asked him to be quick', { carriedNote: 'that he chose which of her students lived' }));
sceneCounter = 14;
dense.push(record(DENSE_NPC, 'tender', 'formative', 'walked her back to the dormitory in the rain', 'let him, said nothing'));
dense.push(record(DENSE_NPC, 'companionable', 'formative', 'shared his lunch with her on the roof', 'laughed for the first time in weeks'));
dense.push(record(DENSE_NPC, 'tender', 'formative', 'caught her wrist before she fell from the wall', 'held on too long, then let go'));
sceneCounter = 41;
dense.push(record(DENSE_NPC, 'hostile', 'formative', 'blocked her from leaving the council chamber', 'turned her shoulder into his arm'));
dense.push(record(DENSE_NPC, 'hostile', 'formative', 'named her father a traitor in open court', 'did not deny it'));
dense.push(record(DENSE_NPC, 'humbling', 'formative', 'knelt to pick up the papers she had thrown', 'watched his hands and said nothing'));
sceneCounter = 78;
dense.push(record(DENSE_NPC, 'tender', 'formative', 'covered for her absence to the provost', 'thanked him in a whisper'));
dense.push(record(DENSE_NPC, 'hostile', 'formative', 'refused to endorse her plan in front of the generals', 'left the room first'));
dense.push(record(DENSE_NPC, 'fraught', 'formative', 'stood between her and the door without speaking', 'stepped around him'));
sceneCounter = 120;
for (let i = 0; i < 6; i++) {
    dense.push(record(DENSE_NPC, 'companionable', 'passing', `passed her the ${['bread', 'ink', 'map', 'report', 'canteen', 'lantern'][i]}`, 'took it without looking up'));
}
sceneCounter = 158;
for (let i = 0; i < 5; i++) {
    dense.push(record(DENSE_NPC, 'logistical', 'passing', `signed the ${['roster', 'requisition', 'dispatch', 'leave-order', 'supply-tally'][i]}`, 'countersigned and moved on'));
}
sceneCounter = 201;
for (let i = 0; i < 4; i++) {
    dense.push(record(DENSE_NPC, 'hostile', 'remembered', `cut her off mid-sentence in front of the ${['staff', 'alliance', 'emissary', 'command'][i]}`, 'finished her sentence anyway'));
}
sceneCounter = 240;
for (let i = 0; i < 3; i++) {
    dense.push(record(DENSE_NPC, 'tender', 'remembered', `left a ${['flower', 'note', 'book'][i]} on her desk`, 'did not mention it'));
}
sceneCounter = 290;
dense.push(record(DENSE_NPC, 'hostile', 'carried', 'beat her in front of her officers', 'stayed on her feet', { carriedNote: 'that he broke her in front of them' }));
dense.push(record(DENSE_NPC, 'hostile', 'carried', 'imprisoned her rather than execute her', 'asked him to be quick', { carriedNote: 'that he broke her in front of them' }));
sceneCounter = 310;
dense.push(record(DENSE_NPC, 'grave', 'remembered', 'stood vigil beside her dying second', 'let him stay'));
dense.push(record(DENSE_NPC, 'grave', 'formative', 'carried the body out himself so she would not have to', 'followed him to the door'));
sceneCounter = 350;
for (let i = 0; i < 2; i++) {
    dense.push(record(DENSE_NPC, 'fraught', 'passing', `sat across from her in the cell without speaking`, 'did not look up'));
}
dense.push(record(DENSE_NPC, 'companionable', 'passing', 'offered her the last of the water', 'took it'));
dense.push(record(DENSE_NPC, 'tender', 'remembered', 'called her by her name instead of her title', 'did not correct him'));
dense.push(record(DENSE_NPC, 'companionable', 'passing', 'lent her his cloak during the vigil', 'gave it back at dawn'));
dense.push(record(DENSE_NPC, 'logistical', 'passing', 'counted the rations with her in silence', 'agreed on the number'));

// ─── SPARSE: 3 records, all passing, one valence. The fabrication check. ───
sceneCounter = 100;
const sparse = [
    record(SPARSE_NPC, 'companionable', 'passing', 'rented her the upstairs room', 'paid in coin'),
    record(SPARSE_NPC, 'logistical', 'passing', 'sold her a meal and two torches', 'ate at the bar'),
    record(SPARSE_NPC, 'companionable', 'passing', 'pointed her toward the north road', 'nodded and left'),
];

// ─── MIDDLING: ~12 records, one clash. The ensemble scene, tier boundary. ───
sceneCounter = 50;
const middling = [];
middling.push(record(MIDDLING_NPC, 'companionable', 'passing', 'lent her a book on tactics', 'returned it a week late'));
middling.push(record(MIDDLING_NPC, 'companionable', 'passing', 'dozed off during her briefing', 'let him sleep'));
middling.push(record(MIDDLING_NPC, 'companionable', 'passing', 'shared his notes from the lecture', 'copied them without asking'));
middling.push(record(MIDDLING_NPC, 'companionable', 'remembered', 'stayed up with her before the exam', 'fell asleep on his notes'));
middling.push(record(MIDDLING_NPC, 'tender', 'formative', 'told her she was better than her father', 'left the room without answering'));
middling.push(record(MIDDLING_NPC, 'companionable', 'passing', 'brought her tea during the siege', 'drank it'));
middling.push(record(MIDDLING_NPC, 'logistical', 'passing', 'filed the after-action report for her', 'signed it unread'));
middling.push(record(MIDDLING_NPC, 'fraught', 'passing', 'caught her reading his correspondence', 'did not mention it'));
middling.push(record(MIDDLING_NPC, 'hostile', 'formative', 'reported her absence to the provost', 'did not speak to him for a week'));
middling.push(record(MIDDLING_NPC, 'companionable', 'passing', 'offered to swap patrols with her', 'declined'));
middling.push(record(MIDDLING_NPC, 'companionable', 'passing', 'mended the strap on her pack', 'used it without comment'));
middling.push(record(MIDDLING_NPC, 'companionable', 'passing', 'left his ration on her bunk', 'ate it'));

const fresh = [...dense, ...sparse, ...middling];

// Merge with existing: dedupe by sceneId|subject|target.
const key = (r) => r.sceneId + '|' + r.subject + '|' + r.target;
const existingKeys = new Set(existing.map(key));
const merged = [...existing, ...fresh.filter(r => !existingKeys.has(key(r)))];

if (!existsSync(CAMPAIGNS_DIR)) mkdirSync(CAMPAIGNS_DIR, { recursive: true });
if (!existsSync(dirname(targetFile))) mkdirSync(dirname(targetFile), { recursive: true });

writeFileSync(targetFile, JSON.stringify(merged, null, 2));

console.log(`\n=== Relationship memory seed complete ===`);
console.log(`Campaign:        ${campaignId}`);
console.log(`Target file:     ${targetFile}`);
console.log(`Existing records: ${existing.length}`);
console.log(`Seeded records:  ${fresh.length}`);
console.log(`  dense (${DENSE_NPC}):    ${dense.length}`);
console.log(`  sparse (${SPARSE_NPC}):   ${sparse.length}`);
console.log(`  middling (${MIDDLING_NPC}): ${middling.length}`);
console.log(`Total on disk:   ${merged.length}`);

console.log(`\n--- Edges ---`);
for (const subject of [DENSE_NPC, SPARSE_NPC, MIDDLING_NPC]) {
    const records = merged.filter(r => r.subject === subject);
    const clashes = records.filter(r => r.impact === 'formative' || r.impact === 'carried');
    const warm = records.filter(r => ['tender', 'companionable', 'triumphant'].includes(r.mood)).length;
    const hostile = records.filter(r => ['hostile', 'humbling', 'fraught'].includes(r.mood)).length;
    const neutral = records.filter(r => ['grave', 'logistical'].includes(r.mood)).length;
    const carried = records.filter(r => r.impact === 'carried').length;
    console.log(`  ${subject.padEnd(12)} ${String(records.length).padStart(3)} records · warm ${warm} · hostile ${hostile} · neutral ${neutral} · pins ${clashes.length} · carried ${carried}`);
}

console.log(`\nDone.`);