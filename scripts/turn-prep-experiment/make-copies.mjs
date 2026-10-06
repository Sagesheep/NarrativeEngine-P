// Turn Prep Experiment — P0 campaign copies (Upgrade/Turn-Prep-Experiment/SPEC.md §4, §6).
//
// Creates copies so the originals are never touched:
//   exp-c1-raw      — Spirit Card World, identical data, tail cleaned
//   exp-c1-rebuilt  — tail cleaned, Established Facts emptied, witness lists
//                     re-derived from each scene's "👥" presence header
//   exp-c2          — Three Kingdoms, identical data, tail cleaned
// The rebuilt copy is then re-sealed chapter by chapter via seal-harness.
//
// Usage: node scripts/turn-prep-experiment/make-copies.mjs [--force=<copy id>]
// Existing copies are skipped. Never --force=exp-c1-rebuilt: it is the cleaned test subject.

import fs from 'fs';
import path from 'path';

const C1 = { src: 'mnwf9obfkz6rk', tailScene: '576', input: 'I let Rin get the door.' };
const C2 = { src: 'mru5cz53qojl0', tailScene: '047', input: 'I keep quiet and let Zhang Fei deal with the scout.' };
const DIR = path.resolve('data/campaigns');
const COPIES = [
    { id: 'exp-c1-raw', name: 'EXP C1 raw — Spirit Card World', rebuild: false, ...C1 },
    { id: 'exp-c1-rebuilt', name: 'EXP C1 rebuilt — Spirit Card World', rebuild: true, ...C1 },
    { id: 'exp-c2', name: 'EXP C2 — Three Kingdoms', rebuild: false, ...C2 },
];
const STRAY_PREFIX = 'checkpoint 6.9.4';
const force = new Set(process.argv.filter(a => a.startsWith('--force=')).map(a => a.slice('--force='.length)));

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const write = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));

function copyFiles(srcId, dstId) {
    const files = fs.readdirSync(DIR).filter(f => f.startsWith(srcId + '.'));
    for (const f of files) {
        fs.copyFileSync(path.join(DIR, f), path.join(DIR, dstId + f.slice(srcId.length)));
    }
    return files.length;
}

/** Drops stray checkpoint messages and replaces the last scene's `test` input. */
function cleanTail(id, tailScene, replacement) {
    const statePath = path.join(DIR, `${id}.state.json`);
    const state = read(statePath);
    const before = state.messages.length;
    state.messages = state.messages.filter(m => !(m.role === 'user' && (m.content || '').startsWith(STRAY_PREFIX)));
    const lastGm = state.messages.map(m => m.role).lastIndexOf('assistant');
    const input = state.messages[lastGm - 1];
    if (input?.role === 'user' && input.content.trim() === 'test') input.content = replacement;
    write(statePath, state);

    const mdPath = path.join(DIR, `${id}.archive.md`);
    const md = fs.readFileSync(mdPath, 'utf8');
    const userTest = new RegExp(`(## SCENE ${tailScene}\\s*\\n[^\\n]*\\n\\n\\*\\*\\[USER\\]\\*\\*\\n)test\\n`);
    const fixed = md.replace(userTest, `$1${replacement}\n`);
    fs.writeFileSync(mdPath, fixed);

    const idxPath = path.join(DIR, `${id}.archive.index.json`);
    const idx = read(idxPath);
    const last = idx.find(e => e.sceneId === tailScene);
    if (last && last.userSnippet?.trim() === 'test') last.userSnippet = replacement;
    write(idxPath, idx);

    return { removed: before - state.messages.length, archiveFixed: fixed !== md };
}

/** Names from the first "👥" line of a scene, e.g. `👥 [**Pell**] (bound), [**Rin**]`. */
function headerNames(block) {
    const line = block.split('\n').find(l => l.includes('👥'));
    if (!line) return null;
    const names = [...line.slice(line.indexOf('👥')).matchAll(/\*\*([^*\]]+?)\*\*/g)]
        .map(m => m[1].trim())
        .filter(n => n && !n.endsWith(':'));
    return names.length ? [...new Set(names)] : null;
}

function rebuildWitnesses(id) {
    const md = fs.readFileSync(path.join(DIR, `${id}.archive.md`), 'utf8');
    const byScene = new Map();
    for (const block of md.split(/^(?=## SCENE )/m)) {
        const m = block.match(/^## SCENE (\d+)/);
        if (m) byScene.set(m[1].padStart(3, '0'), headerNames(block));
    }
    const idxPath = path.join(DIR, `${id}.archive.index.json`);
    const idx = read(idxPath);
    let fromHeader = 0, kept = 0;
    for (const e of idx) {
        const names = byScene.get(e.sceneId);
        if (names) { e.witnesses = names; e.witnessSource = 'header'; fromHeader++; } else kept++;
    }
    write(idxPath, idx);
    return { fromHeader, kept };
}

function emptyRegister(id) {
    const p = path.join(DIR, `${id}.divergence.json`);
    const reg = read(p);
    const dropped = reg.entries.length;
    write(p, { ...reg, entries: [], chapterToggles: {}, categoryToggles: {}, prunedLog: [], lastUpdatedSceneId: '', lastUpdatedAt: Date.now(), version: 2 });
    return dropped;
}

for (const c of COPIES) {
    if (fs.existsSync(path.join(DIR, `${c.id}.json`)) && !force.has(c.id)) {
        console.log(`${c.id}: exists — skipped (use --force=${c.id} to recreate)`);
        continue;
    }
    const n = copyFiles(c.src, c.id);
    const meta = read(path.join(DIR, `${c.id}.json`));
    write(path.join(DIR, `${c.id}.json`), { ...meta, id: c.id, name: c.name });
    const tail = cleanTail(c.id, c.tailScene, c.input);
    const report = { files: n, ...tail };
    if (c.rebuild) {
        Object.assign(report, rebuildWitnesses(c.id), { registerEntriesDropped: emptyRegister(c.id) });
    }
    console.log(c.id, JSON.stringify(report));
}
