// Turn Prep Experiment — how well does the 👥 header parser read real GM replies?
//
//   npx vitest run --config scripts/turn-prep-experiment/vitest.experiment.config.ts present-header-check
//
// Read-only. Per campaign: scenes with a 👥 field, how many name at least one ledger NPC,
// and a sample of raw headers next to what they resolved to.

import fs from 'fs';
import path from 'path';
import { it, vi } from 'vitest';

vi.mock('idb-keyval', () => ({ get: vi.fn(), set: vi.fn(), del: vi.fn(), keys: vi.fn(async () => []) }));

import { parsePresentHeader, resolvePresentNpcs } from '../../src/services/npc/presentHeader';
import { parseArchiveScenes } from '../../server/lib/archiveScenes.js';
import type { NPCEntry } from '../../src/types';

const ROOT = path.resolve('data/campaigns');
const CAMPAIGNS = (process.env.CAMPAIGNS ?? 'exp-c1-rebuilt,mnwf9obfkz6rk,mru5cz53qojl0,exp-c2').split(',');

it('present header replay', () => {
    let out = '\n';
    for (const id of CAMPAIGNS) {
        const ledger = JSON.parse(fs.readFileSync(path.join(ROOT, `${id}.npcs.json`), 'utf8')) as NPCEntry[];
        const scenes = parseArchiveScenes(fs.readFileSync(path.join(ROOT, `${id}.archive.md`), 'utf8'));
        let withHeader = 0, nobody = 0, resolvedAny = 0;
        const samples: string[] = [];
        for (const scene of scenes) {
            const names = parsePresentHeader(scene.assistantContent);
            if (names === null) continue;
            withHeader++;
            if (names.length === 0) { nobody++; continue; }
            const npcs = resolvePresentNpcs(names, ledger);
            if (npcs.length > 0) resolvedAny++;
            if (samples.length < 6 && Number(scene.sceneId) % 50 === 0) {
                const raw = scene.assistantContent.match(/👥[^|\n]*/gu)?.pop()?.slice(0, 110);
                samples.push(`    #${scene.sceneId} ${raw}\n      → ${npcs.map(n => n.name).join(', ') || '(none)'}`);
            }
        }
        out += `${id}: ${scenes.length} scenes, 👥 field in ${withHeader}, "nobody" ${nobody}, names a ledger NPC in ${resolvedAny}\n${samples.join('\n')}\n`;
    }
    process.stdout.write(out);
});
