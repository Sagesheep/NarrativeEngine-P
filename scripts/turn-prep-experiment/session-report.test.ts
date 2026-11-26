// Turn Prep Experiment — what did a play session leave behind? Read-only.
//
//   CAMPAIGN=exp-c1-rebuilt SINCE=575 npx vitest run --config scripts/turn-prep-experiment/vitest.experiment.config.ts session-report
//
// Reports, for scenes after SINCE: witnesses (and where they came from), event tags and
// importance; the pending (not yet committed) turn's 👥 header and who it resolves to;
// NPC cards touched by the update / drives steps; the location ledger; agency and intro state.
// A turn is committed (archived, post-turn steps run) only when the NEXT Send is pressed.

import fs from 'fs';
import path from 'path';
import { it, vi } from 'vitest';

vi.mock('idb-keyval', () => ({ get: vi.fn(), set: vi.fn(), del: vi.fn(), keys: vi.fn(async () => []) }));

import { parsePresentHeader, resolvePresentNpcs } from '../../src/services/npc/presentHeader';
import type { NPCEntry } from '../../src/types';

const CAMPAIGN = process.env.CAMPAIGN ?? 'exp-c1-rebuilt';
const SINCE = Number(process.env.SINCE ?? 0);
const ROOT = path.resolve('data/campaigns');
const read = (suffix: string, fallback: unknown = null) => {
    const p = path.join(ROOT, `${CAMPAIGN}.${suffix}`);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback;
};

it('session report', () => {
    const out: string[] = [];
    const say = (s = '') => out.push(s);
    const index = read('archive.index.json', []) as any[];
    const npcs = read('npcs.json', []) as NPCEntry[];
    const state = read('state.json', {}) as any;
    const locations = read('locations.json', []) as any[];
    const ctx = state.context ?? {};
    const byId = new Map(npcs.map(n => [n.id, n]));

    say(`${CAMPAIGN}: ${index.length} archived scenes, ${npcs.length} NPCs, ${state.messages?.length ?? 0} messages`);

    say(`\nArchived scenes after ${SINCE}:`);
    const recent = index.filter(e => Number(e.sceneId) > SINCE);
    if (recent.length === 0) say('  (none — nothing committed since; a turn commits on the NEXT Send)');
    for (const e of recent) {
        say(`  #${e.sceneId} importance ${e.importance ?? '-'} | witnesses (${e.witnessSource ?? 'server'}): ${(e.witnesses ?? []).join(', ') || '-'}`);
        for (const ev of e.events ?? []) say(`      event [${ev.eventType}, ${ev.importance}] ${ev.text}`);
    }

    const msgs = state.messages ?? [];
    const lastGm = [...msgs].reverse().find((m: any) => m.role === 'assistant');
    if (lastGm) {
        const names = parsePresentHeader(lastGm.content ?? '');
        const present = names ? resolvePresentNpcs(names, npcs).map(n => n.name) : [];
        say(`\nLast GM reply${lastGm.pendingCommit ? ' (PENDING — not yet committed)' : ''}:`);
        say(`  👥 header: ${names === null ? '(none)' : JSON.stringify(names)}`);
        say(`  resolves to ledger NPCs: ${present.join(', ') || '(none)'}  → this is the on-stage set and the witness list it will get`);
    }

    const updated = npcs.filter(n => typeof n.lastUpdateScene === 'number' && n.lastUpdateScene > SINCE);
    const withDrives = npcs.filter(n => n.drives);
    const withWants = npcs.filter(n => (n as any).wants);
    say(`\nNPCs: updated after ${SINCE}: ${updated.map(n => `${n.name}@${n.lastUpdateScene}`).join(', ') || 'none'}`);
    say(`  with drives: ${withDrives.length} (${withDrives.slice(0, 8).map(n => n.name).join(', ')}${withDrives.length > 8 ? ', …' : ''})`);
    say(`  with agency wants: ${withWants.length}`);

    say(`\nLocations: ${locations.length} in the ledger; current place: ${ctx.currentPlaceId ? (locations.find(l => l.id === ctx.currentPlaceId)?.name ?? ctx.currentPlaceId) : '(none)'}${ctx.currentFeature ? ` / ${ctx.currentFeature}` : ''}`);
    for (const l of locations.slice(-6)) say(`  - ${l.name}${l.knowledge ? ` (${l.knowledge})` : ''}`);

    say(`\nAgency: tick ${ctx.agencyTick ?? '-'}, heartbeat DC ${ctx.agencyHeartbeatDC ?? '-'}, digest ${ctx.agencyDigest ? 'present' : 'none'}`);
    say(`Intro engine: ${ctx.npcIntroEngineActive ? 'ON' : 'off'}, ${ctx.npcIntroConfig?.characters?.length ?? 0} candidates, DC ${ctx.npcIntroDC ?? ctx.npcIntroConfig?.initialDC ?? '-'}`);
    void byId;
    process.stdout.write('\n' + out.join('\n') + '\n');
});
