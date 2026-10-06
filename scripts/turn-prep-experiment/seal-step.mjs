// Turn Prep Experiment — cross-platform step runner for the ordered re-seal.
//
//   node scripts/turn-prep-experiment/seal-step.mjs status
//   node scripts/turn-prep-experiment/seal-step.mjs prompt CH12   → writes work/<campaign>/CH12.prompt.txt
//   node scripts/turn-prep-experiment/seal-step.mjs apply  CH12   → applies work/<campaign>/CH12.output.json
//
// Campaign defaults to exp-c1-rebuilt (override with a third argument).

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const [mode, chapter, campaign = 'exp-c1-rebuilt'] = process.argv.slice(2);
const WORK = path.join(ROOT, 'scripts/turn-prep-experiment/work', campaign);
const DATA = path.join(ROOT, 'data/campaigns');

if (mode === 'status') {
    const chapters = JSON.parse(fs.readFileSync(path.join(DATA, `${campaign}.archive.chapters.json`), 'utf8'));
    const register = JSON.parse(fs.readFileSync(path.join(DATA, `${campaign}.divergence.json`), 'utf8'));
    let next = null;
    for (const c of chapters.filter(c => c.sealedAt)) {
        const applied = register.entries.filter(e => e.chapterId === c.chapterId).length;
        const hasPrompt = fs.existsSync(path.join(WORK, `${c.chapterId}.prompt.txt`));
        const hasOutput = fs.existsSync(path.join(WORK, `${c.chapterId}.output.json`));
        if (!applied && !next) next = c.chapterId;
        console.log(`${c.chapterId.padEnd(6)} ${applied ? `APPLIED (${applied} facts)` : 'not applied'}${hasPrompt ? '  prompt' : ''}${hasOutput ? '  output' : ''}`);
    }
    console.log(next ? `NEXT: ${next}` : 'ALL SEALED CHAPTERS APPLIED');
    process.exit(0);
}

if (!(['prompt', 'apply', 'unapply'].includes(mode) && chapter) && mode !== 'settle') {
    console.error('usage: seal-step.mjs status | settle | prompt <CHxx> | apply <CHxx> | unapply <CHxx> [campaign]');
    process.exit(2);
}

const result = spawnSync('npx vitest run --config scripts/turn-prep-experiment/vitest.experiment.config.ts --reporter=verbose --silent=false seal-harness', {
    cwd: ROOT,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, EXP_CAMPAIGN: campaign, EXP_MODE: mode, EXP_CHAPTER: chapter ?? '' },
});
const lines = `${result.stdout}\n${result.stderr}`.split('\n');
const report = lines.filter(l => l.includes('[seal-harness]'));
const errors = lines.filter(l => /^\s*(Error|AssertionError|SyntaxError)\b|Error: /.test(l) && !l.includes('[ChapterSummary]'));
for (const l of report) console.log(l.trim());
if (result.status !== 0) {
    for (const l of errors.slice(0, 5)) console.error(l.trim());
    console.error(`FAILED: ${mode} ${chapter}`);
    process.exit(1);
}
console.log(`OK: ${mode} ${chapter}`);
