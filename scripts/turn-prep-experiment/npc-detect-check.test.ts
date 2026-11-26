// Turn Prep Experiment — does the post-turn NPC track ever see a KNOWN NPC?
//
//   npx vitest run --config scripts/turn-prep-experiment/vitest.experiment.config.ts npc-detect-check
//
// Replays npcTrack's detection (extract with every known name excluded, then classify) on
// the last 100 GM replies of a campaign, read-only, and counts how often a known NPC
// reaches the "existing" bucket that drives NPC Profile Update and Drives Backfill.

import fs from 'fs';
import path from 'path';
import { it, vi } from 'vitest';

vi.mock('idb-keyval', () => ({ get: vi.fn(), set: vi.fn(), del: vi.fn(), keys: vi.fn(async () => []) }));

import { extractNPCNames, classifyNPCNames } from '../../src/services/npc/npcDetector';
import { parseArchiveScenes } from '../../server/lib/archiveScenes.js';
import type { NPCEntry } from '../../src/types';

const CAMPAIGN = process.env.CAMPAIGN ?? 'mnwf9obfkz6rk';
const ROOT = path.resolve('data/campaigns');

it('npc track detection replay', () => {
    const ledger = JSON.parse(fs.readFileSync(path.join(ROOT, `${CAMPAIGN}.npcs.json`), 'utf8')) as NPCEntry[];
    const scenes = parseArchiveScenes(fs.readFileSync(path.join(ROOT, `${CAMPAIGN}.archive.md`), 'utf8')).slice(-100);
    const excludeNames = ledger.flatMap(npc => [npc.name, ...(npc.aliases || '').split(',').map(a => a.trim()).filter(Boolean)]);

    let withKnownExcluded = 0, withoutExclusion = 0, mentionsKnown = 0;
    for (const scene of scenes) {
        const gm = scene.assistantContent;
        // As npcTrack does it today.
        const { existingNpcs } = classifyNPCNames(extractNPCNames(gm, excludeNames), ledger, excludeNames);
        if (existingNpcs.length > 0) withKnownExcluded++;
        // The same reply without the exclusion list.
        const { existingNpcs: found } = classifyNPCNames(extractNPCNames(gm), ledger);
        if (found.length > 0) withoutExclusion++;
        if (ledger.some(n => n.name && gm.includes(n.name.split(' ')[0]))) mentionsKnown++;
    }
    process.stdout.write(`\n${CAMPAIGN}: last ${scenes.length} GM replies\n`
        + `  mention a known NPC by name (rough):        ${mentionsKnown}\n`
        + `  known NPC reaches update/backfill (today): ${withKnownExcluded}\n`
        + `  known NPC found without the exclude list:  ${withoutExclusion}\n`);
});
