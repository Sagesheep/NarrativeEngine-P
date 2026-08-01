import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { HostFacade } from '../../../turn/hostFacade';
import {
    MAX_INBOUND_MESSAGES,
    MAX_JOURNAL_ENTRIES,
    type SandboxHostMessage,
    type SandboxWorkerLike,
    type SandboxWorkerMessage,
} from '../sandboxTypes';
import { applyJournal, runSandbox } from '../sandboxHost';
import { buildWorkerSource } from '../workerPrelude';

type WorkerHandler = (worker: FakeWorker, message: SandboxHostMessage) => void;

class FakeWorker implements SandboxWorkerLike {
    onmessage: SandboxWorkerLike['onmessage'] = null;
    onerror: SandboxWorkerLike['onerror'] = null;
    readonly sent: SandboxHostMessage[] = [];
    terminated = false;

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

    emitError(message: string): void {
        this.onerror?.({
            message,
            preventDefault: vi.fn(),
        } as unknown as ErrorEvent);
    }
}

function makeFacade(overrides: Partial<HostFacade> = {}): HostFacade {
    const controller = new AbortController();
    const facade: HostFacade = {
        data: { context: {}, messages: [] } as HostFacade['data'],
        config: { contextLimit: 4096 } as HostFacade['config'],
        write: {
            updateContext: vi.fn(),
            updateNPC: vi.fn(),
            addMessage: vi.fn(),
            addEnemySuggestions: vi.fn(),
            setDivergenceRegister: vi.fn(),
            addNpcSuggestions: vi.fn(),
            archiveNPC: vi.fn(),
            restoreNPC: vi.fn(),
            onDirectorBriefPhase: vi.fn(),
            updatePlayerCharacter: vi.fn(),
            setCharacterProfileData: vi.fn(),
            setInventoryItems: vi.fn(),
            setLocationLedger: vi.fn(),
            addLocationSuggestions: vi.fn(),
        },
        model: { call: vi.fn() },
        table: {
            read: vi.fn(async () => []),
            write: vi.fn(async () => undefined),
        },
        signal: controller.signal,
        refresh: vi.fn(() => facade),
        log: vi.fn(),
        ...overrides,
    };
    return facade;
}

const source = 'export default async function (ctx) { return { input: ctx.data.input }; }';

describe('worker prelude', () => {
    it('carries the spike network barrier and the additional escape barriers', () => {
        const workerSource = buildWorkerSource(source);

        expect(workerSource).toContain("'fetch'");
        expect(workerSource).toContain("'XMLHttpRequest'");
        expect(workerSource).toContain("'WebSocket'");
        expect(workerSource).toContain("'EventSource'");
        expect(workerSource).toContain("'importScripts'");
        expect(workerSource).toContain("'Worker'");
        expect(workerSource).toContain("'SharedArrayBuffer'");
        expect(workerSource).toContain("'Atomics'");
        expect(workerSource).toContain("'indexedDB'");
        expect(workerSource).toContain("'caches'");
        expect(workerSource).toContain("'sendBeacon'");
        expect(workerSource).toContain('[sandbox] model access arrives in 3.6');
        expect(workerSource).toContain(`__sandboxJournal.length >= ${MAX_JOURNAL_ENTRIES}`);
    });
});

describe('runSandbox', () => {
    it('returns the result and applies a declared journal only after clean return', async () => {
        const updateContext = vi.fn();
        const facade = makeFacade({ write: { ...makeFacade().write, updateContext } });
        const worker = new FakeWorker((current, message) => {
            if (message.type === 'run') {
                current.emit({
                    type: 'done',
                    writes: [{ name: 'updateContext', args: [{ scene: 'new' }] }],
                    result: { ok: true },
                });
            }
        });

        await expect(runSandbox(source, facade, ['write:updateContext'], {
            createWorker: () => worker,
        })).resolves.toEqual({ ok: true });

        expect(updateContext).toHaveBeenCalledWith({ scene: 'new' });
        expect(worker.terminated).toBe(true);
        expect(worker.sent[0]).toMatchObject({ type: 'run', deadlineMs: 5000 });
    });

    it('validates the whole journal before applying any write', async () => {
        const updateContext = vi.fn();
        const updateNPC = vi.fn();
        const facade = makeFacade({ write: { ...makeFacade().write, updateContext, updateNPC } });
        const worker = new FakeWorker((current, message) => {
            if (message.type === 'run') {
                current.emit({
                    type: 'done',
                    writes: [
                        { name: 'updateContext', args: [{ scene: 'new' }] },
                        { name: 'updateNPC', args: ['n-1', { disposition: 'hostile' }] },
                    ],
                    result: null,
                });
            }
        });

        await expect(runSandbox(source, facade, ['write:updateContext'], {
            createWorker: () => worker,
        })).rejects.toThrow(/undeclared write "updateNPC"/);

        expect(updateContext).not.toHaveBeenCalled();
        expect(updateNPC).not.toHaveBeenCalled();
    });

    it('discards the journal when the worker reports an error', async () => {
        const updateContext = vi.fn();
        const facade = makeFacade({ write: { ...makeFacade().write, updateContext } });
        const worker = new FakeWorker((current, message) => {
            if (message.type === 'run') current.emit({ type: 'error', message: 'mod failed' });
        });

        await expect(runSandbox(source, facade, ['write:updateContext'], {
            createWorker: () => worker,
        })).rejects.toThrow('mod failed');
        expect(updateContext).not.toHaveBeenCalled();
    });

    it('handles table RPC and returns the reply to the worker', async () => {
        const tableRead = vi.fn(async () => [{ id: 'n-1' }]);
        const facade = makeFacade({ table: { read: tableRead, write: vi.fn(async () => undefined) } });
        const worker = new FakeWorker((current, message) => {
            if (message.type === 'run') {
                queueMicrotask(() => current.emit({ type: 'rpc', id: 1, channel: 'table', method: 'read', args: ['npcs'] }));
            }
            if (message.type === 'rpc-reply') {
                expect(message).toMatchObject({ type: 'rpc-reply', id: 1, ok: true, value: [{ id: 'n-1' }] });
                queueMicrotask(() => current.emit({ type: 'done', writes: [], result: message.value }));
            }
        });

        await expect(runSandbox(source, facade, ['table:read:npcs'], {
            createWorker: () => worker,
        })).resolves.toEqual([{ id: 'n-1' }]);
        expect(tableRead).toHaveBeenCalledWith('npcs');
    });

    it('returns a refreshed snapshot through refresh RPC', async () => {
        const refreshed = {
            data: { input: 'fresh' } as HostFacade['data'],
            config: { contextLimit: 2048 } as HostFacade['config'],
        } as HostFacade;
        const facade = makeFacade({ refresh: vi.fn(() => refreshed) });
        const worker = new FakeWorker((current, message) => {
            if (message.type === 'run') {
                queueMicrotask(() => current.emit({ type: 'rpc', id: 4, channel: 'refresh', args: [] }));
            }
            if (message.type === 'rpc-reply') {
                expect(message).toMatchObject({ type: 'rpc-reply', id: 4, ok: true, value: refreshed });
                queueMicrotask(() => current.emit({ type: 'done', writes: [], result: message.value }));
            }
        });

        await expect(runSandbox(source, facade, [], { createWorker: () => worker })).resolves.toEqual({
            data: refreshed.data,
            config: refreshed.config,
        });
        expect(facade.refresh).toHaveBeenCalledTimes(1);
    });

    it('denies undeclared table RPC without invoking the adapter', async () => {
        const tableRead = vi.fn(async () => []);
        const facade = makeFacade({ table: { read: tableRead, write: vi.fn(async () => undefined) } });
        const worker = new FakeWorker((current, message) => {
            if (message.type === 'run') {
                queueMicrotask(() => current.emit({ type: 'rpc', id: 2, channel: 'table', method: 'read', args: ['npcs'] }));
            }
            if (message.type === 'rpc-reply') {
                expect(message).toMatchObject({ ok: false, error: '[sandbox] capability denied: table:read:npcs' });
                queueMicrotask(() => current.emit({ type: 'error', message: 'RPC denied' }));
            }
        });

        await expect(runSandbox(source, facade, [], { createWorker: () => worker })).rejects.toThrow('RPC denied');
        expect(tableRead).not.toHaveBeenCalled();
    });

    it('terminates and discards writes at the deadline', async () => {
        const updateContext = vi.fn();
        const facade = makeFacade({ write: { ...makeFacade().write, updateContext } });
        const worker = new FakeWorker();

        await expect(runSandbox(source, facade, ['write:updateContext'], {
            createWorker: () => worker,
            deadlineMs: 5,
        })).rejects.toThrow('deadline exceeded (5 ms)');

        expect(worker.terminated).toBe(true);
        expect(updateContext).not.toHaveBeenCalled();
        expect(worker.sent.some((message) => message.type === 'abort')).toBe(true);
    });

    it('terminates and discards writes when the host signal aborts', async () => {
        const controller = new AbortController();
        const facade = makeFacade({ signal: controller.signal });
        const worker = new FakeWorker();
        const running = runSandbox(source, facade, [], { createWorker: () => worker, deadlineMs: 1000 });

        controller.abort();

        await expect(running).rejects.toThrow('[sandbox] run aborted');
        expect(worker.terminated).toBe(true);
        expect(worker.sent.some((message) => message.type === 'abort')).toBe(true);
    });

    it('enforces the inbound message cap', async () => {
        const log = vi.fn();
        const facade = makeFacade({ log });
        const worker = new FakeWorker((current, message) => {
            if (message.type === 'run') {
                for (let i = 0; i <= MAX_INBOUND_MESSAGES; i++) current.emit({ type: 'log', args: [i] });
            }
        });

        await expect(runSandbox(source, facade, [], { createWorker: () => worker, deadlineMs: 1000 }))
            .rejects.toThrow(`inbound message cap exceeded (${MAX_INBOUND_MESSAGES})`);
        expect(log).toHaveBeenCalledTimes(MAX_INBOUND_MESSAGES);
        expect(worker.terminated).toBe(true);
    });

    it('enforces the journal cap before applying any entry', () => {
        const updateContext = vi.fn();
        const facade = makeFacade({ write: { ...makeFacade().write, updateContext } });
        const writes = Array.from({ length: MAX_JOURNAL_ENTRIES + 1 }, () => ({
            name: 'updateContext',
            args: [{}],
        }));

        expect(() => applyJournal(facade, writes, ['write:updateContext']))
            .toThrow(`maximum ${MAX_JOURNAL_ENTRIES} entries exceeded`);
        expect(updateContext).not.toHaveBeenCalled();
    });
});

describe('sandbox source boundary', () => {
    it('does not import or reference the Zustand store', () => {
        const files = [
            'src/services/mods/sandbox/sandboxTypes.ts',
            'src/services/mods/sandbox/workerPrelude.ts',
            'src/services/mods/sandbox/sandboxHost.ts',
        ];
        for (const file of files) {
            expect(readFileSync(resolve(process.cwd(), file), 'utf8')).not.toContain('useAppStore');
        }
    });
});

