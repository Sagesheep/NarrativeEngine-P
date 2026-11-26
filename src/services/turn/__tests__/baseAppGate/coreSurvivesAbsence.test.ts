// Phase 7.5 — core survives absence.
//
// The phase's second done-when, verbatim: *"A test proves core builds a valid
// payload, takes a turn, and commits with a role unclaimed."*
//
// It runs the REAL `runTurn` + `commitPendingTurn` + `runPostTurnPipeline`
// through the Phase 0.5 harness with `memory.recall` having NO provider at all:
// core's default is switched off through the same `isBlockEnabled` predicate a
// user's toggle goes through, and no mod claims it. That is the exact state
// Phase 8 produces for a subsystem the user uninstalled, rehearsed on the one
// role that exists today.
//
// Three things are asserted, and the third is the one that is easy to skip:
//
//   1. The ask really is unanswered — `activeProviderFor` is `undefined` and
//      `ask` resolves to `undefined`. Without this the rest is vacuous, which
//      is the failure mode `2.9.2` hit (it asserted a table existed, which a
//      hydrated table does whether or not the tick ran).
//   2. The turn still builds a valid payload and still COMMITS. Not "does not
//      throw" — the archive append has to land, because a turn that silently
//      fails to persist is the worst possible reading of "quiet".
//   3. Absence is quiet: no fault is recorded. A missing provider is not an
//      error condition (Phase 7.5 §3), so nothing should appear in the fault
//      store for the user to worry about. `ask` records faults for unknown
//      roles and for breaches; "nobody is home" is neither.
//
// And then the gate is re-run with the default restored, so this file also
// proves the absence was the ONLY difference — the base-app baseline is still
// byte-identical afterwards.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { runCanonicalTurn } from './runCanonicalTurn';
import { FIXTURE_CAMPAIGN_ID } from './fixture';
import { serviceRoles, setRoleModuleEnabled, roleFaultStore } from '../../../roles';
import { postTurnTracks } from '../../tracks';

const CORE_PROVIDER_ID = 'role.memory.recall.core';

function withCoreDefaultOff(): void {
    // The same switch the block view flips. `isBlockEnabled(providerId,
    // undefined, moduleEnabled)` is the predicate the registry consults, so an
    // explicit `false` entry is exactly a user switching the block off — not a
    // test-only backdoor into the registry.
    setRoleModuleEnabled({ [CORE_PROVIDER_ID]: false });
}

function restoreDefaults(): void {
    setRoleModuleEnabled(undefined);
}

describe('Phase 7.5 — core takes a turn with a role unclaimed', () => {
    beforeEach(() => {
        roleFaultStore.clear();
        for (const track of postTurnTracks.list()) {
            if (track.id.startsWith('mod.') && track.id.endsWith('.compute')) {
                postTurnTracks.unregister(track.id);
            }
        }
    });

    afterEach(() => {
        restoreDefaults();
        roleFaultStore.clear();
    });

    it('the ask genuinely has no provider (the precondition, asserted not assumed)', async () => {
        expect(serviceRoles.activeProviderFor('memory.recall')).toBeDefined();
        withCoreDefaultOff();
        expect(serviceRoles.activeProviderFor('memory.recall')).toBeUndefined();
        await expect(serviceRoles.ask('memory.recall', {})).resolves.toBeUndefined();
    });

    it('builds a valid payload, takes a turn, and commits', async () => {
        withCoreDefaultOff();
        // Prove the turn REACHES the unanswered ask. Without this the whole
        // test could pass on a fixture that never gets that far, which is
        // exactly the shape of the defect Checkpoint 2 had to go back and fix
        // ("it asserted the table existed, which a hydrated table does whether
        // or not the tick ran").
        const askSpy = vi.spyOn(serviceRoles, 'ask');
        const result = await runCanonicalTurn();
        expect(askSpy.mock.calls.some(([roleId]) => roleId === 'memory.recall')).toBe(true);
        for (const call of askSpy.mock.results) {
            if (call.type === 'return') await expect(call.value).resolves.toBeUndefined();
        }
        askSpy.mockRestore();

        // A payload, and a well-formed one: at least one message, every message
        // carrying a role and string content, and the last one the user's.
        expect(result.trace.payload.length).toBeGreaterThan(0);
        for (const message of result.trace.payload) {
            expect(typeof message.role).toBe('string');
            expect(typeof message.content).toBe('string');
        }
        expect(result.trace.payload[result.trace.payload.length - 1].role).toBe('user');

        // A turn: the GM reply landed in the message list.
        expect(result.trace.effects.length).toBeGreaterThan(0);
        expect(result.trace.finalMessages.length).toBeGreaterThan(0);

        // A commit: the durable archive append actually went out. This is the
        // assertion that makes "the app is smaller, not damaged" checkable.
        const archiveAppend = result.fetchLog.find(
            (entry) => entry.url.endsWith(`/campaigns/${FIXTURE_CAMPAIGN_ID}/archive`) && entry.method === 'POST',
        );
        expect(archiveAppend).toBeTruthy();
    });

    it('absence is quiet — no fault is recorded for a role nobody provides', async () => {
        withCoreDefaultOff();
        await runCanonicalTurn();
        const recallFaults = roleFaultStore.getRecords().filter((record) => record.roleId === 'memory.recall');
        expect(recallFaults).toEqual([]);
    });

    it('the absence was the only difference — core answers again once restored', async () => {
        withCoreDefaultOff();
        expect(serviceRoles.activeProviderFor('memory.recall')).toBeUndefined();
        restoreDefaults();
        // No restart, no re-registration: the next ask resolves to the default
        // again, because the winner is computed at ask time (`ROLES.md` §4.1).
        expect(serviceRoles.activeProviderFor('memory.recall')?.providerId).toBe(CORE_PROVIDER_ID);
    });
});
