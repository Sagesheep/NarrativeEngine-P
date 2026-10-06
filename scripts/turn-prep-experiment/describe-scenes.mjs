// Print a one-paragraph look at scenes (place/cast line, the player's message, the GM's
// opening), to judge whether a retrieval hit is relevant.
//   node scripts/turn-prep-experiment/describe-scenes.mjs <campaign> 113,116,118
import fs from 'fs';
const [campaign, ids] = process.argv.slice(2);
const { readSceneProse } = await import('../../server/services/archiveService.js');
const { buildScenePassages } = await import('../../server/lib/embedder.js');
const prose = readSceneProse(campaign);
for (const id of ids.split(',').map(s => s.trim().padStart(3, '0'))) {
    const p = prose.get(id);
    if (!p) { console.log(`${id}: (missing)`); continue; }
    const passages = buildScenePassages(p.userContent, p.assistantContent);
    const text = passages.join(' ').replace(/\s+/g, ' ');
    console.log(`${id}: ${text.slice(0, Number(process.env.CHARS ?? 420))}${text.length > Number(process.env.CHARS ?? 420) ? ' …' : ''}`);
}
