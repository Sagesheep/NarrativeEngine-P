/**
 * Phase 7.9.3 — CHECKPOINT 4 · a mod claims a role. **The L4 proof.**
 *
 * The checkpoint's framing: *"This is the rehearsal for Phase 8. If a throwaway
 * mod cannot take over a role cleanly, the enemy extraction will not either."*
 * So the bar here is higher than 7.1.1's: not "the registry arbitrates
 * correctly" (that is `roleRegistry.test.ts`, on opaque ids) and not "one
 * claimant reaches the ask site" (that is `phase71RoleClaim.test.ts`), but the
 * whole six-step exercise, run the way a user would produce it.
 *
 * ┌─ WHAT IS REAL HERE ────────────────────────────────────────────────────────┐
 * │ • The loader — `loadMods()` from `server/lib/modLoader.js`, reading real   │
 * │   manifests off a real directory. Deletion in item 6 is `rm -rf` on disk.  │
 * │ • The lifecycle host — `createLifecycleHost()`, one instance across every  │
 * │   load cycle, exactly as the app has one. It owns the leases, the          │
 * │   `serviceRoles.clear()` on refresh and the revoke on disable; no test     │
 * │   here reaches into the registry to tear a claim down by hand.             │
 * │ • The mod code — the fixtures' `index.js` is loaded from the file the      │
 * │   loader validated, and its named exports are resolved against             │
 * │   `manifest.native.hooks`. Same module evaluation the browser does; the    │
 * │   filesystem instead of the asset route.                                   │
 * │ • The registry, the arbitration, the fault stores, and the ask site        │
 * │   (`gatherMemoryRecallViaRole`) with its real post-conditions.             │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Two things are stubbed, both at the archive boundary and for the same reason
 * — this suite must not need an archive server:
 *
 *   • `askDefaultMemoryRecall` — core's default provider, replaced by a marker
 *     answer. It is also the instrument for item 2: "core steps aside" is only
 *     provable by watching that core's implementation DOES NOT RUN, and a spy
 *     is the only way to watch that.
 *   • `fetchArchiveScenes` — the host's fetch, which is the assertion surface
 *     for which ids survived the post-conditions, in what order.
 *
 * Mod Management's side of item 4 (the conflict a user can see) is in
 * `src/components/settings-modal/__tests__/phase793ModManagement.test.tsx`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { loadMods } from '../../../../server/lib/modLoader.js';
import type { ArchiveIndexEntry, ArchiveScene } from '../../../types';
import type { TurnState } from '../../turn/turnOrchestrator';
import type { LifecycleMod } from '../lifecycle/lifecycleHost';
import type { ModContext } from '../modContext';
import type { LoadModHooks, ModEnablementMap, NativeModHooks } from '../lifecycle/lifecycleTypes';

// Core's default provider, stubbed to a marker. `['001']` is oldest-first and
// one scene — neither fixture can produce it, so "core answered" is legible
// from the fetched ids alone, and the spy makes "core did NOT answer" legible
// too, which is the harder half of item 2.
vi.mock('../../context-gatherer/archiveRecall', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../context-gatherer/archiveRecall')>();
    return {
        ...actual,
        askDefaultMemoryRecall: vi.fn(async () => ({ sceneIds: ['001'] })),
    };
});

// The host's fetch boundary. `ROLES.md` §6.1: the provider returns ids, the
// HOST fetches the prose.
vi.mock('../../archiveMemory', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../archiveMemory')>();
    return {
        ...actual,
        fetchArchiveScenes: vi.fn(async (_campaignId: string, sceneIds: string[]) =>
            sceneIds.map((sceneId) => ({ sceneId, content: `scene ${sceneId}` }) as unknown as ArchiveScene)),
    };
});

const { serviceRoles, configureModRoles, roleFaultStore } = await import('../../roles');
const { gatherMemoryRecallViaRole } = await import('../../turn/contextGatherer');
const { fetchArchiveScenes } = await import('../../archiveMemory');
const { askDefaultMemoryRecall } = await import('../../context-gatherer/archiveRecall');
const { createLifecycleHost } = await import('../lifecycle/lifecycleHost');
const { createLifecycleFaultStore } = await import('../lifecycle/lifecycleFaults');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_FIXTURES = path.join(HERE, 'fixtures');
const CORE_PROVIDER_ID = 'role.memory.recall.core';
const APP_VERSION = JSON.parse(
    fs.readFileSync(path.join(HERE, '..', '..', '..', '..', 'package.json'), 'utf8'),
).version as string;

/** The three mods this checkpoint drives. Every other fixture folder is ignored. */
const CLAIMANT = 'role-claimant';
const RIVAL = 'role-rival';
const FAULTY = 'role-faulty';
const ROLE_FIXTURES = [CLAIMANT, RIVAL, FAULTY] as const;

// ── The working copy ────────────────────────────────────────────────────────
//
// Item 6 deletes a mod from disk. It deletes it from a COPY outside the repo,
// because a test that `rm -rf`s a folder in `src/` is one interrupted run away
// from deleting a fixture out of the repository.
//
// `package.json` at the root of the copy marks the tree as ESM, so Node's own
// resolver loads the fixtures as modules (see `loadHooks`).

let workRoot: string;
let modsDir: string;

function copyFixtures(): void {
    for (const id of ROLE_FIXTURES) {
        fs.cpSync(path.join(SOURCE_FIXTURES, id), path.join(modsDir, id), { recursive: true });
    }
}

// ── The host ────────────────────────────────────────────────────────────────

const faultStore = createLifecycleFaultStore();
const seen = new Map<string, { lastSeenVersion: string }>();
const stateStore = {
    get: async (id: string) => seen.get(id),
    set: async (id: string, record: { lastSeenVersion: string }) => { seen.set(id, record); },
    clear: async () => { seen.clear(); },
};

/**
 * Every namespace the host actually loaded, keyed by mod id.
 *
 * This map matters more than it looks. The fixtures' ask counters have to be
 * read from **the module instance the host activated**, not from a second copy
 * this test file imported through Vite — two instances would give a counter
 * that is always zero, and item 4's "the loser is not run" would pass without
 * proving anything.
 */
const loadedNamespaces = new Map<string, Record<string, unknown>>();

/**
 * The 1.5 seam, pointed at the filesystem. The browser `import()`s the bytes
 * the asset route serves; here the same module is loaded from the file the
 * loader just validated, through Node's own resolver (`createRequire`, which
 * on Node ≥22 loads ESM) — Vite's module runner cannot resolve a path outside
 * the project root, and the point of the copy is that it is outside.
 *
 * A module is resolved ONCE per path, by Node's module cache, which is the
 * caching behaviour `nativeLoader` implements deliberately. So a fixture's
 * module state (its `unprovide` handle, its ask counter) survives a reload —
 * as it does in the app.
 */
const nodeRequire = createRequire(import.meta.url);

const loadHooks: LoadModHooks = (mod) => {
    if (!mod.native?.js || !mod.folder) return undefined;
    const abs = path.join(modsDir, mod.folder, mod.native.js);
    const ns = nodeRequire(abs) as Record<string, unknown>;
    loadedNamespaces.set(mod.id, ns);
    const hooks: Record<string, unknown> = {};
    for (const [hookName, exportName] of Object.entries(mod.native.hooks ?? {})) {
        hooks[hookName] = ns[exportName];
    }
    return hooks as NativeModHooks;
};

/** Call an exported test-surface function on the module the host loaded. */
const fromFixture = <T,>(modId: string, exportName: string, fallback: T): T => {
    const fn = loadedNamespaces.get(modId)?.[exportName];
    return typeof fn === 'function' ? (fn as () => T)() : fallback;
};

const rivalAskCount = (): number => fromFixture(RIVAL, 'rivalAskCount', 0);
const faultyAskCount = (): number => fromFixture(FAULTY, 'faultyAskCount', 0);
const resetCounters = (): void => {
    fromFixture(RIVAL, 'resetRival', undefined);
    fromFixture(FAULTY, 'resetFaulty', undefined);
};

const host = createLifecycleHost({ loadHooks, stateStore, faultStore });

/**
 * The per-mod context factory, matching what `modBootstrap` builds for a native
 * mod minus the parts a role claimant never touches (`buildModContext` needs a
 * live Zustand store; `phase71RoleClaim.test.ts` set this precedent). What
 * matters is that `ctx.roles` comes from `configureModRoles` — the production
 * factory — carrying the manifest's declared roles and the host's resolved load
 * index, so the undeclared-claim rejection and the arbitration are the real
 * ones.
 */
const ctxForMod = (mod: {
    readonly id: string;
    readonly name: string;
    readonly loadIndex?: number;
    readonly roles?: readonly string[];
}): ModContext => ({
    roles: configureModRoles({
        mod: { id: mod.id, name: mod.name },
        declaredRoles: mod.roles ?? [],
        loadIndex: mod.loadIndex ?? 0,
        faultFile: `mod:${mod.id}`,
    }),
    log: () => {},
}) as unknown as ModContext;

type LoadedMod = LifecycleMod & { readonly loadOrder: number };

function toLifecycleMod(mod: Record<string, unknown>): LoadedMod {
    return {
        id: mod.id as string,
        name: mod.name as string,
        version: mod.version as string,
        file: mod.file as string,
        dependencies: (mod.dependencies ?? {}) as Record<string, string>,
        folder: mod.folder as string,
        native: mod.native as LifecycleMod['native'],
        roles: mod.roles as readonly string[],
        loadOrder: mod.loadOrder as number,
    };
}

/**
 * One "app load": read the directory with the real loader, then run the real
 * load cycle over exactly what it returned. `userOrder` is Phase 6.2's
 * load-order override — the list the user drags in Mod Management.
 */
async function appLoad(input: {
    readonly enablement?: ModEnablementMap;
    readonly userOrder?: string[];
} = {}): Promise<{ mods: LoadedMod[]; loaderFaults: { file: string; reason: string }[] }> {
    const { mods, faults } = loadMods(modsDir, APP_VERSION, input.userOrder);
    const lifecycleMods = (mods as Record<string, unknown>[]).map(toLifecycleMod);
    await host.runLoadCycle({
        mods: lifecycleMods,
        enablement: input.enablement ?? {},
        ctxForMod,
    });
    return { mods: lifecycleMods, loaderFaults: faults as { file: string; reason: string }[] };
}

// ── The ask site ────────────────────────────────────────────────────────────

const indexEntry = (sceneId: string): ArchiveIndexEntry =>
    ({ sceneId, userSnippet: `turn ${sceneId}`, summary: '', witnesses: [] }) as unknown as ArchiveIndexEntry;

const ARCHIVE = [indexEntry('001'), indexEntry('002'), indexEntry('003')];

const stubState = (archiveIndex: readonly ArchiveIndexEntry[]): TurnState => ({
    activeCampaignId: 'campaign-1',
    input: 'what happened at the bridge?',
    messages: [],
    npcLedger: [],
    semanticFacts: [],
    archiveIndex,
    divergenceRegister: undefined,
    settings: { archiveRecallDepth: 'standard' },
} as unknown as TurnState);

/** Take the real ask through the real gather site. */
const askViaSite = (archiveIndex: readonly ArchiveIndexEntry[] = ARCHIVE) =>
    gatherMemoryRecallViaRole(stubState(archiveIndex), [], undefined, undefined, undefined, undefined, undefined);

/** The ids the host actually fetched on the Nth ask of this test. */
const fetchedIds = (n = 0): string[] | undefined => vi.mocked(fetchArchiveScenes).mock.calls[n]?.[1];

const roleFaultsFor = (modId: string) =>
    roleFaultStore.getRecords().filter((record) => record.modId === modId);

beforeAll(() => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase793-mods-'));
    modsDir = path.join(workRoot, 'mods');
    fs.mkdirSync(modsDir, { recursive: true });
    fs.writeFileSync(path.join(workRoot, 'package.json'), '{ "type": "module" }');
    copyFixtures();
});

afterAll(() => {
    fs.rmSync(workRoot, { recursive: true, force: true });
});

beforeEach(() => {
    roleFaultStore.clear();
    faultStore.clear();
    host.reset();
    resetCounters();
    vi.mocked(fetchArchiveScenes).mockClear();
    vi.mocked(askDefaultMemoryRecall).mockClear();
});

afterEach(() => {
    // The host owns teardown; the tests never revoke a claim by hand. An empty
    // load cycle is what the app does when every mod has gone away.
    serviceRoles.clear();
});

describe('Phase 7.9.3 · item 1 — a throwaway mod claims the role', () => {
    it('the three fixtures survive the real loader, and the role they declare is one the host registers', () => {
        const { mods, faults } = loadMods(modsDir, APP_VERSION);

        expect((faults as { file: string; reason: string }[]).map((f) => `${f.file}: ${f.reason}`)).toEqual([]);
        const ids = (mods as { id: string }[]).map((m) => m.id);
        expect(ids).toEqual([CLAIMANT, FAULTY, RIVAL]); // resolved order: loadOrder 10, 20, 50

        const known = serviceRoles.list().map((role) => role.id);
        for (const mod of mods as { roles?: string[] }[]) {
            for (const roleId of mod.roles ?? []) expect(known).toContain(roleId);
        }
    });

    it('declaring is not claiming — the claim arrives from activate, and the answer reaches the payload', async () => {
        // Only the claimant enabled, so this item measures one mod.
        await appLoad({ enablement: { [`mod.${RIVAL}`]: false, [`mod.${FAULTY}`]: false } });

        const active = serviceRoles.activeProviderFor('memory.recall');
        expect(active?.modId).toBe(CLAIMANT);
        expect(active?.source).toBe('mod');

        await askViaSite();

        // Reverse index order, capped at two — the fixture's marker.
        expect(fetchedIds()).toEqual(['003', '002']);
    });
});

describe('Phase 7.9.3 · item 2 — core\'s default steps aside', () => {
    beforeEach(async () => {
        await appLoad({ enablement: { [`mod.${RIVAL}`]: false, [`mod.${FAULTY}`]: false } });
    });

    it('the default is not the active provider, and exactly one implementation executes', async () => {
        expect(serviceRoles.activeProviderFor('memory.recall')?.providerId).not.toBe(CORE_PROVIDER_ID);

        await askViaSite();

        // The whole of item 2 in two assertions: the mod's answer arrived, and
        // core's implementation never ran. "The mod also ran" would show up as
        // a second fetch or a call to core's default; neither happens.
        expect(fetchedIds()).toEqual(['003', '002']);
        expect(vi.mocked(askDefaultMemoryRecall)).not.toHaveBeenCalled();
        expect(vi.mocked(fetchArchiveScenes)).toHaveBeenCalledTimes(1);
    });

    it('the default is stood aside, not deleted — it is still registered, listed and switchable', () => {
        const role = serviceRoles.list().find((candidate) => candidate.id === 'memory.recall');
        expect(role?.defaultProvider.providerId).toBe(CORE_PROVIDER_ID);
        expect(role?.defaultProvider.loadIndex).toBe(Number.POSITIVE_INFINITY);
    });
});

describe('Phase 7.9.3 · item 3 — disable the mod, core resumes with no restart', () => {
    it('the very next ask is core\'s, with no reload and no re-registration', async () => {
        const { mods } = await appLoad({ enablement: { [`mod.${RIVAL}`]: false, [`mod.${FAULTY}`]: false } });
        await askViaSite();
        expect(fetchedIds(0)).toEqual(['003', '002']);

        // The host's own disable path — the same call the Extensions toggle
        // makes. Nothing here touches `serviceRoles` directly.
        await host.disable({ mod: mods.find((m) => m.id === CLAIMANT)!, ctxForMod });

        expect(serviceRoles.activeProviderFor('memory.recall')?.providerId).toBe(CORE_PROVIDER_ID);
        await askViaSite();
        expect(fetchedIds(1)).toEqual(['001']);
        expect(vi.mocked(askDefaultMemoryRecall)).toHaveBeenCalledTimes(1);
    });
});

describe('Phase 7.9.3 · item 4 — two mods claim the same role', () => {
    it('load order decides, and the loser is never asked', async () => {
        await appLoad({ enablement: { [`mod.${FAULTY}`]: false } });

        expect(serviceRoles.activeProviderFor('memory.recall')?.modId).toBe(CLAIMANT);

        await askViaSite();

        expect(fetchedIds()).toEqual(['003', '002']);          // the winner's ranking
        expect(rivalAskCount()).toBe(0);                        // the loser did not run
        expect(vi.mocked(askDefaultMemoryRecall)).not.toHaveBeenCalled();
    });

    it('the conflict is surfaced as a fault against the loser, naming the winner', async () => {
        await appLoad({ enablement: { [`mod.${FAULTY}`]: false } });
        await askViaSite();

        expect(roleFaultsFor(RIVAL)).toEqual([expect.objectContaining({
            kind: 'conflict',
            roleId: 'memory.recall',
            winner: CLAIMANT,
        })]);
        // The winner is not faulted for winning.
        expect(roleFaultsFor(CLAIMANT)).toEqual([]);
    });

    it('it really is LOAD ORDER that decides — the user\'s 6.2 override flips the winner', async () => {
        // Same two manifests, same registry, one difference: the order the user
        // dragged them into. `ROLES.md` §4 — one ordering concept, the resolved
        // load order, and nothing else may decide this.
        await appLoad({
            enablement: { [`mod.${FAULTY}`]: false },
            userOrder: [RIVAL, CLAIMANT],
        });

        expect(serviceRoles.activeProviderFor('memory.recall')?.modId).toBe(RIVAL);

        await askViaSite();

        expect(fetchedIds()).toEqual(['001']);   // the rival's first-entry answer
        expect(rivalAskCount()).toBe(1);
        expect(roleFaultsFor(CLAIMANT)).toEqual([expect.objectContaining({
            kind: 'conflict',
            winner: RIVAL,
        })]);
    });
});

describe('Phase 7.9.3 · item 5 — the claiming mod throws', () => {
    beforeEach(async () => {
        await appLoad({ enablement: { [`mod.${CLAIMANT}`]: false, [`mod.${RIVAL}`]: false } });
        expect(serviceRoles.activeProviderFor('memory.recall')?.modId).toBe(FAULTY);
    });

    it('yields NO answer — it does not fall back to core\'s default per ask (`ROLES.md` §5)', async () => {
        const recalled = await askViaSite();

        // The ask site's absence path, not core's answer. §5.3: no-answer and
        // no-provider travel the same code path.
        expect(recalled).toBeUndefined();
        expect(vi.mocked(askDefaultMemoryRecall)).not.toHaveBeenCalled();
        expect(vi.mocked(fetchArchiveScenes)).not.toHaveBeenCalled();
        expect(faultyAskCount()).toBe(1);

        expect(roleFaultsFor(FAULTY)).toEqual([expect.objectContaining({
            kind: 'threw',
            roleId: 'memory.recall',
            strikes: 1,
            latched: false,
        })]);
    });

    it('latches the claim off on the THIRD consecutive strike, and core resumes from the next ask', async () => {
        await askViaSite();
        expect(roleFaultsFor(FAULTY)[0]).toMatchObject({ strikes: 1, latched: false });
        await askViaSite();
        expect(roleFaultsFor(FAULTY)[0]).toMatchObject({ strikes: 2, latched: false });
        await askViaSite();
        expect(roleFaultsFor(FAULTY)[0]).toMatchObject({ strikes: 3, latched: true });

        // Three breaches, three asks, zero answers — no per-ask fallback the
        // whole way down.
        expect(vi.mocked(fetchArchiveScenes)).not.toHaveBeenCalled();
        expect(vi.mocked(askDefaultMemoryRecall)).not.toHaveBeenCalled();

        // The fourth ask: the claim is latched off for the session, so core's
        // default is the active provider again and answers.
        expect(serviceRoles.activeProviderFor('memory.recall')?.providerId).toBe(CORE_PROVIDER_ID);
        await askViaSite();
        expect(fetchedIds(0)).toEqual(['001']);
        expect(faultyAskCount()).toBe(3);   // the latched provider is not asked again
    });

    /**
     * The measured correction to `ROLES.md` §5.1.
     *
     * The document says a latched claim means *"core's default becomes the
     * active provider from the next ask"*. That sentence silently assumes one
     * claimant. What the code does — and what §4 requires it to do — is
     * re-resolve the ordered list, so the next ask goes to the next ELIGIBLE
     * provider, which is another mod when one is installed. Core is the
     * provider of last resort, not the fallback.
     *
     * Recorded here rather than left in a comment because the difference is
     * invisible until two mods are installed, and Phase 8 will run with more
     * than one.
     */
    it('a latched claim demotes ONE provider — the next ask goes to the next mod in order, not to core', async () => {
        // Claimant off; faulty (loadOrder 20) wins over rival (50).
        await appLoad({ enablement: { [`mod.${CLAIMANT}`]: false } });
        expect(serviceRoles.activeProviderFor('memory.recall')?.modId).toBe(FAULTY);

        for (let i = 0; i < 3; i++) await askViaSite();

        expect(serviceRoles.activeProviderFor('memory.recall')?.modId).toBe(RIVAL);
        await askViaSite();
        expect(fetchedIds(0)).toEqual(['001']);          // the rival's answer…
        expect(rivalAskCount()).toBe(1);                  // …from the rival itself
        expect(vi.mocked(askDefaultMemoryRecall)).not.toHaveBeenCalled();
    });

    it('the mod is still there, and the latch is cleared by a disable/enable — not by a restart alone', async () => {
        for (let i = 0; i < 3; i++) await askViaSite();
        expect(serviceRoles.activeProviderFor('memory.recall')?.providerId).toBe(CORE_PROVIDER_ID);

        // `ROLES.md` §5.1: "cleared by a reload or a disable/enable".
        await appLoad({ enablement: { [`mod.${CLAIMANT}`]: false, [`mod.${RIVAL}`]: false } });
        expect(serviceRoles.activeProviderFor('memory.recall')?.modId).toBe(FAULTY);
    });
});

describe('Phase 7.9.3 · item 6 — the claiming mod is deleted mid-campaign', () => {
    it('the app recovers on the next load: core takes over, no orphan, no fault', async () => {
        await appLoad({ enablement: { [`mod.${RIVAL}`]: false, [`mod.${FAULTY}`]: false } });
        await askViaSite();
        expect(fetchedIds(0)).toEqual(['003', '002']);

        // Deleted from disk, with the app running and the claim live — the
        // "user dragged the folder to the bin mid-campaign" case. No `disable`
        // was called; nothing told the host.
        fs.rmSync(path.join(modsDir, CLAIMANT), { recursive: true, force: true });

        const { mods, loaderFaults } = await appLoad({ enablement: { [`mod.${RIVAL}`]: false, [`mod.${FAULTY}`]: false } });

        // No orphan: the loader does not know it, the host did not keep it.
        expect(mods.map((m) => m.id)).not.toContain(CLAIMANT);
        expect(serviceRoles.activeProviderFor('memory.recall')?.providerId).toBe(CORE_PROVIDER_ID);

        // No fault: a mod that is gone is not an error condition. A missing
        // folder is indistinguishable from a folder that was never there.
        expect(loaderFaults).toEqual([]);
        expect(roleFaultStore.getRecords()).toEqual([]);
        expect(faultStore.getRecords()).toEqual([]);

        // No data loss: the turn still recalls, from core's default.
        const recalled = await askViaSite();
        expect(recalled?.map((scene) => scene.sceneId)).toEqual(['001']);

        copyFixtures();   // restore for any later test in this file
    });
});

describe('Phase 7.9.3 · also verify — absence is quiet, not broken', () => {
    it('with the claim disabled AND core\'s default switched off, the ask is unanswered and silent', async () => {
        const { setRoleModuleEnabled } = await import('../../roles');
        const { mods } = await appLoad({ enablement: { [`mod.${RIVAL}`]: false, [`mod.${FAULTY}`]: false } });
        expect(serviceRoles.activeProviderFor('memory.recall')?.modId).toBe(CLAIMANT);

        await host.disable({ mod: mods.find((m) => m.id === CLAIMANT)!, ctxForMod });
        // The same switch the block view flips — `isBlockEnabled(providerId,
        // undefined, moduleEnabled)`, not a test-only backdoor.
        setRoleModuleEnabled({ [CORE_PROVIDER_ID]: false });
        try {
            expect(serviceRoles.activeProviderFor('memory.recall')).toBeUndefined();

            const recalled = await askViaSite();

            expect(recalled).toBeUndefined();
            expect(vi.mocked(fetchArchiveScenes)).not.toHaveBeenCalled();
            expect(vi.mocked(askDefaultMemoryRecall)).not.toHaveBeenCalled();
            // Quiet: nobody home is not a breach.
            expect(roleFaultStore.getRecords().filter((r) => r.roleId === 'memory.recall')).toEqual([]);
        } finally {
            setRoleModuleEnabled(undefined);
        }
        // That the turn still BUILDS A PAYLOAD AND COMMITS in this state is
        // Phase 7.5's own gate, run against the real `runTurn` +
        // `commitPendingTurn` on the base-app fixture:
        // `src/services/turn/__tests__/baseAppGate/coreSurvivesAbsence.test.ts`.
    });
});
