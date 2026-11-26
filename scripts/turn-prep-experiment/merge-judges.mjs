// Turn Prep Experiment — merge two blind judges (SPEC.md §7.2, §10: two AI pre-screens, owner decides).
//
//   node scripts/turn-prep-experiment/merge-judges.mjs <batch> <judgeA.json> <judgeB.json>
//
// Each judge file is {"judge": "...", "scores": {"<pair id>": {"A": {...}, "B": {...}, "pref": "...", "notes": "..."}}}
// (a judge returning one object per bundle part can be passed as several files joined
// with "+", e.g. sol/part-1.json+sol/part-2.json+...).
// Writes work/review/<batch>/:
//   consensus.scores.json — pairs where both judges agree on both verdicts and the preference
//   disagreements.md      — everything else, both judges' calls and notes side by side, for the owner
// Never reads key.json: merging stays blind.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const [batch, fileA, fileB] = process.argv.slice(2);
if (!batch || !fileA || !fileB) { console.error('usage: merge-judges.mjs <batch> <judgeA.json[+more]> <judgeB.json[+more]>'); process.exit(2); }
const dir = path.join(ROOT, 'scripts/turn-prep-experiment/work/review', batch);

const html = fs.readFileSync(path.join(dir, 'review.html'), 'utf8');
const pairs = JSON.parse(html.match(/const PAIRS = (\[.*?\]);\n/s)[1]);
const order = new Map(pairs.map((p, i) => [p.id, { n: i + 1, probe: p.probe }]));

const bool = v => v === true || v === 'true';
const norm = s => ({
    A: { verdict: String(s?.A?.verdict ?? '').toLowerCase(), contradicts: bool(s?.A?.contradicts), absent: bool(s?.A?.absent), renamed: bool(s?.A?.renamed), pcDecides: bool(s?.A?.pcDecides) },
    B: { verdict: String(s?.B?.verdict ?? '').toLowerCase(), contradicts: bool(s?.B?.contradicts), absent: bool(s?.B?.absent), renamed: bool(s?.B?.renamed), pcDecides: bool(s?.B?.pcDecides) },
    pref: String(s?.pref ?? '').replace(/^tie$/i, 'tie'),
    notes: s?.notes ?? '',
});
function load(spec) {
    let judge = null;
    const scores = {};
    for (const f of spec.split('+')) {
        const j = JSON.parse(fs.readFileSync(path.resolve(f), 'utf8'));
        judge ??= j.judge;
        for (const [id, s] of Object.entries(j.scores ?? {})) scores[id] = norm(s);
    }
    return { judge: judge ?? path.basename(spec), scores };
}
const J1 = load(fileA), J2 = load(fileB);

const consensus = {};
const rows = [];
let verdictAgree = 0, verdictTotal = 0, prefAgree = 0, prefTotal = 0;
for (const p of pairs) {
    const a = J1.scores[p.id], b = J2.scores[p.id];
    if (!a || !b) { rows.push({ p, missing: !a ? J1.judge : J2.judge }); continue; }
    const sameA = a.A.verdict === b.A.verdict, sameB = a.B.verdict === b.B.verdict, samePref = a.pref === b.pref;
    verdictTotal += 2; verdictAgree += Number(sameA) + Number(sameB);
    prefTotal += 1; prefAgree += Number(samePref);
    if (sameA && sameB && samePref) {
        // Flags: a problem either judge flagged is kept (OR); notes from both.
        const flags = side => Object.fromEntries(['contradicts', 'absent', 'renamed', 'pcDecides'].map(k => [k, a[side][k] || b[side][k]]));
        consensus[p.id] = {
            A: { verdict: a.A.verdict, ...flags('A') }, B: { verdict: a.B.verdict, ...flags('B') },
            pref: a.pref, notes: `${J1.judge}: ${a.notes} | ${J2.judge}: ${b.notes}`,
        };
    } else {
        rows.push({ p, a, b, sameA, sameB, samePref });
    }
}

fs.writeFileSync(path.join(dir, 'consensus.scores.json'), JSON.stringify({ batch, judges: [J1.judge, J2.judge], scores: consensus }, null, 2));

const md = [`# Judge disagreements — ${batch}`, '',
    `${J1.judge} vs ${J2.judge}. Verdict agreement ${verdictAgree}/${verdictTotal}, preference agreement ${prefAgree}/${prefTotal}. ${Object.keys(consensus).length} of ${pairs.length} pairs fully agreed (in consensus.scores.json).`,
    '', 'Each entry below needs your call. Find it in review.html by its number, read both replies, and score it there.', ''];
for (const r of rows) {
    const { n, probe } = order.get(r.p.id);
    if (r.missing) { md.push(`## ${n}/${pairs.length} · ${probe} · ${r.p.id} — missing from ${r.missing}`, ''); continue; }
    const mark = same => (same ? '' : ' ⚠');
    md.push(`## ${n}/${pairs.length} · ${probe} · ${r.p.id}`,
        `| | ${J1.judge} | ${J2.judge} |`, '|---|---|---|',
        `| Reply A${mark(r.sameA)} | ${r.a.A.verdict} | ${r.b.A.verdict} |`,
        `| Reply B${mark(r.sameB)} | ${r.a.B.verdict} | ${r.b.B.verdict} |`,
        `| Preference${mark(r.samePref)} | ${r.a.pref} | ${r.b.pref} |`, '',
        `- **${J1.judge}:** ${r.a.notes}`, `- **${J2.judge}:** ${r.b.notes}`, '');
}
fs.writeFileSync(path.join(dir, 'disagreements.md'), md.join('\n'));
console.log(`[merge] verdicts ${verdictAgree}/${verdictTotal} agree, preference ${prefAgree}/${prefTotal}; ${Object.keys(consensus).length} pairs in consensus, ${rows.length} for the owner → work/review/${batch}/disagreements.md`);
