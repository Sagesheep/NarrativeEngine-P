import type { HostFacade, FacadeWrites } from '../../turn/hostFacade';
import { buildWorkerSource } from './workerPrelude';
import {
    MAX_INBOUND_MESSAGES,
    MAX_JOURNAL_ENTRIES,
    SANDBOX_DEADLINE_MS,
    type SandboxDoneMessage,
    type SandboxJournalEntry,
    type SandboxRpcMessage,
    type SandboxHostMessage,
    type SandboxWorkerLike,
    type SandboxWorkerMessage,
} from './sandboxTypes';

const WRITE_NAMES = [
    'updateContext',
    'updateNPC',
    'addMessage',
    'addEnemySuggestions',
    'setDivergenceRegister',
    'addNpcSuggestions',
    'archiveNPC',
    'restoreNPC',
    'onDirectorBriefPhase',
    'updatePlayerCharacter',
    'setCharacterProfileData',
    'setInventoryItems',
    'setLocationLedger',
    'addLocationSuggestions',
] as const;

type SandboxWriteName = typeof WRITE_NAMES[number];

/** The only browser seam used by the host; unit tests inject a fake because jsdom has no Worker. */
export interface SandboxHostOptions {
    createWorker?: (source: string) => SandboxWorkerLike;
    /** Test-only override; production defaults to the named work-order deadline. */
    deadlineMs?: number;
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function workerError(message: string, stack?: string): Error {
    const error = new Error(message);
    if (stack) error.stack = stack;
    return error;
}

function writeCapability(name: string): string {
    return `write:${name}`;
}

function tableCapability(method: 'read' | 'write', name: string): string {
    return `table:${method}:${name}`;
}

function hasCapability(capabilities: readonly string[], capability: string): boolean {
    return capabilities.includes(capability);
}

function isWriteName(value: string): value is SandboxWriteName {
    return (WRITE_NAMES as readonly string[]).includes(value);
}

/** Validate every journal entry before any host write is invoked. */
export function validateJournal(
    writes: readonly SandboxJournalEntry[],
    capabilities: readonly string[],
): void {
    if (!Array.isArray(writes)) throw new Error('[sandbox] journal rejected: writes must be an array');
    if (writes.length > MAX_JOURNAL_ENTRIES) {
        throw new Error(`[sandbox] journal rejected: maximum ${MAX_JOURNAL_ENTRIES} entries exceeded`);
    }

    for (const entry of writes) {
        if (!entry || typeof entry.name !== 'string' || !Array.isArray(entry.args)) {
            throw new Error('[sandbox] journal rejected: malformed entry');
        }
        if (!isWriteName(entry.name)) {
            throw new Error(`[sandbox] journal rejected: unknown write "${entry.name}"`);
        }
        if (!hasCapability(capabilities, writeCapability(entry.name))) {
            throw new Error(`[sandbox] journal rejected: undeclared write "${entry.name}"`);
        }
    }
}

/** Apply a previously validated journal in registration order. */
export function applyJournal(
    facade: HostFacade,
    writes: readonly SandboxJournalEntry[],
    capabilities: readonly string[],
): void {
    validateJournal(writes, capabilities);
    for (const entry of writes) {
        const method = facade.write[entry.name as keyof FacadeWrites] as unknown as (...args: unknown[]) => void;
        method(...entry.args);
    }
}

function createBrowserWorker(source: string): SandboxWorkerLike {
    if (typeof Worker === 'undefined') {
        throw new Error('[sandbox] browser Worker is unavailable');
    }
    const scriptUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try {
        return new Worker(scriptUrl) as unknown as SandboxWorkerLike;
    } finally {
        URL.revokeObjectURL(scriptUrl);
    }
}

function postReply(worker: SandboxWorkerLike, id: number, value: unknown): void {
    worker.postMessage({ type: 'rpc-reply', id, ok: true, value });
}

function postErrorReply(worker: SandboxWorkerLike, id: number, error: unknown): void {
    worker.postMessage({ type: 'rpc-reply', id, ok: false, error: asError(error).message });
}

function handleTableRpc(
    facade: HostFacade,
    message: SandboxRpcMessage,
    capabilities: readonly string[],
): Promise<unknown> {
    if (message.method !== 'read' && message.method !== 'write') {
        return Promise.reject(new Error('[sandbox] table RPC requires read or write'));
    }

    const table = message.args[0];
    if (typeof table !== 'string' || table.trim() === '') {
        return Promise.reject(new Error('[sandbox] table RPC requires a table name'));
    }

    const capability = tableCapability(message.method, table);
    if (!hasCapability(capabilities, capability)) {
        return Promise.reject(new Error(`[sandbox] capability denied: ${capability}`));
    }

    if (message.method === 'read') {
        if (message.args.length !== 1) {
            return Promise.reject(new Error('[sandbox] table read requires exactly one argument'));
        }
        return facade.table.read(table);
    }

    if (message.args.length !== 2) {
        return Promise.reject(new Error('[sandbox] table write requires exactly two arguments'));
    }
    return facade.table.write(table, message.args[1]);
}

function handleRpc(
    facade: HostFacade,
    message: SandboxRpcMessage,
    capabilities: readonly string[],
): Promise<unknown> {
    if (message.channel === 'table') return handleTableRpc(facade, message, capabilities);
    if (message.channel !== 'refresh') {
        return Promise.reject(new Error(`[sandbox] unknown RPC channel: ${String(message.channel)}`));
    }
    if (message.method !== undefined || message.args.length !== 0) {
        return Promise.reject(new Error('[sandbox] refresh RPC takes no arguments'));
    }
    const refreshed = facade.refresh();
    return Promise.resolve({ data: refreshed.data, config: refreshed.config });
}

function isDoneMessage(message: SandboxWorkerMessage): message is SandboxDoneMessage {
    return message.type === 'done';
}

/**
 * Run one compute module in one Worker. A rejected promise means the journal was discarded.
 * Writes are applied only inside the clean `done` branch after the whole journal validates.
 */
export async function runSandbox(
    modSource: string,
    facade: HostFacade,
    capabilities: readonly string[],
    options: SandboxHostOptions = {},
): Promise<unknown> {
    const deadlineMs = options.deadlineMs ?? SANDBOX_DEADLINE_MS;
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
        throw new Error('[sandbox] deadline must be a positive finite number');
    }

    const workerFactory = options.createWorker ?? createBrowserWorker;
    const worker = workerFactory(buildWorkerSource(modSource));

    return await new Promise<unknown>((resolve, reject) => {
        let settled = false;
        let inboundMessages = 0;
        const pendingRpc = new Set<number>();

        const cleanup = () => {
            clearTimeout(timer);
            facade.signal.removeEventListener('abort', onAbort);
            worker.onmessage = null;
            worker.onerror = null;
            try {
                worker.terminate();
            } catch {
                // Termination is best effort after the run has already settled.
            }
        };

        const finish = (outcome: { ok: true; value: unknown } | { ok: false; error: unknown }) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (outcome.ok) resolve(outcome.value);
            else reject(asError(outcome.error));
        };

        const abortWorker = () => {
            try {
                worker.postMessage({ type: 'abort' });
            } catch {
                // The worker is about to be terminated; the abort message is best effort.
            }
        };

        const finishWithAbort = (error: unknown) => {
            if (settled) return;
            settled = true;
            abortWorker();
            cleanup();
            reject(asError(error));
        };

        const onAbort = () => {
            finishWithAbort(new Error('[sandbox] run aborted'));
        };

        const onRpc = (message: SandboxRpcMessage) => {
            if (pendingRpc.has(message.id)) {
                finish({ ok: false, error: new Error(`[sandbox] duplicate RPC id: ${message.id}`) });
                return;
            }
            pendingRpc.add(message.id);
            Promise.resolve()
                .then(() => handleRpc(facade, message, capabilities))
                .then((value) => {
                    pendingRpc.delete(message.id);
                    if (settled) return;
                    try {
                        postReply(worker, message.id, value);
                    } catch (error) {
                        finish({ ok: false, error });
                    }
                })
                .catch((error) => {
                    pendingRpc.delete(message.id);
                    if (settled) return;
                    try {
                        postErrorReply(worker, message.id, error);
                    } catch (postError) {
                        finish({ ok: false, error: postError });
                    }
                });
        };

        const onMessage = (event: MessageEvent<SandboxWorkerMessage>) => {
            if (settled) return;
            inboundMessages += 1;
            if (inboundMessages > MAX_INBOUND_MESSAGES) {
                finish({ ok: false, error: new Error(`[sandbox] inbound message cap exceeded (${MAX_INBOUND_MESSAGES})`) });
                return;
            }

            const message = event.data;
            if (isDoneMessage(message)) {
                try {
                    applyJournal(facade, message.writes, capabilities);
                    finish({ ok: true, value: message.result });
                } catch (error) {
                    finish({ ok: false, error });
                }
                return;
            }
            if (message.type === 'error') {
                finish({ ok: false, error: workerError(message.message, message.stack) });
                return;
            }
            if (message.type === 'rpc') {
                onRpc(message);
                return;
            }
            if (message.type === 'log') {
                try {
                    facade.log(...message.args);
                } catch {
                    // Logging is one-way and must not turn a diagnostic failure into a mod fault.
                }
                return;
            }
            finish({ ok: false, error: new Error('[sandbox] unknown worker message') });
        };

        const onError = (event: ErrorEvent) => {
            event.preventDefault();
            finish({ ok: false, error: new Error(event.message || '[sandbox] browser Worker error') });
        };

        worker.onmessage = onMessage;
        worker.onerror = onError;

        const timer = setTimeout(() => {
            finishWithAbort(new Error(`[sandbox] deadline exceeded (${deadlineMs} ms)`));
        }, Math.max(1, deadlineMs));

        facade.signal.addEventListener('abort', onAbort, { once: true });
        if (facade.signal.aborted) {
            onAbort();
            return;
        }

        try {
            const runMessage: SandboxHostMessage = {
                type: 'run',
                snapshot: { data: facade.data, config: facade.config },
                deadlineMs,
            };
            worker.postMessage(runMessage);
        } catch (error) {
            finish({ ok: false, error });
        }
    });
}

export const runSandboxMod = runSandbox;

