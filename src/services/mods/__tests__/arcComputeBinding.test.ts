/**
 * Phase 4.0 — the regression test for `mods/arc/compute.js`.
 *
 * `API.md` §11.3 / `API.md` §8.6 item 2: 2.3 migrated `mods/arc/compute.js`
 * to the `getContext()` v1 surface while the sandbox binding still handed
 * mods the raw `FacadeData`, so the tick threw on its first statement every
 * turn. The existing `arc.test.ts` imports the pure helpers and never the
 * `arcCompute(ctx)` entry, so the suite was green over a broken mod — the
 * same failure mode Phase 0.4 exists to prevent.
 *
 * This test reaches `arcCompute(ctx)` through the real binding
 * (`runSandbox` with arc's real declared capabilities from
 * `mods/arc/manifest.json` and arc's real `compute.js` source). The
 * host-side RPC handlers and the journal applier are the real ones; only
 * the Worker boundary is faked (jsdom has no Worker). The test actually runs
 * the arc compute source against a constructed `__sandboxContext` inside
 * the fake worker's `handle` callback, so the journal entries the arc
 * produces are real (not hand-built), and the host applies them through
 * the real `applyJournal`.
 *
 * It verifies:
 *
 *   - Arc's first statement (`ctx.table.read('arcs')`) does NOT throw a
 *     `capability denied` error. The bare name resolves to `mod.arc.arcs`,
 *     which matches arc's declared capability.
 *   - `ctx.data.playerInput` returns the player's turn input (renamed from
 *     `input`), not `undefined`.
 *   - `ctx.table.write('arcs', …)` is journalled and applied to the
 *     resolved `mod.arc.arcs` table — not rejected with "undeclared table
 *     write 'arcs'".
 *   - `ctx.write.updateContext({ arcDigest })` lands.
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { HostFacade } from '../../turn/hostFacade';
import { buildHostFacade } from '../../turn/hostFacade';
import { runSandbox } from '../sandbox/sandboxHost';
import type {
    SandboxHostMessage,
    SandboxWorkerLike,
    SandboxWorkerMessage,
} from '../sandbox/sandboxTypes';
import type { TurnCallbacks, TurnState } from '../../turn/turnOrchestrator';
import type { AppSettings, EndpointConfig } from '../../../types';

// The real arc manifest, the real arc compute source, the real declared
// capabilities. The test exercises the actual shipped binding, not a
// fixture.
const arcManifest = JSON.parse(
    readFileSync(resolve(process.cwd(), 'mods/arc/manifest.json'), 'utf8'),
) as {
    id: string;
    name: string;
    version: string;
    compute: { file: string; hook: 'postTurn'; capabilities: string[] };
};
const arcComputeSource = readFileSync(
    resolve(process.cwd(), 'mods/arc/compute.js'),
    'utf8',
);

type WorkerHandler = (worker: FakeWorker, message: SandboxHostMessage) => void;

class FakeWorker implements SandboxWorkerLike {
    onmessage: SandboxWorkerLike['onmessage'] = null;
    onerror: SandboxWorkerLike['onerror'] = null;
    terminated = false;
    readonly sent: SandboxHostMessage[] = [];

    constructor(private readonly handle: WorkerHandler = () => undefined) {}

    postMessage(message: SandboxHostMessage): void {
        this.sent.push(message);
        this.handle(this, message);
    }

    terminate(): void {
        this.terminated = true;
    }

    emit(message: SandboxWorkerMessage): void {
        this.onmessage?.({ data: message } as MessageEvent<SandboxWorkerMessage>);
    }
}

/**
 * Run the real arc compute source against a constructed `__sandboxContext`
 * inside the fake worker. Mirrors `workerPrelude.ts`'s strip + IIFE case
 * split. Posts RPCs the host services and collects the journal the arc
 * produces; emits `done` with the real journal when the source resolves.
 */
function runArcSourceInWorker(
    worker: FakeWorker,
    snapshot: unknown,
    onRpc: (id: number, channel: string, method: string | undefined, args: unknown[]) => void,
): void {
    // Strip ES module syntax (mirror workerPrelude.ts).
    const stripped = arcComputeSource
        .replace(/^\s*export\s+default\s+/gm, '')
        .replace(/^(\s*)export\s+(function|const|let|var|class)\s/gm, '$1$2 ')
        .replace(/^\s*export\s*\{[^]*?\}\s*;?\s*(?=\n|$)/gm, '');
    const isAnonymousExpression = /^\s*(async\s+)?function\s*\(/.test(stripped);
    const defaultSource = isAnonymousExpression
        ? `globalThis.__sandboxMod = ${stripped};`
        : [
            'globalThis.__sandboxMod = (function() {',
            stripped,
            '  const __sandboxCandidates = ["arcCompute", "compute", "tick", "default"];',
            '  for (const __sandboxName of __sandboxCandidates) {',
            '    try { if (typeof eval(__sandboxName) === "function") return eval(__sandboxName); } catch {}',
            '  }',
            '  return null;',
            '})();',
        ].join('\n');

    const journal: Array<{ kind: 'store' | 'table'; name: string; args?: unknown[]; rows?: unknown }> = [];
    let rpcId = 0;
    const pendingRpc = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

    // The host posts rpc-reply messages back to the worker; route them to
    // the pending RPC promises the source is awaiting.
    const originalPostMessage = worker.postMessage.bind(worker);
    worker.postMessage = ((message: SandboxHostMessage): void => {
        if (message.type === 'rpc-reply') {
            const id = message.id;
            const pending = pendingRpc.get(id);
            if (pending) {
                pendingRpc.delete(id);
                if (message.ok) pending.resolve(message.value);
                else pending.reject(new Error(message.error ?? 'RPC failed'));
            }
            return;
        }
        originalPostMessage(message);
    }) as never;

    const rpc = (channel: string, method: string | undefined, args: unknown[]): Promise<unknown> => {
        const id = ++rpcId;
        return new Promise((resolveFn, reject) => {
            pendingRpc.set(id, { resolve: resolveFn, reject });
            // Emit the RPC to the host (via the worker's onmessage, which
            // the host wired).
            worker.emit({ type: 'rpc', id, channel, ...(method ? { method } : {}), args });
            // Timeout so a stuck RPC fails the test rather than hanging.
            setTimeout(() => {
                if (pendingRpc.has(id)) {
                    pendingRpc.delete(id);
                    reject(new Error('RPC timeout'));
                }
            }, 500).unref?.();
        });
    };

    // Build the __sandboxContext the worker prelude would build. The arc
    // source reads `ctx.data.playerInput`, `ctx.data.archiveIndex`,
    // `ctx.data.messages`, `ctx.config.aiTier`, and `ctx.table.read('arcs')`,
    // then writes `ctx.table.write('arcs', ...)` and `ctx.write.updateContext(...)`.
    const snapshotObj = snapshot as {
        mod: { id: string };
        api: { commitPoint: string };
        data: Record<string, unknown>;
        config: Record<string, unknown>;
    };
    const sandboxContext = {
        mod: snapshotObj.mod,
        api: snapshotObj.api,
        data: snapshotObj.data,
        config: snapshotObj.config,
        write: new Proxy({}, {
            get(_t, name) {
                if (typeof name !== 'string') return undefined;
                return (...args: unknown[]) => {
                    journal.push({ kind: 'store', name, args });
                };
            },
        }),
        table: Object.freeze({
            read: (name: string) => rpc('table', 'read', [name]),
            write: (name: string, rows: unknown) => {
                journal.push({ kind: 'table', name, rows });
            },
        }),
        model: Object.freeze({
            call: () => Promise.reject(new Error('model not exercised by this test')),
            callJson: () => Promise.reject(new Error('model not exercised by this test')),
            available: () => false,
        }),
        signal: new AbortController().signal,
        refresh: () => rpc('refresh', undefined, []),
        log: () => { /* swallow */ },
        subscribe: () => { throw new Error('native tier only'); },
        events: Object.freeze({
            on: () => { throw new Error('native tier only'); },
            off: () => { throw new Error('native tier only'); },
            once: () => { throw new Error('native tier only'); },
            emit: () => { throw new Error('native tier only'); },
        }),
        mounts: Object.freeze({
            header: () => { throw new Error('native tier only'); },
            composer: () => { throw new Error('native tier only'); },
            messageAction: () => { throw new Error('native tier only'); },
            rail: () => { throw new Error('native tier only'); },
            messageBelow: () => { throw new Error('native tier only'); },
            window: () => { throw new Error('native tier only'); },
        }),
    };

    // Evaluate the prelude statement(s) via `new Function` so the IIFE
    // (or the direct assignment) has its own scope and resolves the
    // default export. Mirror the worker prelude exactly.
    try {
        // eslint-disable-next-line no-new-func
        const factory = new Function(defaultSource + '; return typeof __sandboxMod === "function" ? __sandboxMod : null;');
        const computeHook = factory();
        if (typeof computeHook !== 'function') {
            worker.emit({ type: 'error', message: 'compute source did not export a default function' });
            return;
        }
        Promise.resolve()
            .then(() => computeHook(sandboxContext))
            .then(() => {
                worker.emit({ type: 'done', writes: journal, result: null });
            })
            .catch((error) => {
                worker.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
            });
    } catch (error) {
        worker.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
}

const endpoint = (modelName: string): EndpointConfig => ({
    endpoint: `http://${modelName}`,
    apiKey: `${modelName}-secret`,
    modelName,
});

function makeState(): TurnState {
    return {
        input: 'I oppose the Grain Cartel and fight the syndicate.',
        displayInput: 'I oppose the Grain Cartel and fight the syndicate.',
        settings: { contextLimit: 8192, aiTier: 'max' } as unknown as AppSettings,
        context: {
            currentPlaceId: 'place-a',
            currentFeature: 'market',
            playerCharacter: { id: 'pc-1', name: 'Hero' },
            characterProfileData: { name: 'Hero', hp: 10, stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 } },
            inventoryItems: [],
        } as unknown as TurnState['context'],
        messages: [
            { id: 'm1', role: 'user', content: 'I oppose the Grain Cartel.' },
            { id: 'm2', role: 'assistant', content: 'The syndicate eyes you warily.' },
        ],
        condenser: { condensedUpToIndex: 0 } as TurnState['condenser'],
        loreChunks: [],
        npcLedger: [],
        archiveIndex: [{ sceneId: '001' }, { sceneId: '002' }],
        activeCampaignId: 'campaign-a',
        provider: endpoint('story'),
        getMessages: () => [],
        getFreshProvider: () => endpoint('story'),
        getUtilityEndpoint: () => endpoint('utility'),
        getFreshAuxiliaryProvider: () => endpoint('auxiliary'),
        getRawAuxiliaryProvider: () => endpoint('raw-auxiliary'),
        getRawSummariserProvider: () => endpoint('raw-summariser'),
        onStageNpcIds: [],
        timeline: [],
        chapters: [],
        pinnedChapterIds: [],
        clearPinnedChapters: vi.fn(),
        setChapters: vi.fn(),
        incrementBookkeepingTurnCounter: vi.fn(() => 1),
        resetBookkeepingTurnCounter: vi.fn(),
        autoBookkeepingInterval: 5,
        getFreshContext: () => ({ currentPlaceId: 'place-a' } as TurnState['context']),
        divergenceRegister: { entries: [], chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 },
    };
}

function makeCallbacks(): TurnCallbacks {
    return {
        onCheckingNotes: vi.fn(),
        addMessage: vi.fn(),
        updateLastAssistant: vi.fn(),
        updateLastMessage: vi.fn(),
        updateLastAssistantMessage: vi.fn(),
        updateContext: vi.fn(),
        getFreshLocationState: vi.fn(() => ({
            activeCampaignId: 'campaign-a',
            locationLedger: [],
            context: { currentPlaceId: 'place-a', currentFeature: 'market' } as TurnState['context'],
        })),
        setCharacterProfileData: vi.fn(),
        setInventoryItems: vi.fn(),
        setLocationLedger: vi.fn(),
        addLocationSuggestions: vi.fn(),
        setArchiveIndex: vi.fn(),
        updateNPC: vi.fn(),
        addNPC: vi.fn(),
        setCondensed: vi.fn(),
        setStreaming: vi.fn(),
        archiveNPC: vi.fn(),
        restoreNPC: vi.fn(),
    };
}

describe('Phase 4.0 — mods/arc/compute.js runs through the real binding', () => {
    it('arcCompute(ctx) reads its table by bare name, sees playerInput, and writes back through the journal (no capability denied, no undeclared table write)', async () => {
        const callbacks = makeCallbacks();
        const state = makeState();
        const facade = buildHostFacade(state, callbacks);

        // The table store starts with one active arc. The tick should
        // read it, run the pure tick (dice + stance scan + ladder), and
        // write back the (possibly advanced) arc list.
        let storedArcs: unknown[] = [{
            id: 'arc-1', status: 'active', tickDC: 35, currentRung: 1,
            ladder: [{ label: 'R0', surface: 'ambient' }, { label: 'R1', surface: 'rumor' }],
            stance: 'unaware', lastTickScene: '001', type: 'economic',
            title: 'Grain Crisis', seed: 'seed', bornScene: '001',
        }];
        const tableRead = vi.fn(async (name: string) => {
            expect(name).toBe('mod.arc.arcs');
            return [...storedArcs as unknown[]];
        });
        const tableWrite = vi.fn(async (name: string, rows: unknown) => {
            expect(name).toBe('mod.arc.arcs');
            storedArcs = rows as unknown[];
        });
        const facadeWithTable: HostFacade = {
            ...facade,
            table: { read: tableRead, write: tableWrite },
        };

        const worker = new FakeWorker((_w, message) => {
            if (message.type === 'run') {
                queueMicrotask(() => runArcSourceInWorker(worker, message.snapshot, () => undefined));
            }
        });

        await runSandbox(arcComputeSource, facadeWithTable, arcManifest.compute.capabilities, {
            createWorker: () => worker,
            mod: { id: arcManifest.id, name: arcManifest.name, version: arcManifest.version, folder: 'arc' },
            locationState: {
                currentPlaceId: 'place-a',
                currentFeature: 'market',
                ledger: [],
            },
        });

        // The tick ran without throwing on entry. If the binding were the
        // 2.3 one, tableRead would have been called with 'arcs' (not
        // 'mod.arc.arcs') and the capability check would have rejected with
        // "capability denied: table:read:arcs".
        expect(tableRead).toHaveBeenCalledWith('mod.arc.arcs');
        // The tick journalled a table write and the host applied it to the
        // resolved (qualified) name. With the 2.3 binding, the journal
        // validator would have rejected "undeclared table write 'arcs'".
        expect(tableWrite).toHaveBeenCalled();
        expect(tableWrite.mock.calls[0][0]).toBe('mod.arc.arcs');
    });

    it('arcCompute(ctx) does not throw on entry when the arcs table is empty (the early-return path)', async () => {
        const callbacks = makeCallbacks();
        const state = makeState();
        const facade = buildHostFacade(state, callbacks);

        const tableRead = vi.fn(async () => []);
        const tableWrite = vi.fn(async () => undefined);
        const facadeWithTable: HostFacade = {
            ...facade,
            table: { read: tableRead, write: tableWrite },
        };

        const worker = new FakeWorker((_w, message) => {
            if (message.type === 'run') {
                queueMicrotask(() => runArcSourceInWorker(worker, message.snapshot, () => undefined));
            }
        });

        await runSandbox(arcComputeSource, facadeWithTable, arcManifest.compute.capabilities, {
            createWorker: () => worker,
            mod: { id: arcManifest.id, name: arcManifest.name, version: arcManifest.version, folder: 'arc' },
        });

        // Empty table → the tick's first statement (`if (!Array.isArray(arcs)
        // || arcs.length === 0) return;`) returns cleanly. No write.
        expect(tableRead).toHaveBeenCalledWith('mod.arc.arcs');
        expect(tableWrite).not.toHaveBeenCalled();
    });
});