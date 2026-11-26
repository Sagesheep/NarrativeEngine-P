// Turn Prep Experiment — blind review bundle (SPEC.md §6.7, §7.2).
//
// Pairs FULL and SIMPLE replies for the same campaign/probe/sample, labels them A/B in
// random order, shuffles the pairs, and hides the copy (raw/rebuilt). Writes:
//   work/review/<batch>/review.html  → open in a browser, score, press "Export scores"
//   work/review/<batch>/key.json     → which arm is A/B per pair. Don't open it before scoring.
//
//   node scripts/turn-prep-experiment/make-review.mjs [--model "DS v4 Flash"] [--mock] [--batch name] [--runs folder]

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HERE = path.join(ROOT, 'scripts/turn-prep-experiment');
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const runsName = opt('runs', 'runs');
const RUNS = path.join(HERE, 'work', runsName);
const model = opt('model', 'DS v4 Flash');
const mock = args.includes('--mock');
const modelTag = model.replace(/[^A-Za-z0-9.]+/g, '-');
const batch = opt('batch', `${modelTag}${mock ? '-mock' : ''}-${new Date().toISOString().slice(0, 10)}`);
const outDir = path.join(HERE, 'work/review', batch);

const probesFile = JSON.parse(fs.readFileSync(path.join(HERE, 'probes.json'), 'utf8'));
const criteriaFor = (campaign, probe) =>
    Object.values(probesFile).find(g => g?.campaigns?.includes(campaign))?.criteria?.[probe] ?? '';

const pairs = [];
for (const campaign of fs.existsSync(RUNS) ? fs.readdirSync(RUNS) : []) {
    for (const probe of fs.readdirSync(path.join(RUNS, campaign))) {
        const dir = path.join(RUNS, campaign, probe);
        const load = (arm, s) => {
            const f = path.join(dir, `${arm}__${modelTag}__s${s}${mock ? '__mock' : ''}.json`);
            return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
        };
        for (let s = 1; s <= 9; s++) {
            const full = load('FULL', s), simple = load('SIMPLE', s);
            if (!full || !simple) continue;
            const fullIsA = crypto.randomInt(2) === 0;
            pairs.push({
                id: crypto.randomBytes(4).toString('hex'),
                campaign, probe, sample: s,
                input: full.input,
                criteria: criteriaFor(campaign, probe),
                A: fullIsA ? full.reply : simple.reply,
                B: fullIsA ? simple.reply : full.reply,
                key: { A: fullIsA ? 'FULL' : 'SIMPLE', B: fullIsA ? 'SIMPLE' : 'FULL' },
            });
        }
    }
}
if (!pairs.length) { console.error(`[review] no complete FULL/SIMPLE pairs for "${model}"${mock ? ' (mock)' : ''}`); process.exit(1); }

// Fisher–Yates with a CSPRNG so order carries no information about arm or copy.
for (let i = pairs.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [pairs[i], pairs[j]] = [pairs[j], pairs[i]]; }

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'key.json'), JSON.stringify({
    batch, model, mock, runs: runsName, createdAt: new Date().toISOString(),
    pairs: Object.fromEntries(pairs.map(p => [p.id, { campaign: p.campaign, probe: p.probe, sample: p.sample, ...p.key }])),
}, null, 2));

const blind = pairs.map(p => ({ id: p.id, probe: p.probe, input: p.input, criteria: p.criteria, A: stripThink(p.A), B: stripThink(p.B) }));
fs.writeFileSync(path.join(outDir, 'review.html'), page(batch, blind));
console.log(`[review] ${pairs.length} pairs → work/review/${batch}/review.html (key in key.json; don't open it before scoring)`);

function stripThink(s) { return String(s ?? '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim(); }

function page(batch, pairs) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Blind Review</title>
<style>
:root { --bg:#f7f6f3; --card:#fff; --ink:#1d1d1f; --muted:#6b6b70; --line:#e2e0da; --accent:#3a5bd9; --pass:#1f8a4c; --fail:#c0392b; }
@media (prefers-color-scheme: dark) { :root { --bg:#16161a; --card:#1f1f24; --ink:#ececf0; --muted:#9a9aa3; --line:#33333b; --accent:#8aa2ff; --pass:#4cc38a; --fail:#ff7b6b; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { position:sticky; top:0; z-index:2; background:var(--bg); border-bottom:1px solid var(--line); padding:10px 16px; display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
header h1 { font-size:16px; margin:0; } header .grow { flex:1; } header .progress { color:var(--muted); font-variant-numeric:tabular-nums; }
button { font:inherit; padding:6px 12px; border-radius:6px; border:1px solid var(--line); background:var(--card); color:var(--ink); cursor:pointer; }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
main { max-width:1400px; margin:0 auto; padding:16px; }
.pair { background:var(--card); border:1px solid var(--line); border-radius:10px; margin:0 0 24px; padding:16px; }
.pair h2 { font-size:15px; margin:0 0 6px; } .input { font-style:italic; margin:0 0 8px; }
.criteria { font-size:13px; color:var(--muted); border-left:3px solid var(--line); padding-left:10px; margin:0 0 14px; }
.cols { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
@media (max-width: 860px) { .cols { grid-template-columns:1fr; } }
.reply { border:1px solid var(--line); border-radius:8px; padding:12px; min-width:0; }
.reply h3 { margin:0 0 8px; font-size:14px; }
.prose { max-height:60vh; overflow:auto; overflow-wrap:anywhere; font-size:14px; } .prose p { margin:0 0 .7em; }
fieldset { border:0; padding:0; margin:10px 0 0; } legend { font-size:12px; color:var(--muted); padding:0; margin-bottom:4px; }
label { display:inline-flex; gap:4px; align-items:center; margin:2px 12px 2px 0; font-size:13px; cursor:pointer; }
.checks label { display:flex; }
.pref { margin-top:14px; padding-top:12px; border-top:1px solid var(--line); }
textarea { width:100%; min-height:44px; margin-top:8px; font:inherit; font-size:13px; background:var(--bg); color:var(--ink); border:1px solid var(--line); border-radius:6px; padding:6px; }
.done { outline:2px solid var(--pass); outline-offset:-2px; }
</style></head><body>
<header><h1>Blind review — ${esc(batch)}</h1><span class="grow"></span><span class="progress" id="progress"></span>
<button class="primary" id="export">Export scores</button></header>
<main id="main"></main>
<script>
const PAIRS = ${JSON.stringify(pairs).replace(/</g, '\\u003c')};
const STORE = 'blind-review:${batch}';
const CHECKS = [
  ['contradicts', 'Contradicts a fact in its own prompt / the story so far'],
  ['absent', 'An absent character acts as if present'],
  ['renamed', 'Invents a new name for an existing NPC'],
  ['pcDecides', "Writes the PC's decisions for the player"],
];
let scores = {};
try { scores = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch {}
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(scores)); } catch {} progress(); };
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const md = s => esc(s).split(/\\n{2,}/).map(p => '<p>' + p
  .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>').replace(/\\*([^*\\n]+)\\*/g, '<em>$1</em>').replace(/\\n/g, '<br>') + '</p>').join('');
const radios = (name, opts, cur) => opts.map(([v, l]) => '<label><input type="radio" name="' + name + '" value="' + v + '"' + (cur === v ? ' checked' : '') + '>' + l + '</label>').join('');
function render() {
  document.getElementById('main').innerHTML = PAIRS.map((p, i) => {
    const s = scores[p.id] || {};
    const side = k => {
      const r = s[k] || {};
      return '<div class="reply"><h3>Reply ' + k + '</h3><div class="prose">' + md(p[k] || '(empty reply)') + '</div>'
        + '<fieldset><legend>Probe check</legend>' + radios(p.id + ':' + k + ':verdict', [['pass','Pass'],['fail','Fail'],['unclear','Unclear']], r.verdict) + '</fieldset>'
        + '<fieldset class="checks"><legend>Universal checks (tick if it happens)</legend>'
        + CHECKS.map(([c, l]) => '<label><input type="checkbox" data-id="' + p.id + '" data-side="' + k + '" data-check="' + c + '"' + (r[c] ? ' checked' : '') + '>' + l + '</label>').join('')
        + '</fieldset></div>';
    };
    const complete = s.A?.verdict && s.B?.verdict && s.pref;
    return '<section class="pair' + (complete ? ' done' : '') + '" id="pair-' + p.id + '"><h2>' + (i + 1) + ' / ' + PAIRS.length + ' · ' + esc(p.probe) + '</h2>'
      + '<p class="input">Player: ' + esc(p.input) + '</p><p class="criteria">' + esc(p.criteria) + '</p>'
      + '<div class="cols">' + side('A') + side('B') + '</div>'
      + '<div class="pref"><fieldset><legend>Which reply would you rather have received?</legend>' + radios(p.id + ':pref', [['A','A'],['B','B'],['tie','Tie']], s.pref) + '</fieldset>'
      + '<textarea data-id="' + p.id + '" placeholder="Notes (optional)">' + esc(s.notes || '') + '</textarea></div></section>';
  }).join('');
  progress();
}
function progress() {
  const n = PAIRS.filter(p => { const s = scores[p.id] || {}; return s.A?.verdict && s.B?.verdict && s.pref; }).length;
  document.getElementById('progress').textContent = n + ' / ' + PAIRS.length + ' scored';
}
document.addEventListener('change', e => {
  const t = e.target;
  if (t.type === 'radio') {
    const [id, a, b] = t.name.split(':');
    const s = scores[id] ||= {};
    if (a === 'pref') s.pref = t.value; else (s[a] ||= {}).verdict = t.value;
    t.closest('.pair').classList.toggle('done', !!(s.A?.verdict && s.B?.verdict && s.pref));
  } else if (t.type === 'checkbox') {
    ((scores[t.dataset.id] ||= {})[t.dataset.side] ||= {})[t.dataset.check] = t.checked;
  }
  save();
});
document.addEventListener('input', e => { if (e.target.tagName === 'TEXTAREA') { (scores[e.target.dataset.id] ||= {}).notes = e.target.value; save(); } });
document.getElementById('export').onclick = () => {
  const blob = new Blob([JSON.stringify({ batch: ${JSON.stringify(batch)}, exportedAt: new Date().toISOString(), scores }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'scores.json'; a.click();
};
render();
</script></body></html>`;
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
