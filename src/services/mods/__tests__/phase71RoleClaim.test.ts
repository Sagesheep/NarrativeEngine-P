/**
 * Phase 7.1.1 — a mod claims `memory.recall`, end to end.
 *
 * The gap this closes, recorded in `PROGRESS.md`'s 7.1.1 entry and `ROLES.md`
 * §13: the registry-level tests proved arbitration, no-fallback and latching,
 * but nothing proved the WIRING — manifest → real loader → `activate` →
 * `ctx.roles.provide` → registry → the real ask site. That is the path the
 * previous epic's worst defect lived on: `arc.mod.json` was rejected by the
 * loader from the day it shipped and stayed green in 46 tests, because every
 * one of them exercised the logic directly and none reached the loader
 * (`server/__tests__/shippedModsLoad.test.ts`'s own preamble).
 *
 * So this file drives the SHIPPED fixture through the REAL loader and the REAL
 * registry into the REAL ask site — the same discipline `phase54Facts.test.ts`
 * established for facts: the fixture is imported, never reimplemented, so a
 * drift between the mod and the host is caught here rather than in a copy.
 *
 * The fixture lives in `__tests__/fixtures/`, NOT in `mods/`. `mods/` is the
 * installed set, the running app loads it live, and enablement is
 * absent-means-enabled (`modBootstrap.ts:248-262`) — a role claimant shipped
 * there would replace real users' memory recall on the next load.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadMods } from '../../../../server/lib/modLoader.js';
import type { ArchiveIndexEntry, ArchiveScene } from '../../../types';
import type { TurnState } from '../../turn/turnOrchestrator';

// Core's default provider is stubbed to a marker so "core answered" is
// observable without reaching the archive server. Everything else in
// `archiveRecall` — the input builder, the chapter projection, the exclude-set
// builder — stays real.
vi.mock('../../context-gatherer/archiveRecall', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../context-gatherer/archiveRecall')>();
    return {
        ...actual,
        // Oldest-first, one scene: the opposite of the fixture's reversal, so
        // "which provider answered" is legible from the fetched ids alone.
        askDefaultMemoryRecall: vi.fn(async () => ({ sceneIds: ['001'] })),
    };
});

// The host's fetch boundary. `ROLES.md` §6.1: the provider returns ids, the
// HOST fetches the prose — so this spy is exactly the assertion surface for
// "which ids survived the post-conditions, in what order".
vi.mock('../../archiveMemory', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../archiveMemory')>();
    return {
        ...actual,
        fetchArchiveScenes: vi.fn(async (_campaignId: string, sceneIds: string[]) =>
            sceneIds.map((sceneId) => ({ sceneId, content: `scene ${sceneId}` }) as unknown as ArchiveScene)),
    };
});

const { serviceRoles, configureModRoles, checkModRoles, enableModRoles, disableModRoles, roleFaultStore } =
    await import('../../roles');
const { gatherMemoryRecallViaRole } = await import('../../turn/contextGatherer');
const { fetchArchiveScenes } = await import('../../archiveMemory');
const { onActivate, onDisable } = await import('./fixtures/role-claimant/index.js');
const fixtureManifest = JSON.parse(
    fs.readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'role-claimant', 'manifest.json'),
        'utf8',
    ),
) as { id: string; roles: string[]; loadOrder: number; name: string };

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const CORE_PROVIDER_ID = 'role.memory.recall.core';

const indexEntry = (sceneId: string): ArchiveIndexEntry =>
    ({ sceneId, userSnippet: `turn ${sceneId}`, summary: '', witnesses: [] }) as unknown as ArchiveIndexEntry;

/** A `TurnState` carrying only what the ask site reads. */
const stubState = (archiveIndex: ArchiveIndexEntry[]): TurnState => ({
    activeCampaignId: 'campaign-1',
    input: 'what happened at the bridge?',
    messages: [],
    npcLedger: [],
    semanticFacts: [],
    archiveIndex,
    divergenceRegister: undefined,
    settings: { archiveRecallDepth: 'standard' },
} as unknown as TurnState);

/** Activate the fixture the way `lifecycleHost` does: lease, then context, then hook. */
function activateFixture(): void {
    enableModRoles(fixtureManifest.id);
    const roles = configureModRoles({
        mod: { id: fixtureManifest.id, name: fixtureManifest.name },
        declaredRoles: fixtureManifest.roles,
        loadIndex: fixtureManifest.loadOrder,
        faultFile: `mod:${fixtureManifest.id}`,
    });
    onActivate({ roles, log: () => {} });
}

const askViaSite = (archiveIndex: ArchiveIndexEntry[], excludeSceneIds?: Set<string>) =>
    gatherMemoryRecallViaRole(stubState(archiveIndex), [], undefined, undefined, excludeSceneIds, undefined, undefined);

beforeEach(() => {
    roleFaultStore.clear();
    vi.mocked(fetchArchiveScenes).mockClear();
});

afterEach(() => {
    onDisable({ log: () => {} });
    disableModRoles(fixtureManifest.id);
});

describe('Phase 7.1.1 — a mod claims memory.recall', () => {
    it('the fixture manifest survives the REAL loader with zero faults', () => {
        const appVersion = JSON.parse(fs.readFileSync(
            path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'package.json'),
            'utf8',
        )).version as string;

        const { mods, faults } = loadMods(FIXTURES_DIR, appVersion);

        expect(faults.map((f: { file: string; reason: string }) => `${f.file}: ${f.reason}`)).toEqual([]);
        const claimant = mods.find((m: { id: string }) => m.id === fixtureManifest.id);
        expect(claimant, 'the loader must return the claimant').toBeDefined();
        expect(claimant.roles).toEqual(['memory.recall']);
    });

    it('every role the manifest declares is a role the host actually registers', () => {
        const known = serviceRoles.list().map((role) => role.id);
        for (const roleId of fixtureManifest.roles) expect(known).toContain(roleId);
    });

    it('core answers before the claim, and the claimant answers after it', async () => {
        const archiveIndex = [indexEntry('001'), indexEntry('002'), indexEntry('003')];

        expect(serviceRoles.activeProviderFor('memory.recall')?.providerId).toBe(CORE_PROVIDER_ID);

        activateFixture();

        const active = serviceRoles.activeProviderFor('memory.recall');
        expect(active?.modId, 'the claim must displace core, not run beside it').toBe(fixtureManifest.id);
        expect(active?.source).toBe('mod');

        await askViaSite(archiveIndex);

        // Reverse index order, capped at two — the fixture's marker. Core's
        // stub would have produced ['CORE-ANSWER'].
        expect(vi.mocked(fetchArchiveScenes).mock.calls[0]?.[1]).toEqual(['003', '002']);
    });

    it('disabling the claimant restores core on the next ask, with no restart', async () => {
        activateFixture();
        await askViaSite([indexEntry('001'), indexEntry('002')]);
        expect(vi.mocked(fetchArchiveScenes).mock.calls[0]?.[1]).toEqual(['002', '001']);

        onDisable({ log: () => {} });
        disableModRoles(fixtureManifest.id);

        expect(serviceRoles.activeProviderFor('memory.recall')?.providerId).toBe(CORE_PROVIDER_ID);
        await askViaSite([indexEntry('001'), indexEntry('002')]);

        // Core's ranking, not the fixture's reversal — and on the very next
        // ask, with no restart and no reload.
        expect(vi.mocked(fetchArchiveScenes).mock.calls[1]?.[1]).toEqual(['001']);
    });

    it('applies the host post-conditions to the claimant answer, in order', async () => {
        activateFixture();

        // The provider answers ['003','002'] (reverse, capped at 2). '003' is in
        // the turn's exclude set — already verbatim in-window — so the host drops
        // it SILENTLY: that is core's own dedup, not a contract breach. The
        // unknown-id half of the post-conditions is the next test.
        const archiveIndex = [indexEntry('001'), indexEntry('002'), indexEntry('003')];
        await askViaSite(archiveIndex, new Set(['003']));

        expect(vi.mocked(fetchArchiveScenes).mock.calls[0]?.[1]).toEqual(['002']);
        expect(roleFaultStore.getRecords().some((r) => r.kind === 'partial'),
            'an excluded id is the host\'s own dedup, not a contract breach — it must NOT fault').toBe(false);
    });

    it('faults an id the index does not know, and keeps the rest', async () => {
        enableModRoles('ghost-mod');
        const roles = configureModRoles({
            mod: { id: 'ghost-mod', name: 'Ghost' },
            declaredRoles: ['memory.recall'],
            loadIndex: 0,
            faultFile: 'mod:ghost-mod',
        });
        roles.provide('memory.recall', () => ({ sceneIds: ['001', 'NOPE'] }) as never);

        await askViaSite([indexEntry('001')]);

        expect(vi.mocked(fetchArchiveScenes).mock.calls[0]?.[1]).toEqual(['001']);
        expect(roleFaultStore.getRecords()).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'partial', roleId: 'memory.recall' }),
        ]));
        disableModRoles('ghost-mod');
    });

    it('rejects a provide() the manifest never declared, leaving core active', () => {
        enableModRoles('undeclared-mod');
        const roles = configureModRoles({
            mod: { id: 'undeclared-mod', name: 'Undeclared' },
            declaredRoles: [],
            loadIndex: 0,
            faultFile: 'mod:undeclared-mod',
        });
        roles.provide('memory.recall', () => ({ sceneIds: ['999'] }) as never);

        expect(serviceRoles.activeProviderFor('memory.recall')?.providerId).toBe(CORE_PROVIDER_ID);
        expect(roleFaultStore.getRecords()).toEqual(expect.arrayContaining([
            expect.objectContaining({ modId: 'undeclared-mod', kind: 'undeclared' }),
        ]));
        disableModRoles('undeclared-mod');
    });

    it('faults a declared role that activate never provided, leaving core active', () => {
        enableModRoles('lazy-mod');
        configureModRoles({
            mod: { id: 'lazy-mod', name: 'Lazy' },
            declaredRoles: ['memory.recall'],
            loadIndex: 0,
            faultFile: 'mod:lazy-mod',
        });
        checkModRoles({
            mod: { id: 'lazy-mod', name: 'Lazy' },
            declaredRoles: ['memory.recall'],
            faultFile: 'mod:lazy-mod',
        });

        expect(serviceRoles.activeProviderFor('memory.recall')?.providerId).toBe(CORE_PROVIDER_ID);
        expect(roleFaultStore.getRecords()).toEqual(expect.arrayContaining([
            expect.objectContaining({ modId: 'lazy-mod', kind: 'unprovided' }),
        ]));
        disableModRoles('lazy-mod');
    });
});
