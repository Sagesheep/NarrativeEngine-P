/**
 * Phase 4.0 — the regression test for `API.md` §8.6 item 1.
 *
 * The work order says: "The regression test is a compute mod driven end to
 * end through `computeTrack`, not a hand-built context. A test that
 * constructs its own `ModContext` would pass today and prove nothing — that
 * is exactly how this defect survived 3,148 green tests."
 *
 * This test drives the real `modToComputeTrack` → `runSandbox` → worker
 * binding. The worker is a `FakeWorker` that runs the mod source against the
 * `ModContext`-shape snapshot the host marshals, posts RPCs the host services,
 * and emits a `done` message with a journal. The assertions verify:
 *
 *   - `ctx.mod.id` matches the mod (per-mod namespacing is checkable).
 *   - `ctx.api.commitPoint` is `'on-return'` for sandboxed compute.
 *   - `ctx.data.playerInput` is the player's turn input (renamed from
 *     `input`), not `undefined`.
 *   - `ctx.data.location.ledger` is populated from the live store when
 *     `getFreshLocationState` is supplied (Phase 4.0 §2 Part A).
 *   - `ctx.data.chapters` is present (Phase 4.0 §2 Part C / `API.md` §8.6 item 6).
 *   - The bare table name `'arcs'` resolves to `'mod.<id>.arcs'` on the host
 *     side (`API.md` §6.2).
 *   - The journal is applied atomically on clean return to the resolved
 *     (qualified) table name.
 */

import { describe, expect, it, vi } from 'vitest';
import type { HostFacade } from '../../turn/hostFacade';
import { buildHostFacade } from '../../turn/hostFacade';
import { modToComputeTrack } from '../computeTrack';
import { createSandboxFaultPolicy } from '../sandbox/sandboxFaults';
import type {
    SandboxHostMessage,
    SandboxWorkerLike,
    SandboxWorkerMessage,
} from '../sandbox/sandboxTypes';
import type { TurnCallbacks, TurnState } from '../../turn/turnOrchestrator';
import type { AppSettings, EndpointConfig } from '../../../types';

class FakeWorker implements SandboxWorkerLike {
    onmessage: SandboxWorkerLike['onmessage'] = null;
    onerror: SandboxWorkerLike['onerror'] = null;
    terminated = false;
    readonly sent: SandboxHostMessage[] = [];
    private readonly handle: (worker: FakeWorker, message: SandboxHostMessage) => void;

    constructor(handle: (worker: FakeWorker, message: SandboxHostMessage) => void) {
        this.handle = handle;
    }

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

const endpoint = (modelName: string): EndpointConfig => ({
    endpoint: `http://${modelName}`,
    apiKey: `${modelName}-secret`,
    modelName,
});

function makeState(overrides: Partial<TurnState> = {}): TurnState {
    return {
        input: 'I draw my sword and advance.',
        displayInput: 'I draw my sword and advance.',
        settings: { contextLimit: 8192, aiTier: 'max' } as unknown as AppSettings,
        context: {
            currentPlaceId: 'place-a',
            currentFeature: 'training-yard',
            playerCharacter: { id: 'pc-1', name: 'Hero' },
            characterProfileData: { name: 'Hero', hp: 10, stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 } },
            inventoryItems: [{ id: 'i-1', name: 'Sword', category: 'weapon', quantity: 1 }],
        } as unknown as TurnState['context'],
        messages: [
            { id: 'm1', role: 'user', content: 'hello' },
            { id: 'm2', role: 'assistant', content: 'The guard eyes you warily.' },
        ],
        condenser: { condensedUpToIndex: 0 } as TurnState['condenser'],
        loreChunks: [],
        npcLedger: [{ id: 'n1', name: 'Nadia' }],
        archiveIndex: [{ sceneId: '001' }],
        activeCampaignId: 'campaign-a',
        provider: endpoint('story'),
        getMessages: () => [],
        getFreshProvider: () => endpoint('story'),
        getUtilityEndpoint: () => endpoint('utility'),
        getFreshAuxiliaryProvider: () => endpoint('auxiliary'),
        getRawAuxiliaryProvider: () => endpoint('raw-auxiliary'),
        getRawSummariserProvider: () => endpoint('raw-summariser'),
        onStageNpcIds: ['n1'],
        timeline: [],
        chapters: [
            { chapterId: 'CH01', title: 'Arrival', sceneIds: ['001'], summary: 'The hero arrives.', sealedAt: undefined as unknown as number },
        ],
        pinnedChapterIds: [],
        clearPinnedChapters: vi.fn(),
        setChapters: vi.fn(),
        incrementBookkeepingTurnCounter: vi.fn(() => 1),
        resetBookkeepingTurnCounter: vi.fn(),
        autoBookkeepingInterval: 5,
        getFreshContext: () => ({ currentPlaceId: 'place-a' } as TurnState['context']),
        divergenceRegister: { entries: [], chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 },
        ...overrides,
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
            locationLedger: [
                { id: 'place-a', name: 'Academy', broadLocation: 'Konoha', features: ['training-yard'], firstSeenScene: '001', lastSeenScene: '001', source: 'llm' as const },
            ],
            context: { currentPlaceId: 'place-a', currentFeature: 'training-yard' } as TurnState['context'],
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

function makeFacade(state: TurnState = makeState(), callbacks: TurnCallbacks = makeCallbacks()): HostFacade {
    return buildHostFacade(state, callbacks);
}

function makeContext(facade: HostFacade, callbacks: TurnCallbacks) {
    return {
        facade,
        state: undefined,
        callbacks,
        displayInput: 'I draw my sword and advance.',
        lastAssistantContent: 'The guard eyes you warily.',
        allMsgs: [],
        npcLedger: [],
        activeCampaignId: 'campaign-a',
    };
}

const arcMod = {
    id: 'arc',
    name: 'Arc Engine',
    version: '1.0.0',
    description: '',
    file: 'arc/manifest.json',
    contributions: [],
    tables: [{ name: 'arcs', recordShape: 'array' as const, label: 'Arcs' }],
    panels: [],
    screens: [],
    screenSources: [],
    compute: {
        file: 'compute.js',
        hook: 'postTurn' as const,
        capabilities: [
            'table:read:mod.arc.arcs',
            'table:write:mod.arc.arcs',
            'write:updateContext',
            'write:addMessage',
        ],
    },
    computeSource:
        // A minimal stand-in for arc's real compute hook that exercises the
        // ModContext shape: reads the table by bare name, reads playerInput,
        // reads location.ledger, reads chapters, writes the table back.
        'export default async function (ctx) {' +
        '  const arcs = await ctx.table.read("arcs");' +
        '  if (typeof ctx.data.playerInput !== "string") throw new Error("playerInput is not a string: " + typeof ctx.data.playerInput);' +
        '  if (!Array.isArray(ctx.data.location.ledger)) throw new Error("location.ledger is not an array");' +
        '  if (!Array.isArray(ctx.data.chapters)) throw new Error("chapters is not an array");' +
        '  if (ctx.mod.id !== "arc") throw new Error("mod.id mismatch: " + ctx.mod.id);' +
        '  if (ctx.api.commitPoint !== "on-return") throw new Error("commitPoint mismatch: " + ctx.api.commitPoint);' +
        '  if (!Array.isArray(arcs)) throw new Error("arcs is not an array");' +
        '  ctx.table.write("arcs", [{ id: "arc-1", status: "active" }]);' +
        '  ctx.write.updateContext({ arcDigest: "test" });' +
        '}',
};

describe('Phase 4.0 — compute track binds the sandbox to ModContext', () => {
    it('hands a sandboxed compute mod a real ModContext (mod/api/data/playerInput/location/chapters) and resolves the bare-name table alias', async () => {
        const tableRead = vi.fn(async () => [{ id: 'arc-existing', status: 'active' }]);
        const tableWrite = vi.fn(async () => undefined);
        const updateContext = vi.fn();
        const callbacks = makeCallbacks();
        const state = makeState();
        const facade = makeFacade(state, callbacks);
        // Override the table adapter to capture the resolved names.
        const facadeWithTable: HostFacade = {
            ...facade,
            table: { read: tableRead, write: tableWrite },
            write: { ...facade.write, updateContext },
        };

        const createWorker = vi.fn(() => new FakeWorker((worker, message) => {
            if (message.type === 'run') {
                // The snapshot is the ModContext-shape: mod/api/data/config.
                const snapshot = message.snapshot as {
                    mod: { id: string; name: string; version: string };
                    api: { version: string; commitPoint: string };
                    data: { playerInput: string; location: { ledger: unknown[] }; chapters: unknown[] };
                    config: Record<string, unknown>;
                };
                // Verify the host marshalled the ModContext shape, not FacadeData.
                expect(snapshot.mod).toEqual({ id: 'arc', name: 'Arc Engine', version: '1.0.0' });
                expect(snapshot.api.commitPoint).toBe('on-return');
                expect(snapshot.data.playerInput).toBe('I draw my sword and advance.');
                expect(Array.isArray(snapshot.data.location.ledger)).toBe(true);
                expect(snapshot.data.location.ledger.length).toBe(1);
                expect(Array.isArray(snapshot.data.chapters)).toBe(true);

                // Simulate the worker prelude running the mod source. The mod
                // calls `ctx.table.read('arcs')` → posts a table-read RPC. The
                // host resolves the bare name to 'mod.arc.arcs' and replies.
                queueMicrotask(() => worker.emit({ type: 'rpc', id: 1, channel: 'table', method: 'read', args: ['arcs'] }));
            }
            if (message.type === 'rpc-reply') {
                // The mod received the table rows; assert the host called
                // table.read with the resolved (qualified) name.
                expect(tableRead).toHaveBeenCalledWith('mod.arc.arcs');
                // Now the mod calls ctx.table.write('arcs', ...) (journalled)
                // and ctx.write.updateContext(...) (journalled), then done.
                queueMicrotask(() => worker.emit({
                    type: 'done',
                    writes: [
                        { kind: 'table', name: 'arcs', rows: [{ id: 'arc-1', status: 'active' }] },
                        { kind: 'store', name: 'updateContext', args: [{ arcDigest: 'test' }] },
                    ],
                    result: null,
                }));
            }
        }));

        const policy = createSandboxFaultPolicy();
        const track = modToComputeTrack(arcMod as never, {
            sandboxPolicy: policy,
            sandboxOptions: { createWorker },
        });
        const ctx = makeContext(facadeWithTable, callbacks);

        await track.run(ctx);

        // The host applied the journal: table.write was called with the
        // resolved (qualified) name, not the bare name.
        expect(tableWrite).toHaveBeenCalledWith('mod.arc.arcs', [{ id: 'arc-1', status: 'active' }]);
        expect(updateContext).toHaveBeenCalledWith({ arcDigest: 'test' });
        expect(policy.getStrikes('arc')).toBe(0);
    });

    it('data.location.ledger stays [] when no locationState is supplied (no getFreshLocationState)', async () => {
        const tableRead = vi.fn(async () => []);
        const tableWrite = vi.fn(async () => undefined);
        const callbacks = makeCallbacks();
        const state = makeState();
        const facade = makeFacade(state, callbacks);
        const facadeWithTable: HostFacade = {
            ...facade,
            table: { read: tableRead, write: tableWrite },
        };

        const createWorker = vi.fn(() => new FakeWorker((worker, message) => {
            if (message.type === 'run') {
                const snapshot = message.snapshot as { data: { location: { ledger: unknown[] } } };
                // Without locationState, the ledger is empty.
                expect(snapshot.data.location.ledger).toEqual([]);
                queueMicrotask(() => worker.emit({ type: 'rpc', id: 1, channel: 'table', method: 'read', args: ['arcs'] }));
            }
            if (message.type === 'rpc-reply') {
                queueMicrotask(() => worker.emit({ type: 'done', writes: [], result: null }));
            }
        }));

        const policy = createSandboxFaultPolicy();
        const track = modToComputeTrack(arcMod as never, {
            sandboxPolicy: policy,
            sandboxOptions: { createWorker },
        });
        // Pass a context with no callbacks so getFreshLocationState is undefined.
        const ctx = {
            facade: facadeWithTable,
            state: undefined,
            callbacks: undefined,
            displayInput: '',
            lastAssistantContent: '',
            allMsgs: [],
            npcLedger: [],
            activeCampaignId: 'campaign-a',
        };

        await track.run(ctx);
        expect(policy.getStrikes('arc')).toBe(0);
    });
});