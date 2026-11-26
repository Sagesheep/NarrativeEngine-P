// Turn Prep Experiment — what reached the prompt, round by round.
//
//   node scripts/turn-prep-experiment/compare-rounds.mjs <probe,...> [runs folder ...]
//   e.g.  compare-rounds.mjs P2,P3,P5,P6 runs runs-r2
//
// Per run: first visible token, prep time, the scenes archive recall and elevation put in
// the prompt (identified by matching their text against the archive), the number of LOD
// chapters, and whether the probe's key fact is anywhere in the prompt.

import fs from 'fs';
import path from 'path';

const HERE = path.resolve('scripts/turn-prep-experiment');
const [probesArg, ...folders] = process.argv.slice(2);
if (!probesArg) { console.error('usage: compare-rounds.mjs <probe,...> [runs folder ...]'); process.exit(2); }
const probes = probesArg.split(',');
const runFolders = folders.length ? folders : ['runs', 'runs-r2'];
const CAMPAIGN = 'exp-c1-rebuilt';

// The fact each probe depends on, as it reads in summaries, facts or scene prose.
const KEY_FACT = {
    P2: /(first access|findings)[^\n]{0,200}(Therese|Soll)|(Therese|Soll)[^\n]{0,200}(first access|findings)/i,
    P3: /(first access|findings)[^\n]{0,200}(Therese|Soll)|(Therese|Soll)[^\n]{0,200}(first access|findings)/i,
    P5: /Helena[^\n]{0,300}Pell|Pell[^\n]{0,300}Helena/i,
    P6: /IOU/i,
};

const archive = fs.readFileSync(`data/campaigns/${CAMPAIGN}.archive.md`, 'utf8').replace(/\r\n/g, '\n');
const sceneStarts = [...archive.matchAll(/^## SCENE (\d+)/gm)].map(m => [m.index, m[1]]);
const sceneAt = (pos) => { let id = '?'; for (const [i, s] of sceneStarts) { if (i > pos) break; id = s; } return id; };
const identify = (body) => {
    const probe = body.replace(/^\s+/, '').slice(0, 80);
    const at = archive.indexOf(probe);
    return at >= 0 ? sceneAt(at) : '?';
};

for (const folder of runFolders) {
    console.log(`\n== ${folder}`);
    for (const probe of probes) {
        const dir = path.join(HERE, 'work', folder, CAMPAIGN, probe);
        if (!fs.existsSync(dir)) continue;
        for (const file of fs.readdirSync(dir).filter(f => /^[A-Z0-9]+__.*__s\d+\.json$/.test(f)).sort()) {
            const r = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
            const text = r.payload.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
            const recallBlock = text.slice(text.indexOf('[ARCHIVE RECALL'), text.indexOf('[END ARCHIVE RECALL]') + 1);
            const recalled = text.includes('[ARCHIVE RECALL')
                ? recallBlock.split(/\n(?=\[PAST SCENE)/).slice(1).map(s => identify(s.split('\n').slice(1).join('\n')))
                : [];
            const elevTrace = (r.payloadTrace ?? []).find(t => t.source === 'Dynamic Elevation' && t.included);
            const elevated = elevTrace ? (elevTrace.reason.match(/IDs: ([\d, ]+)/)?.[1] ?? '').split(',').map(s => s.trim()).filter(Boolean) : [];
            const lod = (r.payloadTrace ?? []).find(t => t.source === 'LOD History')?.reason.match(/\((\d+) summary, (\d+) synopsis/);
            const fact = KEY_FACT[probe]?.test(text) ? 'yes' : 'no';
            const [arm, , sample] = file.replace('.json', '').split('__');
            console.log(`${probe} ${arm.padEnd(6)} ${sample}  ttft ${String(Math.round(r.timing.ttftMs / 1000)).padStart(3)}s prep ${String(Math.round(r.timing.prepMs / 1000)).padStart(3)}s  recall [${recalled.join(',')}] elevated [${elevated.join(',')}]  LOD ${lod ? `${lod[1]}+${lod[2]}` : '-'}  key fact in prompt: ${fact}`);
        }
    }
}
