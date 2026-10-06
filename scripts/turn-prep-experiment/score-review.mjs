// Turn Prep Experiment — un-blind the owner's scores and apply the decision rules (SPEC.md §8).
//
//   node scripts/turn-prep-experiment/score-review.mjs <batch> [path/to/scores.json]
//
// <batch> is the folder under work/review/ (it holds key.json). scores.json is what the
// review page exported; by default it's read from the same folder.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HERE = path.join(ROOT, 'scripts/turn-prep-experiment');
const [batch, scoresArg] = process.argv.slice(2);
if (!batch) { console.error('usage: score-review.mjs <batch> [scores.json]'); process.exit(2); }
const dir = path.join(HERE, 'work/review', batch);
const key = JSON.parse(fs.readFileSync(path.join(dir, 'key.json'), 'utf8'));
const scores = JSON.parse(fs.readFileSync(scoresArg ?? path.join(dir, 'scores.json'), 'utf8')).scores;

const MEMORY_PROBES = new Set(['P2', 'P3', 'P5', 'P6', 'P11', 'P12', 'P14']);
const CHECKS = ['contradicts', 'absent', 'renamed', 'pcDecides'];

// ── Un-blind: one row per reply ──────────────────────────────────────────
const rows = [];
const prefs = [];
let unscored = 0;
for (const [id, k] of Object.entries(key.pairs)) {
    const s = scores[id];
    if (!s?.A?.verdict || !s?.B?.verdict || !s?.pref) { unscored++; continue; }
    for (const side of ['A', 'B']) {
        rows.push({ id, campaign: k.campaign, probe: k.probe, sample: k.sample, arm: k[side], verdict: s[side].verdict, checks: CHECKS.filter(c => s[side][c]), notes: s.notes ?? '' });
    }
    prefs.push({ campaign: k.campaign, probe: k.probe, winner: s.pref === 'tie' ? 'tie' : k[s.pref] });
}
console.log(`[score] batch ${batch}: ${Object.keys(key.pairs).length} pairs, ${prefs.length} scored${unscored ? `, ${unscored} UNSCORED (excluded)` : ''}\n`);

// ── Per probe ────────────────────────────────────────────────────────────
const cell = (campaign, probe, arm) => rows.filter(r => r.campaign === campaign && r.probe === probe && r.arm === arm)
    .sort((a, b) => a.sample - b.sample).map(r => ({ pass: '✓', fail: '✗', unclear: '?' }[r.verdict])).join('') || '—';
const campaigns = [...new Set(rows.map(r => r.campaign))].sort();
console.log('campaign          probe  FULL  SIMPLE  preference (FULL/SIMPLE/tie)');
for (const c of campaigns) {
    for (const p of [...new Set(rows.filter(r => r.campaign === c).map(r => r.probe))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))) {
        const ps = prefs.filter(x => x.campaign === c && x.probe === p);
        const n = w => ps.filter(x => x.winner === w).length;
        console.log(`${c.padEnd(17)} ${p.padEnd(5)}  ${cell(c, p, 'FULL').padEnd(4)}  ${cell(c, p, 'SIMPLE').padEnd(6)}  ${n('FULL')}/${n('SIMPLE')}/${n('tie')}`);
    }
}

// ── Universal checks ─────────────────────────────────────────────────────
console.log('\nUniversal checks (replies flagged):');
for (const arm of ['FULL', 'SIMPLE']) {
    const rs = rows.filter(r => r.arm === arm);
    console.log(`  ${arm.padEnd(6)} ${CHECKS.map(c => `${c}=${rs.filter(r => r.checks.includes(c)).length}`).join('  ')}  (of ${rs.length})`);
}

// ── Speed (from the run records) ─────────────────────────────────────────
const modelTag = key.model.replace(/[^A-Za-z0-9.]+/g, '-');
const ttft = { FULL: [], SIMPLE: [] };
for (const c of campaigns) {
    const base = path.join(HERE, 'work', key.runs ?? 'runs', c);
    for (const p of fs.existsSync(base) ? fs.readdirSync(base) : []) {
        for (const arm of ['FULL', 'SIMPLE']) {
            for (const f of fs.readdirSync(path.join(base, p)).filter(f => f.startsWith(`${arm}__${modelTag}__s`) && f.includes('__mock') === !!key.mock && !f.includes('__FAILED'))) {
                const t = JSON.parse(fs.readFileSync(path.join(base, p, f), 'utf8')).timing.ttftMs;
                if (t != null) ttft[arm].push(t);
            }
        }
    }
}
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const mF = median(ttft.FULL), mS = median(ttft.SIMPLE);
const speedGain = mF != null && mS != null && (mF - mS) / mF >= 0.4 && mF - mS >= 3000;

// ── §8 rules, overall and per campaign ───────────────────────────────────
const fails = (rs, arm) => rs.filter(r => r.arm === arm && r.verdict === 'fail').length;
function equivalent(scope) {
    const rs = rows.filter(r => !scope || r.campaign === scope);
    const ps = prefs.filter(x => !scope || x.campaign === scope);
    const extraFails = fails(rs, 'SIMPLE') - fails(rs, 'FULL');
    const memoryLosses = [...new Set(rs.map(r => `${r.campaign}|${r.probe}`))].filter(cp => {
        const [c, p] = cp.split('|');
        if (!MEMORY_PROBES.has(p)) return false;
        const of = arm => rs.filter(r => r.campaign === c && r.probe === p && r.arm === arm);
        // FULL passes and SIMPLE fails in BOTH samples.
        const full = of('FULL'), simple = of('SIMPLE');
        return full.length >= 2 && simple.length >= 2 && full.every(r => r.verdict === 'pass') && simple.every(r => r.verdict === 'fail');
    });
    const nonTie = ps.filter(x => x.winner !== 'tie');
    const fullShare = nonTie.length ? nonTie.filter(x => x.winner === 'FULL').length / nonTie.length : 0;
    return { extraFails, memoryLosses, fullShare, ok: extraFails <= 1 && memoryLosses.length === 0 && fullShare <= 0.6 };
}

console.log(`\nSpeed: median TTFT FULL ${(mF / 1000).toFixed(1)}s (n=${ttft.FULL.length}), SIMPLE ${(mS / 1000).toFixed(1)}s (n=${ttft.SIMPLE.length}) → meaningful gain (≥40% and ≥3s): ${speedGain ? 'YES' : 'no'}`);
console.log('\nEquivalent quality (§8):');
for (const scope of [null, ...campaigns]) {
    const e = equivalent(scope);
    console.log(`  ${(scope ?? 'ALL').padEnd(16)} SIMPLE extra fails ${String(e.extraFails).padStart(2)} (≤1)  memory losses ${e.memoryLosses.length ? e.memoryLosses.join(', ') : 'none'}  FULL preferred ${(e.fullShare * 100).toFixed(0)}% of non-tie (≤60%)  → ${e.ok ? 'EQUIVALENT' : 'not equivalent'}`);
}

// Outcome E: the two samples disagree on more than a third of probes.
const probeKeys = [...new Set(rows.map(r => `${r.campaign}|${r.probe}`))];
const disputed = probeKeys.filter(cp => ['FULL', 'SIMPLE'].some(arm => {
    const v = rows.filter(r => `${r.campaign}|${r.probe}` === cp && r.arm === arm).map(r => r.verdict);
    return v.length >= 2 && new Set(v).size > 1;
}));
console.log(`\nSample disagreement: ${disputed.length}/${probeKeys.length} probes${disputed.length > probeKeys.length / 3 ? ' → OUTCOME E (inconclusive) applies to these' : ''}${disputed.length ? `: ${disputed.map(d => d.replace('|', ' ')).join(', ')}` : ''}`);

// Outcome F: SIMPLE on rebuilt data vs FULL on raw data.
const passes = (c, arm) => rows.filter(r => r.campaign === c && r.arm === arm && r.verdict === 'pass').length;
if (campaigns.includes('exp-c1-rebuilt') && campaigns.includes('exp-c1-raw')) {
    const sr = passes('exp-c1-rebuilt', 'SIMPLE'), fr = passes('exp-c1-raw', 'FULL');
    console.log(`Outcome F check: SIMPLE+rebuilt passes ${sr} vs FULL+raw passes ${fr} → ${sr >= fr ? 'SIMPLE on clean data ≥ FULL on today\'s data' : 'FULL on today\'s data still ahead'}`);
}

// Failures need attribution (§7.2): was the fact absent from the prompt, or present and ignored?
const failed = rows.filter(r => r.verdict === 'fail');
if (failed.length) {
    console.log(`\nFailures to attribute (absent from prompt vs present but ignored) — check each run's payload:`);
    for (const r of failed) console.log(`  ${r.campaign} ${r.probe} ${r.arm} s${r.sample}  → work/${key.runs ?? 'runs'}/${r.campaign}/${r.probe}/${r.arm}__${modelTag}__s${r.sample}${key.mock ? '__mock' : ''}.json${r.notes ? `  notes: ${r.notes.slice(0, 80)}` : ''}`);
}
