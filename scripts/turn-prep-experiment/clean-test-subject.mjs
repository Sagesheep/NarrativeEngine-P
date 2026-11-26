// Turn Prep Experiment — final cleanup of the long test-subject campaign (exp-c1-rebuilt).
// One-off and idempotent enough to re-run; every step reports what it changed.
//
//   node scripts/turn-prep-experiment/clean-test-subject.mjs
//
// Steps:
//   1. Normalize archive line endings to LF. Scenes 1–359 were CRLF; the server writes LF,
//      and updateSceneAssistant's [USER] regex only matches LF — on a CRLF scene an
//      edit-sync silently wipes the player's text.
//   2. Restore the GM prose of scenes whose archive copy is empty ("Scene #175 |") from the
//      chat log, through the app's own updateSceneAssistant, then re-derive witnesses from
//      the restored "👥" header.
//   3. Remove orphan index entries with no archive prose (scene 310), through deleteScene.
//   4. Merge duplicate NPC ledger entries into the entry the facts actually reference.
//   5. Strip non-character names (section headings, place names) from index name lists, and
//      add two unambiguous surname/short-name aliases.
//   6. Rename the campaign as the clean baseline test subject.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ID = 'exp-c1-rebuilt';
const DIR = path.join(ROOT, 'data/campaigns');
const file = (suffix) => path.join(DIR, `${ID}${suffix}`);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));

const { updateSceneAssistant, deleteScene } = await import('../../server/services/archiveService.js');

const headerNames = (text) => {
    const line = text.split('\n').find(l => l.includes('👥'));
    if (!line) return null;
    const names = [...line.slice(line.indexOf('👥')).matchAll(/\*\*([^*\]]+?)\*\*/g)]
        .map(m => m[1].trim()).filter(n => n && !n.endsWith(':'));
    return names.length ? [...new Set(names)] : null;
};

// ── 1. Line endings ──────────────────────────────────────────────────────────
{
    const md = fs.readFileSync(file('.archive.md'), 'utf8');
    const crlf = (md.match(/\r\n/g) || []).length;
    if (crlf) fs.writeFileSync(file('.archive.md'), md.replace(/\r\n/g, '\n'));
    console.log(`1. line endings: ${crlf} CRLF breaks normalized to LF`);
}

// ── 2. Restore empty GM prose from the chat log ─────────────────────────────
{
    const md = fs.readFileSync(file('.archive.md'), 'utf8');
    const emptyScenes = md.split(/^(?=## SCENE )/m)
        .filter(b => /^## SCENE \d+/.test(b))
        .filter(b => (b.split('**[GM]**')[1] || '').replace(/Scene #\d+\s*\|?/, '').replace(/-{3,}/g, '').trim().length < 50)
        .map(b => b.match(/^## SCENE (\d+)/)[1].padStart(3, '0'));
    const messages = readJson(file('.state.json')).messages;
    for (const sceneId of emptyScenes) {
        const msg = messages.find(m => m.role === 'assistant' && m.sceneId === sceneId && (m.content || '').trim().length > 200);
        if (!msg) { console.log(`2. scene ${sceneId}: empty in archive and no chat reply to restore from — left as is`); continue; }
        await updateSceneAssistant(ID, sceneId, msg.content);
        const index = readJson(file('.archive.index.json'));
        const entry = index.find(e => e.sceneId === sceneId);
        const names = headerNames(msg.content);
        if (entry && names) { entry.witnesses = names; entry.witnessSource = 'header'; }
        writeJson(file('.archive.index.json'), index);
        console.log(`2. scene ${sceneId}: restored ${msg.content.length} chars of GM prose from the chat log; witnesses ${JSON.stringify(names)}`);
    }
}

// ── 3. Orphan index entries (no prose in the archive) ───────────────────────
{
    const md = fs.readFileSync(file('.archive.md'), 'utf8');
    const prose = new Set([...md.matchAll(/^## SCENE (\d+)/gm)].map(m => m[1].padStart(3, '0')));
    const orphans = readJson(file('.archive.index.json')).filter(e => !prose.has(e.sceneId)).map(e => e.sceneId);
    for (const sceneId of orphans) {
        await deleteScene(ID, sceneId);
        console.log(`3. scene ${sceneId}: orphan index entry removed (no prose in the archive)`);
    }
    if (!orphans.length) console.log('3. no orphan index entries');
}

// ── 4. Merge duplicate NPC entries ──────────────────────────────────────────
{
    const MERGES = [
        { keep: 'mnwfk794qs2qx', drop: 'mo3zcrzi9juj6' }, // General Maren Duskbane ← Maren Duskbane
        { keep: 'mo21udll7fg3y', drop: 'mo21vymml5rbl' }, // Sergeant Vrell ← Vrell
        { keep: 'mo85ok1yy9ub9', drop: 'mo85p7dgko4cx' }, // Captain Ilsa Vren ← Ilsa Vren
    ];
    let npcs = readJson(file('.npcs.json'));
    const isEmpty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)
        || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
    for (const { keep, drop } of MERGES) {
        const k = npcs.find(n => n.id === keep);
        const d = npcs.find(n => n.id === drop);
        if (!k || !d) { console.log(`4. merge ${keep} ← ${drop}: already merged`); continue; }
        const aliases = new Set((k.aliases || '').split(',').map(a => a.trim()).filter(Boolean));
        for (const a of [d.name, ...(d.aliases || '').split(',').map(x => x.trim())]) {
            if (a && a.toLowerCase() !== k.name.toLowerCase()) aliases.add(a);
        }
        const filled = [];
        for (const [field, value] of Object.entries(d)) {
            if (['id', 'name', 'aliases'].includes(field)) continue;
            if (isEmpty(k[field]) && !isEmpty(value)) { k[field] = value; filled.push(field); }
        }
        k.aliases = [...aliases].join(', ');
        npcs = npcs.filter(n => n.id !== drop);
        // References to the dropped id anywhere in the campaign (verified zero before writing this).
        const stray = fs.readdirSync(DIR).filter(f => f.startsWith(`${ID}.`))
            .filter(f => fs.readFileSync(path.join(DIR, f), 'utf8').includes(drop) && !f.endsWith('.npcs.json'));
        console.log(`4. merged "${d.name}" into "${k.name}" — aliases: ${k.aliases}; filled: ${filled.join(', ') || 'nothing'}; stray refs: ${stray.join(', ') || 'none'}`);
    }
    writeJson(file('.npcs.json'), npcs);
}

// ── 5. Non-character names in index name lists; short-name aliases ──────────
{
    const NOT_CHARACTERS = new Set(['gate street', 'marken', 'essenhall', 'candlemaker row', 'vessenmark', 'cobb street',
        'hollowmire processing', 'of sovereign', 'sovereign intelligence update', 'houndmark']);
    const isHeading = (n) => !/[a-z]/.test(n) && /[A-Z]{2}/.test(n);
    const isNoise = (n) => isHeading(n) || NOT_CHARACTERS.has(n.toLowerCase());
    const index = readJson(file('.archive.index.json'));
    const removed = new Map();
    for (const e of index) {
        for (const field of ['npcsMentioned', 'witnesses']) {
            if (!Array.isArray(e[field])) continue;
            const kept = e[field].filter(n => !isNoise(n));
            for (const n of e[field].filter(isNoise)) removed.set(n, (removed.get(n) || 0) + 1);
            e[field] = kept;
        }
        if (e.npcStrengths) for (const n of Object.keys(e.npcStrengths)) if (isNoise(n)) delete e.npcStrengths[n];
    }
    writeJson(file('.archive.index.json'), index);
    console.log(`5. removed non-character names: ${[...removed].map(([n, c]) => `${n}(${c})`).join(' · ') || 'none'}`);

    const npcs = readJson(file('.npcs.json'));
    const taken = new Set(npcs.flatMap(n => [n.name, ...(n.aliases || '').split(',')].map(s => s.trim().toLowerCase())));
    for (const [name, alias] of [['Helena Broadmarsh', 'Broadmarsh'], ['Dessa Vool', 'Dessa']]) {
        const hits = npcs.filter(n => n.name === name);
        if (hits.length !== 1 || taken.has(alias.toLowerCase())) { console.log(`5. alias ${alias} → ${name}: skipped`); continue; }
        hits[0].aliases = hits[0].aliases ? `${hits[0].aliases}, ${alias}` : alias;
        console.log(`5. alias ${alias} → ${name}`);
    }
    writeJson(file('.npcs.json'), npcs);
}

// ── 6. Name the baseline ────────────────────────────────────────────────────
{
    const meta = readJson(file('.json'));
    meta.name = 'TEST — Spirit Card World (clean baseline)';
    writeJson(file('.json'), meta);
    console.log(`6. campaign renamed: ${meta.name}`);
}
