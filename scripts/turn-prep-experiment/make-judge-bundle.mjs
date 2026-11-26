// Turn Prep Experiment — blind judge bundle (SPEC.md §7.2: AI pre-screens, owner decides).
//
// Splits the blind review page's pairs into self-contained text parts that any judge
// (an AI in another app, or a person) can read. Same content as review.html: no arm,
// no copy, no key. Each part repeats the rubric and asks for JSON in scores.json shape.
//
//   node scripts/turn-prep-experiment/make-judge-bundle.mjs <batch> [maxCharsPerPart=100000]
//   → work/review/<batch>/judge/part-N.md

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const [batch, maxArg] = process.argv.slice(2);
if (!batch) { console.error('usage: make-judge-bundle.mjs <batch> [maxCharsPerPart]'); process.exit(2); }
const dir = path.join(ROOT, 'scripts/turn-prep-experiment/work/review', batch);
const html = fs.readFileSync(path.join(dir, 'review.html'), 'utf8');
const pairs = JSON.parse(html.match(/const PAIRS = (\[.*?\]);\n/s)[1]);
const maxChars = Number(maxArg ?? 100000);

const RUBRIC = `You are judging replies from an AI Game Master in a long-running text roleplay campaign. For each pair, the player sent the same message and two different versions of the app produced reply A and reply B. You don't know which version wrote which, and the A/B order is random.

STORY CONTEXT
- Probes P1–P9 are from "Spirit Card World". The player character is Grey Holmes, a private investigator who fights with equipped spirit cards (hard limit: 3 equipped). Current scene: sunset, Day 1,374, the Holmes Agency's 3rd-floor kitchen in Essenhall. Present: Grey and Rin (Rin Holmes, his partner). A courier has just delivered an unmarked two-leaf letter from the Soll household; it is unopened. The player's previous message was "I let Rin get the door."
- Probes P10–P14 are from "Three Kingdoms: Mandate of Heaven". The player character is a modern man transported to 179 AD Han China with his phone (solar case, small green charging light) in his bag. Current scene: dusk on a game trail in Wei Commandery, at a fork (north to the pass, east to the mountain). Zhang Fei is with the cart; a captured Cao scout is walking ahead and has stopped at the fork; Zhang Fei has just asked how long the green thing in the bag takes to "show what it really does". The player's previous message was "I keep quiet and let Zhang Fei deal with the scout."
- Each pair lists a CRITERION with the facts that matter. Treat it as ground truth.

FOR EACH REPLY
1. verdict — judge ONLY the criterion: "pass" (clearly meets it), "fail" (clearly violates it, or omits what the criterion says it must contain), or "unclear" (genuinely ambiguous).
2. Four flags, true only for a clear instance:
   - contradicts: states something that contradicts the criterion's facts, the story context, or itself.
   - absent: a character who is not present speaks or acts as if present (an arrival the reply narrates is fine).
   - renamed: calls an existing named character by a different name.
   - pcDecides: makes a meaningful choice, or speaks substantive new dialogue, for the player character beyond what the player wrote.

FOR EACH PAIR
3. pref — as the player of this campaign, which reply would you rather have received? Accuracy first, then quality of the writing and respect for player agency. "tie" if there's no real difference. Length is not a merit.
4. notes — one short line; name the reason for any "fail" or flag.

OUTPUT
Return ONLY a JSON object, no prose, in exactly this shape, with one entry per pair id in this part:
{"judge":"<your model name>","scores":{"<pair id>":{"A":{"verdict":"pass","contradicts":false,"absent":false,"renamed":false,"pcDecides":false},"B":{"verdict":"fail","contradicts":false,"absent":false,"renamed":false,"pcDecides":true},"pref":"A","notes":"B never connects the letter to the Therese deal; B also decides Grey's reply."}}}`;

const parts = [[]];
let size = 0;
for (const [i, p] of pairs.entries()) {
    const n = p.A.length + p.B.length;
    if (size + n > maxChars && parts.at(-1).length) { parts.push([]); size = 0; }
    parts.at(-1).push({ ...p, n: i + 1 });
    size += n;
}

const out = path.join(dir, 'judge');
fs.mkdirSync(out, { recursive: true });
for (const [k, part] of parts.entries()) {
    const body = part.map(p => [
        `=== PAIR ${p.n}/${pairs.length} · id ${p.id} · ${p.probe} ===`,
        `PLAYER: ${p.input}`,
        `CRITERION: ${p.criteria}`,
        `--- REPLY A ---`, p.A.trim(),
        `--- REPLY B ---`, p.B.trim(),
        '',
    ].join('\n')).join('\n');
    const header = `# Blind judging — part ${k + 1} of ${parts.length} (pairs ${part[0].n}–${part.at(-1).n} of ${pairs.length})\n\n${RUBRIC}\n\nThis part has ${part.length} pairs: ${part.map(p => p.id).join(', ')}.\n\n`;
    fs.writeFileSync(path.join(out, `part-${k + 1}.md`), header + body);
    console.log(`part-${k + 1}.md: pairs ${part[0].n}–${part.at(-1).n} (${part.length}), ${Math.round((header + body).length / 1000)}k chars`);
}
