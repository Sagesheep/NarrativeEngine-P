// Turn Prep Experiment — Director thinking check.
//
// Times the Director brief alone (the turn stops before the story call) with the
// Auxiliary slot's thinking at each level asked for, over the C1 probes, and writes the
// briefs side by side so the quality can be read, not just the speed.
//
//   node scripts/turn-prep-experiment/director-check.mjs                     → off + high, P1–P9, 2 samples
//   node scripts/turn-prep-experiment/director-check.mjs --levels off --probes P4,P7 --samples 1
//   node scripts/turn-prep-experiment/director-check.mjs --summary           → table + briefs file only
//   add --mock to validate the plumbing without model calls; --model / --key pick the provider
//   label and the .keys.json entry (defaults: deepseek-v4-flash, "DS v4 Flash")
//
// Records: work/director-check/<campaign>/<probe>/U3__<model>__aux-<level>__director-only__s<n>.json
// Briefs:  work/director-check/briefs.md
// Uses the backend on :3001, or starts its own. Unless --mock, needs .keys.json.

import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HERE = path.join(ROOT, 'scripts/turn-prep-experiment');
const SERVER = process.env.EXP_SERVER ?? 'http://localhost:3001';
const RUNS_NAME = 'director-check';
const RUNS = path.join(HERE, 'work', RUNS_NAME);

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const model = opt('model', 'deepseek-v4-flash');
// The .keys.json entry was stored under the provider's earlier name.
const keyName = opt('key', 'DS v4 Flash');
const modelTag = model.replace(/[^A-Za-z0-9.]+/g, '-');
const campaign = opt('campaign', 'exp-c1-rebuilt');
const levels = opt('levels', 'off,high').split(',');
const samples = Number(opt('samples', '2'));
const mock = flag('mock');

const probesFile = JSON.parse(fs.readFileSync(path.join(HERE, 'probes.json'), 'utf8'));
const group = Object.values(probesFile).find(g => g?.campaigns?.includes(campaign));
const probes = (opt('probes') ?? Object.keys(group.probes).join(',')).split(',');

const recordPath = (probe, level, sample, failed = false) =>
    path.join(RUNS, campaign, probe, `U3__${modelTag}__aux-${level}__director-only__s${sample}${mock ? '__mock' : ''}${failed ? '__FAILED' : ''}.json`);

if (flag('summary')) { summarize(); process.exit(0); }

// Alternate the level order per sample so provider warmth favours neither.
const todo = [];
for (const probe of probes) {
    for (let s = 1; s <= samples; s++) {
        for (const level of s % 2 ? levels : [...levels].reverse()) {
            if (flag('force') || !fs.existsSync(recordPath(probe, level, s))) todo.push({ probe, level, sample: s });
        }
    }
}
console.log(`[director] ${campaign} "${model}"${mock ? ' (MOCK)' : ''}: ${todo.length} runs to do`);

const backendUp = async () => { try { return (await fetch(`${SERVER}/api/settings`)).ok; } catch { return false; } };
let ownBackend = null;
if (todo.length && !(await backendUp())) {
    console.log(`[director] no backend at ${SERVER}; starting one (log: work/backend.log)`);
    const log = fs.openSync(path.join(HERE, 'work/backend.log'), 'a');
    ownBackend = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: ['ignore', log, log] });
    for (let i = 0; i < 60 && !(await backendUp()); i++) await new Promise(r => setTimeout(r, 1000));
    if (!(await backendUp())) { console.error('[director] backend did not start; see work/backend.log'); process.exit(1); }
}

try {
    for (const [i, r] of todo.entries()) {
        let ok = false;
        for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
            process.stdout.write(`[director] ${i + 1}/${todo.length} ${r.probe} aux-${r.level} s${r.sample}${attempt > 1 ? ' (retry)' : ''} … `);
            const result = spawnSync('npx vitest run --config scripts/turn-prep-experiment/vitest.experiment.config.ts --reporter=verbose --silent=false turn-harness', {
                cwd: ROOT, shell: true, encoding: 'utf8',
                env: {
                    ...process.env, EXP_CAMPAIGN: campaign, EXP_PROBE: r.probe, EXP_ARM: 'U3', EXP_SAMPLE: String(r.sample),
                    EXP_STORY: model, EXP_UTILITY: model, EXP_MOCK: mock ? '1' : '', EXP_RUNS: RUNS_NAME,
                    EXP_AUX_THINKING: r.level, EXP_STOP_AFTER_DIRECTOR: '1', EXP_KEY_NAME: keyName,
                },
            });
            ok = result.status === 0 && fs.existsSync(recordPath(r.probe, r.level, r.sample));
            if (ok) {
                const rec = JSON.parse(fs.readFileSync(recordPath(r.probe, r.level, r.sample), 'utf8'));
                console.log(`ok director=${rec.timing.directorMs}ms`);
            } else {
                console.log('FAILED');
                const out = `${result.stdout}\n${result.stderr}`;
                for (const l of out.split('\n').filter(l => /Error:/.test(l)).slice(0, 3)) console.log(`      ${l.trim()}`);
            }
        }
        if (!ok) { console.error('[director] stopping: a run failed twice.'); process.exitCode = 1; break; }
    }
} finally {
    if (ownBackend) ownBackend.kill();
}
summarize();

// ── Summary ──────────────────────────────────────────────────────────────
function directorRequest(rec) {
    // The Director is the non-streamed call made between director:running and director:done.
    const marks = rec.timing.marks ?? [];
    const start = marks.find(m => m.event === 'director:running')?.t;
    const end = marks.find(m => m.event === 'director:done')?.t;
    if (start === undefined || end === undefined) return undefined;
    return (rec.modelRequests ?? []).find(q => !q.stream && q.t >= start - 5 && q.t <= end);
}

function summarize() {
    if (!fs.existsSync(RUNS)) { console.log('[director] no runs yet'); return; }
    const rows = [];
    for (const probe of fs.readdirSync(path.join(RUNS, campaign))) {
        for (const file of fs.readdirSync(path.join(RUNS, campaign, probe))) {
            const m = file.match(/__aux-(\w+)__director-only__s(\d+)(__mock)?(__FAILED)?\.json$/);
            if (!m || !!m[3] !== mock || m[4]) continue;
            const rec = JSON.parse(fs.readFileSync(path.join(RUNS, campaign, probe, file), 'utf8'));
            const req = directorRequest(rec);
            const reasoning = req?.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
            const completion = req?.usage?.completion_tokens ?? null;
            const brief = req?.reply ?? '';
            rows.push({
                probe, level: m[1], sample: m[2], ms: rec.timing.directorMs, reasoning,
                visible: completion === null ? null : completion - reasoning,
                mandatory: (brief.match(/\[MANDATORY\]/g) ?? []).length,
                suggestion: (brief.match(/\[SUGGESTION\]/g) ?? []).length,
                brief,
            });
        }
    }
    const median = xs => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
    console.log('\nlevel  n   director ms: median  min    max    | reasoning tok (med) | visible tok (med) | MANDATORY total');
    for (const level of [...new Set(rows.map(r => r.level))]) {
        const rs = rows.filter(r => r.level === level);
        const ms = rs.map(r => r.ms);
        console.log(`${level.padEnd(6)} ${String(rs.length).padStart(2)}   ${String(median(ms)).padStart(17)} ${String(Math.min(...ms)).padStart(5)} ${String(Math.max(...ms)).padStart(6)}  | ${String(median(rs.map(r => r.reasoning))).padStart(19)} | ${String(median(rs.map(r => r.visible))).padStart(17)} | ${rs.reduce((n, r) => n + r.mandatory, 0)}`);
    }
    const lines = [`# Director briefs by thinking level — ${campaign}, ${model}${mock ? ' (mock)' : ''}`, ''];
    for (const probe of [...new Set(rows.map(r => r.probe))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))) {
        lines.push(`## ${probe}: ${group.probes[probe]}`, '');
        for (const r of rows.filter(x => x.probe === probe).sort((a, b) => a.level.localeCompare(b.level) || a.sample - b.sample)) {
            lines.push(`### aux-${r.level} s${r.sample} — ${r.ms} ms, ${r.reasoning} reasoning + ${r.visible} visible tokens`, '', '```', r.brief.trim() || '(no brief)', '```', '');
        }
    }
    fs.writeFileSync(path.join(RUNS, `briefs${mock ? '.mock' : ''}.md`), lines.join('\n'));
    console.log(`\n[director] briefs → work/${RUNS_NAME}/briefs${mock ? '.mock' : ''}.md`);
}
