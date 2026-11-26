// Turn Prep Experiment — P1a runner (Upgrade/Turn-Prep-Experiment/SPEC.md §6.6, §9).
//
// Runs turn-harness over probes × arms × samples in ABBA order (FULL s1, SIMPLE s1,
// SIMPLE s2, FULL s2) so cache warmth and provider drift don't favour either arm.
// Resumable: a probe/arm/sample with a successful record is skipped unless --force.
//
//   node scripts/turn-prep-experiment/run-p1a.mjs --smoke              → P2 on exp-c1-rebuilt, FULL + SIMPLE, 1 sample
//   node scripts/turn-prep-experiment/run-p1a.mjs                      → every probe, both C1 copies, 2 samples
//   node scripts/turn-prep-experiment/run-p1a.mjs --probes P2,P4 --campaigns exp-c1-rebuilt --samples 1
//   node scripts/turn-prep-experiment/run-p1a.mjs --summary            → table of the records on disk
//
// Options: --model "<provider label>" (default "DS v4 Flash"), --runs <folder under work/> (default runs),
// --arms <A,B> (default FULL,SIMPLE; MAX = Max as shipped after 2026-10-03), --mock, --force, --dry.
// Uses the backend on :3001, or starts its own for the run. Unless --mock, needs
// scripts/turn-prep-experiment/.keys.json.

import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HERE = path.join(ROOT, 'scripts/turn-prep-experiment');
const SERVER = process.env.EXP_SERVER ?? 'http://localhost:3001';

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
// --runs <folder>: where records go, under work/ (default runs). A later round uses its own
// folder so it never mixes with, or overwrites, an earlier round's records.
const runsName = opt('runs', 'runs');
const RUNS = path.join(HERE, 'work', runsName);

const probesFile = JSON.parse(fs.readFileSync(path.join(HERE, 'probes.json'), 'utf8'));
const groups = Object.values(probesFile).filter(g => g?.campaigns);
const smoke = flag('smoke');
const model = opt('model', 'DS v4 Flash');
const mock = flag('mock');
const campaigns = (opt('campaigns') ?? (smoke ? 'exp-c1-rebuilt' : groups.flatMap(g => g.campaigns).join(','))).split(',');
const samples = Number(opt('samples', smoke ? '1' : '2'));
const probeFilter = opt('probes', smoke ? 'P2' : null)?.split(',');
const arms = opt('arms', 'FULL,SIMPLE').split(',');
const modelTag = model.replace(/[^A-Za-z0-9.]+/g, '-');

const recordPath = (campaign, probe, arm, sample, failed = false) =>
    path.join(RUNS, campaign, probe, `${arm}__${modelTag}__s${sample}${mock ? '__mock' : ''}${failed ? '__FAILED' : ''}.json`);

if (flag('summary')) { summarize(); process.exit(0); }

// ── Schedule ─────────────────────────────────────────────────────────────
const schedule = [];
for (const group of groups) {
    const probes = Object.keys(group.probes).filter(p => !probeFilter || probeFilter.includes(p));
    for (const probe of probes) {
        for (const campaign of campaigns.filter(c => group.campaigns.includes(c))) {
            for (let s = 1; s <= samples; s++) {
                const order = s % 2 === 1 ? arms : [...arms].reverse();
                for (const arm of order) schedule.push({ campaign, probe, arm, sample: s });
            }
        }
    }
}
const todo = schedule.filter(r => flag('force') || !fs.existsSync(recordPath(r.campaign, r.probe, r.arm, r.sample)));
console.log(`[p1a] model "${model}"${mock ? ' (MOCK)' : ''}: ${schedule.length} runs scheduled, ${schedule.length - todo.length} already done, ${todo.length} to run`);
if (flag('dry')) { for (const r of todo) console.log(`  ${r.campaign} ${r.probe} ${r.arm} s${r.sample}`); process.exit(0); }

// ── Preflight ────────────────────────────────────────────────────────────
// A long run must outlive whoever started the backend, so when none is up the runner
// starts its own for the duration of the run and stops it on exit.
const backendUp = async () => { try { return (await fetch(`${SERVER}/api/settings`)).ok; } catch { return false; } };
let ownBackend = null;
if (!(await backendUp())) {
    console.log(`[p1a] no backend at ${SERVER}; starting one for this run (log: work/backend.log)`);
    const log = fs.openSync(path.join(HERE, 'work/backend.log'), 'a');
    ownBackend = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: ['ignore', log, log] });
    ownBackend.unref(); // don't keep the runner alive once the work is done; 'exit' stops it
    const stop = () => { if (ownBackend && !ownBackend.killed) ownBackend.kill(); };
    process.on('exit', stop);
    process.on('SIGINT', () => { stop(); process.exit(130); });
    for (let i = 0; i < 60 && !(await backendUp()); i++) await new Promise(r => setTimeout(r, 1000));
    if (!(await backendUp())) { console.error('[p1a] backend did not start; see work/backend.log'); process.exit(1); }
}
if (!mock) {
    const keysPath = path.join(HERE, '.keys.json');
    if (!fs.existsSync(keysPath)) { console.error('[p1a] missing scripts/turn-prep-experiment/.keys.json'); process.exit(1); }
    let keys;
    try { keys = JSON.parse(fs.readFileSync(keysPath, 'utf8')); } catch { console.error('[p1a] .keys.json is not valid JSON'); process.exit(1); }
    if (!keys[model]) { console.error(`[p1a] .keys.json has no entry named "${model}" (names: ${Object.keys(keys).join(', ') || 'none'})`); process.exit(1); }
}

// ── Run ──────────────────────────────────────────────────────────────────
const started = Date.now();
for (const [i, r] of todo.entries()) {
    let ok = false;
    for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
        process.stdout.write(`[p1a] ${i + 1}/${todo.length} ${r.campaign} ${r.probe} ${r.arm} s${r.sample}${attempt > 1 ? ' (retry)' : ''} … `);
        const t = Date.now();
        const result = spawnSync('npx vitest run --config scripts/turn-prep-experiment/vitest.experiment.config.ts --reporter=verbose --silent=false turn-harness', {
            cwd: ROOT, shell: true, encoding: 'utf8',
            env: {
                ...process.env, EXP_CAMPAIGN: r.campaign, EXP_PROBE: r.probe, EXP_ARM: r.arm, EXP_SAMPLE: String(r.sample),
                EXP_STORY: model, EXP_UTILITY: model, EXP_MOCK: mock ? '1' : '', EXP_RUNS: runsName,
            },
        });
        const out = `${result.stdout}\n${result.stderr}`;
        const line = out.split('\n').find(l => l.includes('[turn-harness]'));
        ok = result.status === 0 && fs.existsSync(recordPath(r.campaign, r.probe, r.arm, r.sample));
        console.log(ok ? `ok ${Math.round((Date.now() - t) / 1000)}s` : 'FAILED');
        if (line) console.log(`      ${line.trim().replace(/^.*\[turn-harness\]\s*/, '')}`);
        if (!ok) {
            const err = out.split('\n').filter(l => /Error:|Error\b.*:/.test(l)).slice(0, 3);
            for (const l of err) console.log(`      ${l.trim()}`);
        }
    }
    if (!ok) { console.error('[p1a] stopping: a run failed twice. Fix it and re-run; finished runs are kept.'); process.exit(1); }
}
console.log(`[p1a] done in ${Math.round((Date.now() - started) / 60000)} min`);
summarize();

// ── Summary ──────────────────────────────────────────────────────────────
function summarize() {
    const rows = [];
    if (!fs.existsSync(RUNS)) { console.log('[p1a] no runs yet'); return; }
    for (const campaign of fs.readdirSync(RUNS)) {
        for (const probe of fs.readdirSync(path.join(RUNS, campaign))) {
            for (const file of fs.readdirSync(path.join(RUNS, campaign, probe))) {
                const m = file.match(/^(\w+)__(.+?)__s(\d+)(__mock)?(__FAILED)?\.json$/);
                if (!m || m[2] !== modelTag || !!m[4] !== mock || m[5]) continue;
                const rec = JSON.parse(fs.readFileSync(path.join(RUNS, campaign, probe, file), 'utf8'));
                rows.push({ campaign, probe, arm: m[1], sample: m[3], rec });
            }
        }
    }
    if (!rows.length) { console.log(`[p1a] no records for "${model}"${mock ? ' (mock)' : ''}`); return; }
    const median = xs => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
    const sec = ms => (ms == null ? '   —' : (ms / 1000).toFixed(1).padStart(5) + 's');
    console.log(`\n[p1a] records for "${model}"${mock ? ' (mock)' : ''}: TTFT = Send → first visible token`);
    console.log('campaign          probe arm     n  TTFT(med)  prep(med)  think(med)  preCalls  preTokIn  replyCh(med)');
    const keyOf = r => `${r.campaign}|${r.probe}|${r.arm}`;
    for (const key of [...new Set(rows.map(keyOf))].sort()) {
        const rs = rows.filter(r => keyOf(r) === key);
        const [campaign, probe, arm] = key.split('|');
        console.log(`${campaign.padEnd(17)} ${probe.padEnd(5)} ${arm.padEnd(7)} ${String(rs.length).padStart(1)}  ${sec(median(rs.map(r => r.rec.timing.ttftMs)))}     ${sec(median(rs.map(r => r.rec.timing.prepMs)))}     ${sec(median(rs.map(r => r.rec.timing.storyThinkingMs)))}      ${String(median(rs.map(r => r.rec.tokens?.preToken.calls))).padStart(4)}   ${String(median(rs.map(r => r.rec.tokens?.preToken.prompt))).padStart(8)}   ${String(median(rs.map(r => r.rec.reply.length))).padStart(8)}`);
    }
    for (const arm of ['FULL', 'SIMPLE']) {
        const all = rows.filter(r => r.arm === arm).map(r => r.rec.timing.ttftMs);
        console.log(`  overall ${arm.padEnd(6)} median TTFT ${sec(median(all))} over ${all.length} runs`);
    }
}
