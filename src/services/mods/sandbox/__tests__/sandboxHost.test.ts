import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { HostFacade } from '../../../turn/hostFacade';
import { MODEL_JSON_RETRY_SUFFIX } from '../../../turn/hostFacade';
import {
    MAX_INBOUND_MESSAGES,
    MAX_JOURNAL_ENTRIES,
    MAX_MODEL_TOKENS_PER_CALL,
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
        model: { call: vi.fn(), callJson: vi.fn(), available: vi.fn(() => true) },
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

const source = 'export default async function (ctx) { return { playerInput: ctx.data.playerInput }; }';

/**
 * Phase 4.0 — every `runSandbox` call now requires a per-mod identity
 * (`API.md` §8.6 item 1). The tests use a fixed `test` mod; its `id` is what
 * the bare-name table alias resolves against, so a test that declares
 * `table:read:mod.test.npcs` and reads `'npcs'` from the worker hits the
 * right capability.
 */
const mod = { id: 'test', name: 'Test', version: '1.0.0' };

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
        expect(workerSource).toContain('callJson');
        expect(workerSource).toContain('model');
        expect(workerSource).not.toContain('model.stream');
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
                    writes: [{ kind: 'store', name: 'updateContext', args: [{ scene: 'new' }] }],
                    result: { ok: true },
                });
            }
        });

        await expect(runSandbox(source, facade, ['write:updateContext'], {
            createWorker: () => worker,
            mod,
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
                        { kind: 'store', name: 'updateContext', args: [{ scene: 'new' }] },
                        { kind: 'store', name: 'updateNPC', args: ['n-1', { disposition: 'hostile' }] },
                    ],
                    result: null,
                });
            }
        });

        await expect(runSandbox(source, facade, ['write:updateContext'], {
            createWorker: () => worker,
            mod,
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
            mod,
        })).rejects.toThrow('mod failed');
        expect(updateContext).not.toHaveBeenCalled();
    });

    it('A mod that performs several writes and then hangs forever applies zero writes at the deadline', async () => {
        const updateContext = vi.fn();
        const facade = makeFacade({ write: { ...makeFacade().write, updateContext } });
        const worker = new FakeWorker();

        await expect(runSandbox(source, facade, ['write:updateContext'], {
            createWorker: () => worker,
            deadlineMs: 5,
            mod,
        })).rejects.toThrow('deadline exceeded (5 ms)');

        expect(updateContext).not.toHaveBeenCalled();
    });

    it('A mod that throws after several writes applies zero writes', async () => {
        const updateContext = vi.fn();
        const facade = makeFacade({ write: { ...makeFacade().write, updateContext } });
        const worker = new FakeWorker((current, message) => {
            if (message.type === 'run') current.emit({ type: 'error', message: 'mod threw after writes' });
        });

        await expect(runSandbox(source, facade, ['write:updateContext'], {
            createWorker: () => worker,
            mod,
        })).rejects.toThrow('mod threw after writes');

        expect(updateContext).not.toHaveBeenCalled();
    });

    it('A worker error after several writes applies zero writes', async () => {
        const updateContext = vi.fn();
        const facade = makeFacade({ write: { ...makeFacade().write, updateContext } });
        const worker = new FakeWorker((current, message) => {
            if (message.type === 'run') queueMicrotask(() => current.emitError('worker died after writes'));
        });

        await expect(runSandbox(source, facade, ['write:updateContext'], {
            createWorker: () => worker,
            mod,
        })).rejects.toThrow('worker died after writes');

        expect(updateContext).not.toHaveBeenCalled();
    });

    it('A journal rejection after several valid writes applies zero writes', async () => {
        const updateContext = vi.fn();
        const updateNPC = vi.fn();
        const facade = makeFacade({ write: { ...makeFacade().write, updateContext, updateNPC } });
        const worker = new FakeWorker((current, message) => {
            if (message.type === 'run') {
                current.emit({
                    type: 'done',
                    writes: [
                        { kind: 'store', name: 'updateContext', args: [{ scene: 'one' }] },
                        { kind: 'store', name: 'updateContext', args: [{ scene: 'two' }] },
                        { kind: 'store', name: 'updateNPC', args: ['n-1', { disposition: 'hostile' }] },
                    ],
                    result: null,
                });
            }
        });

        await expect(runSandbox(source, facade, ['write:updateContext'], {
            createWorker: () => worker,
            mod,
        })).rejects.toThrow('undeclared write "updateNPC"');

        expect(updateContext).not.toHaveBeenCalled();
        expect(updateNPC).not.toHaveBeenCalled();
    });

    // WO-P5-14 §4 step 2 — the four zero-partial-write tests above only ever
    // exercised ctx.write.* (store), which is why the table-write hole sat
    // under a green suite. The four tests below extend them to a mod that
    // writes A TABLE and then hangs / throws / dies / trips validation. Zero
    // table writes applied in every case — §7.3 holds for both paths now.

    it('A mod that writes a table then hangs forever applies zero table writes at the deadline', async () => {
        const tableWrite = vi.fn(async () => undefined);
        const facade = makeFacade({ table: { read: vi.fn(async () => []), write: tableWrite } });
        const worker = new FakeWorker();

        await expect(runSandbox(source, facade, ['table:write:mod.test.npcs'], {
            createWorker: () => worker,
            deadlineMs: 5,
            mod,
        })).rejects.toThrow('deadline exceeded (5 ms)');

        expect(tableWrite).not.toHaveBeenCalled();
    });

    it('A mod that writes a table then throws applies zero table writes', async () => {
        const tableWrite = vi.fn(async () => undefined);
        const facade = makeFacade({ table: { read: vi.fn(async () => []), write: tableWrite } });
        const worker = new FakeWorker((current, message) => {
            if (message.type === 'run') current.emit({ type: 'error', message: 'mod threw after table write' });
        });

        await expect(runSandbox(source, facade, ['table:write:mod.test.npcs'], {
            createWorker: () => worker,
            mod,
        })).rejects.toThrow('mod threw after table write');

        expect(tableWrite).not.toHaveBeenCalled();
    });

    it('A worker error after a table write applies zero table writes', async () => {
        const tableWrite = vi.fn(async () => undefined);
        const facade = makeFacade({ table: { read: vi.fn(async () => []), write: tableWrite } });
        const worker = new FakeWorker((current, message) => {
            if (message.type === 'run') queueMicrotask(() => current.emitError('worker died after table write'));
        });

        await expect(runSandbox(source, facade, ['table:write:mod.test.npcs'], {
            createWorker: () => worker,
            mod,
        })).rejects.toThrow('worker died after table write');

        expect(tableWrite).not.toHaveBeenCalled();
    });

    it('A journal rejection after a valid table write applies zero table writes', async () => {
        const tableWrite = vi.fn(async () => undefined);
        const updateContext = vi.fn();
        const facade = makeFacade({
            write: { ...makeFacade().write, updateContext },
            table: { read: vi.fn(async () => []), write: tableWrite },
        });
        const worker = new FakeWorker((current, message) => {
            if (message.type === 'run') {
                current.emit({
                    type: 'done',
                    writes: [
                        { kind: 'table', name: 'npcs', rows: [{ id: 'n-1' }] },
                        { kind: 'table', name: 'undeclared-table', rows: [{ id: 'x' }] },
                    ],
                    result: null,
                });
            }
        });

        await expect(runSandbox(source, facade, ['table:write:mod.test.npcs'], {
            createWorker: () => worker,
            mod,
        })).rejects.toThrow('undeclared table write "undeclared-table"');

        expect(tableWrite).not.toHaveBeenCalled();
        expect(updateContext).not.toHaveBeenCalled();
    });

    it('A journal rejection: an undeclared table write rejects store entries too', async () => {
        const tableWrite = vi.fn(async () => undefined);
        const updateContext = vi.fn();
        const facade = makeFacade({
            write: { ...makeFacade().write, updateContext },
            table: { read: vi.fn(async () => []), write: tableWrite },
        });
        const worker = new FakeWorker((current, message) => {
            if (message.type === 'run') {
                current.emit({
                    type: 'done',
                    writes: [
                        { kind: 'store', name: 'updateContext', args: [{ scene: 'one' }] },
                        { kind: 'table', name: 'undeclared-table', rows: [{ id: 'x' }] },
                    ],
                    result: null,
                });
            }
        });

        await expect(runSandbox(source, facade, ['write:updateContext'], {
            createWorker: () => worker,
            mod,
        })).rejects.toThrow('undeclared table write "undeclared-table"');

        expect(updateContext).not.toHaveBeenCalled();
        expect(tableWrite).not.toHaveBeenCalled();
    });

    it('applies a journalled table write on clean return only', async () => {
        const tableWrite = vi.fn(async () => undefined);
        const facade = makeFacade({ table: { read: vi.fn(async () => []), write: tableWrite } });
        const worker = new FakeWorker((current, message) => {
            if (message.type === 'run') {
                current.emit({
                    type: 'done',
                    writes: [{ kind: 'table', name: 'npcs', rows: [{ id: 'n-1' }] }],
                    result: null,
                });
            }
        });

        await expect(runSandbox(source, facade, ['table:write:mod.test.npcs'], {
            createWorker: () => worker,
            mod,
        })).resolves.toBeNull();

        expect(tableWrite).toHaveBeenCalledWith('mod.test.npcs', [{ id: 'n-1' }]);
    });

    it('preserves issue order across store and table entries', async () => {
        const updateContext = vi.fn();
        const tableWrite = vi.fn(async () => undefined);
        const facade = makeFacade({
            write: { ...makeFacade().write, updateContext },
            table: { read: vi.fn(async () => []), write: tableWrite },
        });
        const worker = new FakeWorker((current, message) => {
            if (message.type === 'run') {
                current.emit({
                    type: 'done',
                    writes: [
                        { kind: 'store', name: 'updateContext', args: [{ scene: 'one' }] },
                        { kind: 'table', name: 'npcs', rows: [{ id: 'n-1' }] },
                        { kind: 'store', name: 'updateContext', args: [{ scene: 'two' }] },
                    ],
                    result: null,
                });
            }
        });

        await expect(runSandbox(source, facade, ['write:updateContext', 'table:write:mod.test.npcs'], {
            createWorker: () => worker,
            mod,
        })).resolves.toBeNull();

        expect(updateContext).toHaveBeenCalledTimes(2);
        expect(tableWrite).toHaveBeenCalledTimes(1);
        expect(updateContext.mock.invocationCallOrder[0]).toBeLessThan(tableWrite.mock.invocationCallOrder[0]);
        expect(tableWrite.mock.invocationCallOrder[0]).toBeLessThan(updateContext.mock.invocationCallOrder[1]);
    });

    it('an undeclared table write rejects the whole journal, store entries included', async () => {
        const updateContext = vi.fn();
        const tableWrite = vi.fn(async () => undefined);
        const facade = makeFacade({
            write: { ...makeFacade().write, updateContext },
            table: { read: vi.fn(async () => []), write: tableWrite },
        });
        const worker = new FakeWorker((current, message) => {
            if (message.type === 'run') {
                current.emit({
                    type: 'done',
                    writes: [
                        { kind: 'store', name: 'updateContext', args: [{ scene: 'one' }] },
                        { kind: 'table', name: 'unknown-table', rows: [{ id: 'x' }] },
                    ],
                    result: null,
                });
            }
        });

        await expect(runSandbox(source, facade, ['write:updateContext'], {
            createWorker: () => worker,
            mod,
        })).rejects.toThrow('undeclared table write "unknown-table"');

        expect(updateContext).not.toHaveBeenCalled();
        expect(tableWrite).not.toHaveBeenCalled();
    });

    it('rejects a stale table write RPC from a crafted worker', async () => {
        const tableWrite = vi.fn(async () => undefined);
        const facade = makeFacade({ table: { read: vi.fn(async () => []), write: tableWrite } });
        const worker = new FakeWorker((current, message) => {
            if (message.type === 'run') {
                queueMicrotask(() => current.emit({ type: 'rpc', id: 1, channel: 'table', method: 'read', args: ['npcs'] }));
            }
            if (message.type === 'rpc-reply') {
                queueMicrotask(() => current.emit({ type: 'done', writes: [], result: null }));
            }
        });

        await expect(runSandbox(source, facade, ['table:read:npcs', 'table:write:npcs'], {
            createWorker: () => worker,
            mod,
        })).resolves.toBeNull();

        expect(tableWrite).not.toHaveBeenCalled();
    });

    // WO-P5-14 §3 — a documented v1 limitation, asserted here so the day
    // someone wants a read-overlay they find a deliberate decision rather
    // than a bug. A mod that writes a table then reads the same table in the
    // same run sees the OLD (committed) value, because the write is still
    // pending in the journal. Reads do not shadow pending writes — the
    // pattern no measured feature uses (a compute mod holds its working data
    // in a local variable and writes once at the end, as Arc does).
    it('read-after-write within a run returns the committed (old) value, not the pending write', async () => {
        const committedRows = [{ id: 'old' }];
        const tableRead = vi.fn(async () => committedRows);
        const tableWrite = vi.fn(async () => undefined);
        const facade = makeFacade({ table: { read: tableRead, write: tableWrite } });
        let readReply: unknown;
        const worker = new FakeWorker((current, message) => {
            if (message.type === 'run') {
                queueMicrotask(() => current.emit({ type: 'rpc', id: 1, channel: 'table', method: 'read', args: ['npcs'] }));
            }
            if (message.type === 'rpc-reply') {
                readReply = message.value;
                queueMicrotask(() => current.emit({
                    type: 'done',
                    writes: [{ kind: 'table', name: 'npcs', rows: [{ id: 'new' }] }],
                    result: message.value,
                }));
            }
        });

        await expect(runSandbox(source, facade, ['table:read:mod.test.npcs', 'table:write:mod.test.npcs'], {
            createWorker: () => worker,
            mod,
        })).resolves.toEqual(committedRows);

        // The mod saw the committed (old) value, not the pending write.
        expect(readReply).toEqual(committedRows);
        expect(tableRead).toHaveBeenCalledWith('mod.test.npcs');
        // The write is applied on clean return, but the read already saw the old value.
        expect(tableWrite).toHaveBeenCalledWith('mod.test.npcs', [{ id: 'new' }]);
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

        await expect(runSandbox(source, facade, ['table:read:mod.test.npcs'], {
            createWorker: () => worker,
            mod,
        })).resolves.toEqual([{ id: 'n-1' }]);
        expect(tableRead).toHaveBeenCalledWith('mod.test.npcs');
    });

    it('returns a refreshed ModContext snapshot through refresh RPC', async () => {
        // Phase 4.0 — refresh returns the projected `ModContext`-shape
        // snapshot (`mod`/`api`/`data`/`config`), not the raw `FacadeData`/
        // `FacadeConfig`. The `data` shape is `ModData` (e.g. `playerInput`,
        // not `input`).
        const refreshed = makeFacade({
            data: { context: { input: 'fresh' } as HostFacade['data']['context'], input: 'fresh' } as HostFacade['data'],
            config: { contextLimit: 2048 } as HostFacade['config'],
        });
        const facade = makeFacade({ refresh: vi.fn(() => refreshed) });
        const worker = new FakeWorker((current, message) => {
            if (message.type === 'run') {
                queueMicrotask(() => current.emit({ type: 'rpc', id: 4, channel: 'refresh', args: [] }));
            }
            if (message.type === 'rpc-reply') {
                // The refresh reply is a `ModContext`-shape snapshot, not a facade.
                expect(message).toMatchObject({ type: 'rpc-reply', id: 4, ok: true });
                const value = message.value as { mod: unknown; api: unknown; data: { playerInput: string }; config: unknown };
                expect(value.mod).toEqual({ id: 'test', name: 'Test', version: '1.0.0' });
                expect(value.api).toMatchObject({ commitPoint: 'on-return' });
                expect(value.data.playerInput).toBe('fresh');
                queueMicrotask(() => current.emit({ type: 'done', writes: [], result: message.value }));
            }
        });

        await expect(runSandbox(source, facade, [], { createWorker: () => worker, mod })).resolves.toBeDefined();
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
                // Bare 'npcs' resolves to 'mod.test.npcs' for the capability check.
                expect(message).toMatchObject({ ok: false, error: '[sandbox] capability denied: table:read:mod.test.npcs' });
                queueMicrotask(() => current.emit({ type: 'error', message: 'RPC denied' }));
            }
        });

        await expect(runSandbox(source, facade, [], { createWorker: () => worker, mod })).rejects.toThrow('RPC denied');
        expect(tableRead).not.toHaveBeenCalled();
    });

    it('terminates and discards writes at the deadline', async () => {
        const updateContext = vi.fn();
        const facade = makeFacade({ write: { ...makeFacade().write, updateContext } });
        const worker = new FakeWorker();

        await expect(runSandbox(source, facade, ['write:updateContext'], {
            createWorker: () => worker,
            deadlineMs: 5,
            mod,
        })).rejects.toThrow('deadline exceeded (5 ms)');

        expect(worker.terminated).toBe(true);
        expect(updateContext).not.toHaveBeenCalled();
        expect(worker.sent.some((message) => message.type === 'abort')).toBe(true);
    });

    it('terminates and discards writes when the host signal aborts', async () => {
        const controller = new AbortController();
        const facade = makeFacade({ signal: controller.signal });
        const worker = new FakeWorker();
        const running = runSandbox(source, facade, [], { createWorker: () => worker, deadlineMs: 1000, mod });

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

        await expect(runSandbox(source, facade, [], { createWorker: () => worker, deadlineMs: 1000, mod }))
            .rejects.toThrow(`inbound message cap exceeded (${MAX_INBOUND_MESSAGES})`);
        expect(log).toHaveBeenCalledTimes(MAX_INBOUND_MESSAGES);
        expect(worker.terminated).toBe(true);
    });

    it('enforces the journal cap before applying any entry', () => {
        const updateContext = vi.fn();
        const facade = makeFacade({ write: { ...makeFacade().write, updateContext } });
        const writes = Array.from({ length: MAX_JOURNAL_ENTRIES + 1 }, () => ({
            kind: 'store' as const,
            name: 'updateContext',
            args: [{}],
        }));

        expect(() => applyJournal(facade, writes, ['write:updateContext']))
            .toThrow(`maximum ${MAX_JOURNAL_ENTRIES} entries exceeded`);
        expect(updateContext).not.toHaveBeenCalled();
    });
});


describe('brokered model channel', () => {
    it('sends only a credential-free ModContext snapshot and replies with a content-only model value', async () => {
        const modelCall = vi.fn(async (_role: 'utility', request: { prompt: string; maxTokens?: number; signal?: AbortSignal }) => ({
            content: request.prompt === 'hello' ? 'model-result' : 'unexpected',
        }));
        const facade = makeFacade({
            model: {
                call: modelCall,
                callJson: vi.fn(),
                available: vi.fn(() => true),
            },
        });
        let replyValue: unknown;
        const worker = new FakeWorker((current, message) => {
            if (message.type === 'run') {
                const serialized = JSON.stringify(message);
                expect(serialized).not.toMatch(/apiKey|endpoint|Authorization/i);
                // Phase 4.0 — the snapshot is the `ModContext`-shape read-only
                // half: `mod`/`api`/`data`/`config` (`API.md` §8.6 item 1).
                expect(Object.keys(message.snapshot).sort()).toEqual(['api', 'config', 'data', 'mod']);
                expect(message.modelRoles).toContain('utility');
                queueMicrotask(() => current.emit({
                    type: 'rpc',
                    id: 1,
                    channel: 'model',
                    method: 'call',
                    args: ['utility', { prompt: 'hello', maxTokens: 999999 }],
                }));
            }
            if (message.type === 'rpc-reply') {
                replyValue = message.value;
                queueMicrotask(() => current.emit({ type: 'done', writes: [], result: message.value }));
            }
        });

        await expect(runSandbox('export default async function () {}', facade, ['model:utility'], {
            createWorker: () => worker,
            mod,
        })).resolves.toEqual({ content: 'model-result' });

        expect(Object.keys(replyValue as Record<string, unknown>)).toEqual(['content']);
        expect(modelCall).toHaveBeenCalledTimes(1);
        expect(modelCall.mock.calls[0][1].maxTokens).toBe(MAX_MODEL_TOKENS_PER_CALL);
        expect(modelCall.mock.calls[0][1].signal?.aborted).toBe(true);
    });

    it('performs one host-side JSON retry, clamps retries, and counts both model calls', async () => {
        const modelCall = vi.fn()
            .mockResolvedValueOnce({ content: 'not json' })
            .mockResolvedValueOnce({ content: '{"ok":true}' });
        const facade = makeFacade({
            model: {
                call: modelCall,
                callJson: vi.fn(),
                available: vi.fn(() => true),
            },
        });
        let reply: { value?: unknown } | undefined;
        const worker = new FakeWorker((current, message) => {
            if (message.type === 'run') {
                queueMicrotask(() => current.emit({
                    type: 'rpc',
                    id: 2,
                    channel: 'model',
                    method: 'callJson',
                    args: ['utility', { prompt: 'json please', maxTokens: 9000 }, { retries: 99 }],
                }));
            }
            if (message.type === 'rpc-reply') {
                reply = message;
                queueMicrotask(() => current.emit({ type: 'done', writes: [], result: message.value }));
            }
        });

        await expect(runSandbox('export default async function () {}', facade, ['model:utility'], {
            createWorker: () => worker,
            mod,
        })).resolves.toEqual({ content: { ok: true } });

        expect(Object.keys(reply?.value as Record<string, unknown>)).toEqual(['content']);
        expect(modelCall).toHaveBeenCalledTimes(2);
        expect(modelCall.mock.calls[0][1].maxTokens).toBe(MAX_MODEL_TOKENS_PER_CALL);
        expect(modelCall.mock.calls[1][1].prompt).toContain(MODEL_JSON_RETRY_SUFFIX);
    });

    it('scrubs provider credentials from a failed model RPC reply', async () => {
        const facade = makeFacade({
            model: {
                call: vi.fn(async () => {
                    throw new Error('https://provider.invalid/v1?apiKey=secret-key Authorization: Bearer secret-key');
                }),
                callJson: vi.fn(),
                available: vi.fn(() => true),
            },
        });
        let errorText = '';
        const worker = new FakeWorker((current, message) => {
            if (message.type === 'run') {
                queueMicrotask(() => current.emit({
                    type: 'rpc',
                    id: 3,
                    channel: 'model',
                    method: 'call',
                    args: ['utility', { prompt: 'fail' }],
                }));
            }
            if (message.type === 'rpc-reply') {
                errorText = message.error ?? '';
                queueMicrotask(() => current.emit({ type: 'done', writes: [], result: null }));
            }
        });

        await expect(runSandbox('export default async function () {}', facade, ['model:utility'], {
            createWorker: () => worker,
            mod,
        })).resolves.toBeNull();

        expect(errorText).toBe('[sandbox] model call failed');
        expect(errorText).not.toMatch(/provider|secret-key|apiKey|Authorization/i);
    });

    it('aborts an in-flight host model call when the worker deadline settles the run', async () => {
        let aborted = false;
        const facade = makeFacade({
            model: {
                call: vi.fn((_role, request) => new Promise<{ content: string }>((_resolve, reject) => {
                    request.signal?.addEventListener('abort', () => {
                        aborted = true;
                        reject(new Error('fetch aborted'));
                    }, { once: true });
                })),
                callJson: vi.fn(),
                available: vi.fn(() => true),
            },
        });
        const worker = new FakeWorker((current, message) => {
            if (message.type === 'run') {
                queueMicrotask(() => current.emit({
                    type: 'rpc',
                    id: 4,
                    channel: 'model',
                    method: 'call',
                    args: ['utility', { prompt: 'hang' }],
                }));
            }
        });

        await expect(runSandbox('export default async function () {}', facade, ['model:utility'], {
            createWorker: () => worker,
            deadlineMs: 5,
            mod,
        })).rejects.toThrow('deadline exceeded (5 ms)');

        expect(aborted).toBe(true);
        expect(worker.terminated).toBe(true);
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

