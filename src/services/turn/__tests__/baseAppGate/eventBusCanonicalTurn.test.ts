// Phase 3.2 — the fixture mod, over a full canonical turn.
//
// 3.2 §5 done-when: *"Every event in `EVENTS.md` fires, proven by a fixture mod
// that logs all of them across a full turn."* This is that fixture. It
// subscribes to all twenty names on the real singleton bus and then runs the
// REAL `runTurn` + REAL `commitPendingTurn` + REAL `runPostTurnPipeline` through
// the Phase 0.5 canonical harness — the same harness the base-app gate uses, so
// the turn it observes is the turn the gate is a baseline of.
//
// The second test is the load-bearing one. §3 of the phase brief:
//
// > **Emitting an event must not change what the app does.** With zero mods
// > installed, behaviour before and after this phase is identical.
//
// The gate itself proves that with zero listeners. This proves the stronger
// claim — that the trace is byte-identical WITH a listener attached to every
// event, i.e. that emitting is observation and nothing else.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { runCanonicalTurn } from './runCanonicalTurn';
import { postTurnTracks } from '../../tracks';
import { modEventBus, eventFaultStore, CORE_EVENT_NAMES } from '../../../mods/events';
import type { ModEventOwner } from '../../../mods/events';
import { FIXTURE_CAMPAIGN_ID, FIXTURE_SCENE_ID } from './fixture';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(HERE, 'baseline.json');

const FIXTURE_MOD: ModEventOwner = {
    modId: 'event-log-fixture',
    modName: 'Event Log Fixture',
    file: 'event-log-fixture.mod.json',
};

type LoggedEvent = { name: string; payload: Record<string, unknown> };

/**
 * The fixture mod: one listener per core event, each logging what it was handed.
 * This is exactly the shape Phase 3.3's `ctx.events.on()` will hand a real mod —
 * the bus is the same singleton, and the owner record is what the lifecycle host
 * will pass from the mod's identity.
 */
function subscribeFixtureMod(log: LoggedEvent[]): () => void {
    const offs = CORE_EVENT_NAMES.map((name) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        modEventBus.on(name as any, (payload: unknown) => {
            log.push({ name, payload: payload as Record<string, unknown> });
        }, FIXTURE_MOD),
    );
    return () => { for (const off of offs) off(); };
}

describe('Phase 3.2 — a fixture mod sees the canonical turn', () => {
    beforeEach(() => {
        modEventBus.disposeModListeners(FIXTURE_MOD.modId);
        eventFaultStore.clear();
        for (const track of postTurnTracks.list()) {
            if (track.id.startsWith('mod.') && track.id.endsWith('.compute')) {
                postTurnTracks.unregister(track.id);
            }
        }
    });

    afterEach(() => {
        modEventBus.disposeModListeners(FIXTURE_MOD.modId);
        modEventBus.reset();
        eventFaultStore.clear();
    });

    it('fires the §7.2 canonical sequence, in order, with the documented payloads', async () => {
        const log: LoggedEvent[] = [];
        const unsubscribe = subscribeFixtureMod(log);
        try {
            await runCanonicalTurn();
        } finally {
            unsubscribe();
        }

        const names = log.map(e => e.name);

        // `EVENTS.md` §7.2 — send N, then the commit for N (which the harness
        // drives directly, standing in for "the send of N+1").
        expect(names).toEqual([
            'turn.start',
            'turn.payloadBuilt',
            'turn.generated',
            'archive.sceneAppended',
            'turn.committed',
        ]);

        const byName = Object.fromEntries(log.map(e => [e.name, e.payload]));

        // §7.1 — one correlation key, the same across the whole turn, and it
        // survives the commit boundary via the pending snapshot.
        const turnId = byName['turn.start'].turnId as string;
        expect(turnId).toBeTruthy();
        expect(byName['turn.payloadBuilt'].turnId).toBe(turnId);
        expect(byName['turn.generated'].turnId).toBe(turnId);
        expect(byName['turn.committed'].turnId).toBe(turnId);

        // §6.3 — `playerInput` is the raw text; `tier` is the setting.
        expect(byName['turn.start'].campaignId).toBe(FIXTURE_CAMPAIGN_ID);
        expect(typeof byName['turn.start'].playerInput).toBe('string');

        // §6.3 — `tokenEstimate` summed from the trace, `messageCount` the
        // assembled payload's length. Both non-zero for a real turn.
        expect(byName['turn.payloadBuilt'].messageCount).toBeGreaterThan(0);
        expect(byName['turn.payloadBuilt'].tokenEstimate).toBeGreaterThan(0);

        // §6.3 — the GM reply, stakes stripped, at the instant it becomes mutable.
        expect(byName['turn.generated'].messageId).toBeTruthy();
        expect(typeof byName['turn.generated'].text).toBe('string');
        expect(['calm', 'tense', 'dangerous']).toContain(byName['turn.generated'].sceneStakes);

        // §6.5 — the scene is in long-term memory, and the fresh index landed.
        expect(byName['archive.sceneAppended'].sceneId).toBe(FIXTURE_SCENE_ID);
        expect(byName['archive.sceneAppended'].messageId).toBe(byName['turn.generated'].messageId);

        // §6.6 — `turn.committed` carries the sceneId too, so a mod that needs
        // both "the scene id" and "this turn is settled" subscribes to one event.
        expect(byName['turn.committed'].sceneId).toBe(FIXTURE_SCENE_ID);
        expect(byName['turn.committed'].messageId).toBe(byName['turn.generated'].messageId);
        expect(byName['turn.committed'].campaignId).toBe(FIXTURE_CAMPAIGN_ID);

        // §3 — every payload handed out is frozen.
        for (const entry of log) {
            expect(Object.isFrozen(entry.payload)).toBe(true);
        }

        // A well-behaved fixture produces no faults.
        expect(eventFaultStore.getRecords()).toEqual([]);
    });

    it('changes nothing: the trace is byte-identical to the baseline WITH listeners attached', async () => {
        const log: LoggedEvent[] = [];
        const unsubscribe = subscribeFixtureMod(log);
        let serialized: string;
        try {
            const result = await runCanonicalTurn();
            serialized = JSON.stringify(result.trace, null, 0);
        } finally {
            unsubscribe();
        }

        // The listeners really did run — otherwise this proves nothing.
        expect(log.length).toBeGreaterThan(0);
        expect(serialized).toBe(readFileSync(BASELINE_PATH, 'utf-8'));
    });

    it('a throwing listener produces a fault and the turn still completes and commits', async () => {
        // §4.3 — this is the condition the two commit-path emits ship on. A
        // listener that throws inside `archive.sceneAppended` sits inside
        // `runArchiveTrack`'s `try`; without per-listener containment it would
        // turn a successful append into `archived: false` and the turn would
        // never retire.
        const log: LoggedEvent[] = [];
        const offs = CORE_EVENT_NAMES.map((name) =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            modEventBus.on(name as any, () => {
                log.push({ name, payload: {} });
                throw new Error(`listener for ${name} is broken`);
            }, FIXTURE_MOD),
        );

        let serialized: string;
        try {
            const result = await runCanonicalTurn();
            serialized = JSON.stringify(result.trace, null, 0);
        } finally {
            for (const off of offs) off();
        }

        // The turn ran to completion and committed: the trace is still the
        // baseline, which includes the archive append and the retire.
        expect(serialized).toBe(readFileSync(BASELINE_PATH, 'utf-8'));
        expect(log.map(e => e.name)).toEqual([
            'turn.start',
            'turn.payloadBuilt',
            'turn.generated',
            'archive.sceneAppended',
            'turn.committed',
        ]);

        // §5.3 — surfaced as a fault naming the mod and the event, in the shape
        // the Extensions list renders.
        const records = eventFaultStore.getRecords();
        expect(records).toHaveLength(1);
        expect(records[0].modId).toBe(FIXTURE_MOD.modId);
        expect(records[0].reason).toMatch(/^Event Log Fixture: listener for "turn\.committed" threw \(/);
        expect(eventFaultStore.getFaults()[0].file).toBe(FIXTURE_MOD.file);
    });
});
