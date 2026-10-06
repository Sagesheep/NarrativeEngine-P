// Turn Prep Experiment — replay npcTrack's detection on one archived scene. Read-only.
//   CAMPAIGN=exp-c1-rebuilt SCENE=577 npx vitest run --config scripts/turn-prep-experiment/vitest.experiment.config.ts npc-scene-check
import fs from 'fs';
import path from 'path';
import { it, vi } from 'vitest';
vi.mock('idb-keyval', () => ({ get: vi.fn(), set: vi.fn(), del: vi.fn(), keys: vi.fn(async () => []) }));
import { extractNPCNames, classifyNPCNames } from '../../src/services/npc/npcDetector';
import { parseArchiveScenes } from '../../server/lib/archiveScenes.js';
import type { NPCEntry } from '../../src/types';

const CAMPAIGN = process.env.CAMPAIGN ?? 'exp-c1-rebuilt';
const SCENE = process.env.SCENE ?? '577';
const ROOT = path.resolve('data/campaigns');

it('npc detection on one scene', () => {
    const ledger = JSON.parse(fs.readFileSync(path.join(ROOT, `${CAMPAIGN}.npcs.json`), 'utf8')) as NPCEntry[];
    const scene = parseArchiveScenes(fs.readFileSync(path.join(ROOT, `${CAMPAIGN}.archive.md`), 'utf8')).find(s => s.sceneId === SCENE)!;
    // As npcTrack does it since the fix: only the player character is excluded.
    const state = JSON.parse(fs.readFileSync(path.join(ROOT, `${CAMPAIGN}.state.json`), 'utf8'));
    const pc = state.context?.playerCharacter ?? ledger.find(n => (n as any).isPC);
    const pcNames = pc ? [pc.name, ...(pc.aliases || '').split(',').map((a: string) => a.trim()).filter(Boolean)] : [];
    const extracted = extractNPCNames(scene.assistantContent, pcNames);
    const { newNames, existingNpcs } = classifyNPCNames(extracted, ledger, pcNames);
    process.stdout.write(`\nscene ${SCENE}: PC flag on ${pc?.name ?? '(none)'}\n  extracted (PC excluded: ${JSON.stringify(pcNames)}): ${JSON.stringify(extracted)}\n  new: ${JSON.stringify(newNames)}\n  existing → update/backfill: ${existingNpcs.map(n => n.name).join(', ') || '(none)'}\n`);
});
