// Backfill scene witnesses from the GM's 👥 header — the same rule the live witness track
// uses since 917fc25/215022c: the header's ledger NPCs ARE the witnesses. Free, no model.
//
// Only scenes whose witnesses came from the old server guess (no witnessSource) are touched;
// seal corrections and anything already header-sourced are left alone. Writes go through
// the server's PATCH /archive/witnesses route (backend on :3001).
//
//   dry run:  CAMPAIGN=<id> npx vitest run --config scripts/turn-prep-experiment/vitest.experiment.config.ts witness-backfill
//   apply:    CAMPAIGN=<id> APPLY=1 npx vitest run --config ...                                   witness-backfill

import fs from 'fs';
import path from 'path';
import { it, vi } from 'vitest';

vi.mock('idb-keyval', () => ({ get: vi.fn(), set: vi.fn(), del: vi.fn(), keys: vi.fn(async () => []) }));

import { parsePresentHeader, resolvePresentNpcs } from '../../src/services/npc/presentHeader';
import { parseArchiveScenes } from '../../server/lib/archiveScenes.js';
import type { NPCEntry } from '../../src/types';

const CAMPAIGN = process.env.CAMPAIGN;
const APPLY = process.env.APPLY === '1';
const ROOT = path.resolve('data/campaigns');
const SERVER = 'http://localhost:3001/api';

it('witness backfill from the 👥 header', async () => {
    if (!CAMPAIGN) throw new Error('set CAMPAIGN=<id>');
    const ledger = JSON.parse(fs.readFileSync(path.join(ROOT, `${CAMPAIGN}.npcs.json`), 'utf8')) as NPCEntry[];
    const index = await (await fetch(`${SERVER}/campaigns/${CAMPAIGN}/archive/index`)).json() as any[];
    const prose = new Map(parseArchiveScenes(fs.readFileSync(path.join(ROOT, `${CAMPAIGN}.archive.md`), 'utf8')).map(s => [s.sceneId, s.assistantContent]));

    const patches: { sceneId: string; witnesses: string[]; witnessSource: 'header' }[] = [];
    let skippedSource = 0, noHeader = 0, unchanged = 0;
    const samples: string[] = [];
    for (const entry of index) {
        if (entry.witnessSource) { skippedSource++; continue; }
        const names = parsePresentHeader(prose.get(entry.sceneId) ?? '');
        if (names === null) { noHeader++; continue; }
        const witnesses = resolvePresentNpcs(names, ledger).map(n => n.name);
        const before: string[] = entry.witnesses ?? [];
        if (before.length === witnesses.length && before.every((w, i) => w === witnesses[i])) { unchanged++; continue; }
        patches.push({ sceneId: entry.sceneId, witnesses, witnessSource: 'header' });
        if (samples.length < 8 && Number(entry.sceneId) % 40 === 0) samples.push(`  #${entry.sceneId}: ${JSON.stringify(before)} → ${JSON.stringify(witnesses)}`);
    }

    const out = [
        `${CAMPAIGN}: ${index.length} scenes | will update ${patches.length} | unchanged ${unchanged} | no 👥 line ${noHeader} | left alone (seal-corrected etc.) ${skippedSource}`,
        `  empty after update (header says nobody / no ledger NPC): ${patches.filter(p => p.witnesses.length === 0).length}`,
        ...samples,
    ];
    if (APPLY && patches.length > 0) {
        for (let i = 0; i < patches.length; i += 100) {
            const res = await fetch(`${SERVER}/campaigns/${CAMPAIGN}/archive/witnesses`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ patches: patches.slice(i, i + 100) }),
            });
            if (!res.ok) throw new Error(`PATCH failed: ${res.status} ${await res.text()}`);
        }
        out.push(`APPLIED ${patches.length} patches.`);
    } else {
        out.push('(dry run — set APPLY=1 to write)');
    }
    process.stdout.write('\n' + out.join('\n') + '\n');
}, 120_000);
