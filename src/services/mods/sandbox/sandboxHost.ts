import { callModelJson, MODEL_ROLES, type HostFacade, type FacadeWrites, type ModelRequest, type ModelRole } from '../../turn/hostFacade';
import { buildWorkerSource } from './workerPrelude';
import {
    MAX_INBOUND_MESSAGES,
    MAX_JOURNAL_ENTRIES,
    MAX_MODEL_CALLS_PER_RUN,
    MAX_MODEL_TOKENS_PER_CALL,
    SANDBOX_DEADLINE_MS,
    type SandboxDoneMessage,
    type SandboxJournalEntry,
    type SandboxRpcMessage,
    type SandboxHostMessage,
    type SandboxSnapshot,
    type SandboxWorkerLike,
    SandboxFaultError,
    type SandboxWorkerMessage,
} from './sandboxTypes';
import { buildModContext, type ModContextMod } from '../modContext';
import type { LocationEntry } from '../../../types';

/**
 * Phase 4.0 — the per-mod identity the sandbox needs to resolve bare table
 * names (`API.md` §6.2) and to project the `ModContext` shape into the worker
 * (`API.md` §8.6 item 1). Required on every `runSandbox` call: a sandboxed
 * compute mod is a `ModContext` consumer, not a `FacadeData` consumer.
 */
export type SandboxModIdentity = ModContextMod;

const WRITE_NAMES = [
    'updateContext',
    'updateNPC',
    'addMessage',
    'setDivergenceRegister',
    'addNpcSuggestions',
    'archiveNPC',
    'restoreNPC',
    'updatePlayerCharacter',
    'setCharacterSheet',
    'setInventory',
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
    const kind = /journal cap exceeded|maximum \d+ entries exceeded|inbound message cap exceeded|model call cap exceeded/i.test(message)
        ? 'flood'
        : 'threw';
    const error = new SandboxFaultError(kind, message);
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

function modelCapability(role: ModelRole): string {
    return 'model:' + role;
}

function isModelRole(value: unknown): value is ModelRole {
    return typeof value === 'string' && (MODEL_ROLES as readonly string[]).includes(value);
}

function clampModelRequest(value: unknown): ModelRequest {
    if (!value || typeof value !== 'object' || typeof (value as { prompt?: unknown }).prompt !== 'string') {
        throw new Error('[sandbox] model request requires a prompt');
    }
    const input = value as Record<string, unknown>;
    const requestedTokens = typeof input.maxTokens === 'number' && Number.isFinite(input.maxTokens)
        ? Math.floor(input.maxTokens)
        : MAX_MODEL_TOKENS_PER_CALL;
    const request: ModelRequest = {
        prompt: input.prompt as string,
        maxTokens: Math.max(1, Math.min(MAX_MODEL_TOKENS_PER_CALL, requestedTokens)),
    };
    if (typeof input.temperature === 'number' && Number.isFinite(input.temperature)) request.temperature = input.temperature;
    if (input.priority === 'high' || input.priority === 'normal' || input.priority === 'low') request.priority = input.priority;
    if (typeof input.trackingLabel === 'string') request.trackingLabel = input.trackingLabel;
    if (typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0) request.timeoutMs = input.timeoutMs;
    return request;
}

function safeModelError(error: unknown): Error {
    const message = asError(error).message;
    if (message.startsWith('[sandbox]') && !/apiKey|endpoint|authorization|bearer|https?:\/\//i.test(message)) {
        return new Error(message);
    }
    return new Error('[sandbox] model call failed');
}

type ModelBudget = { calls: number };

function consumeModelCall(budget: ModelBudget): void {
    if (budget.calls >= MAX_MODEL_CALLS_PER_RUN) {
        throw new SandboxFaultError('flood', '[sandbox] model call cap exceeded (' + MAX_MODEL_CALLS_PER_RUN + ')');
    }
    budget.calls += 1;
}

function isWriteName(value: string): value is SandboxWriteName {
    return (WRITE_NAMES as readonly string[]).includes(value);
}

/**
 * Phase 4.0 / `API.md` §6.2 — resolve a mod-supplied table name to the
 * namespaced name the host adapter and capability check use. The mod may pass
 * the bare declared name (`'arcs'`) or the fully-qualified own name
 * (`'mod.arc.arcs'`); both resolve to the same table. Cross-mod names
 * (`'mod.other.arcs'`) are rejected. Mirrors `resolveOwnTableName` in
 * `modContext.ts` so the journal, the table RPC, and the `ModContext.table`
 * adapter all agree on what a bare name means.
 */
function resolveOwnTableName(modId: string, name: string): string {
    if (typeof name !== 'string' || name.trim() === '') {
        throw new Error('[sandbox] table name must be a non-empty string');
    }
    const trimmed = name.trim();
    const ownPrefix = 'mod.' + modId + '.';
    if (trimmed.startsWith(ownPrefix)) return trimmed;
    if (trimmed.startsWith('mod.')) {
        throw new Error(`[sandbox] a mod may not reach another mod's tables ("${trimmed}")`);
    }
    return ownPrefix + trimmed;
}

/** Validate every journal entry before any host write is invoked. All-or-nothing. */
export function validateJournal(
    writes: readonly SandboxJournalEntry[],
    capabilities: readonly string[],
    modId: string = '',
): void {
    if (!Array.isArray(writes)) throw new SandboxFaultError('journal-rejected', '[sandbox] journal rejected: writes must be an array');
    if (writes.length > MAX_JOURNAL_ENTRIES) {
        throw new SandboxFaultError('flood', `[sandbox] journal rejected: maximum ${MAX_JOURNAL_ENTRIES} entries exceeded`);
    }

    for (const entry of writes) {
        if (!entry || typeof entry.kind !== 'string') {
            throw new SandboxFaultError('journal-rejected', '[sandbox] journal rejected: malformed entry');
        }
        if (entry.kind === 'store') {
            const storeEntry = entry as { kind: 'store'; name: string; args: unknown[] };
            if (typeof storeEntry.name !== 'string' || !Array.isArray(storeEntry.args)) {
                throw new SandboxFaultError('journal-rejected', '[sandbox] journal rejected: malformed store entry');
            }
            if (!isWriteName(storeEntry.name)) {
                throw new SandboxFaultError('journal-rejected', `[sandbox] journal rejected: unknown write "${storeEntry.name}"`);
            }
            if (!hasCapability(capabilities, writeCapability(storeEntry.name))) {
                throw new SandboxFaultError('journal-rejected', `[sandbox] journal rejected: undeclared write "${storeEntry.name}"`);
            }
        } else if (entry.kind === 'table') {
            const tableEntry = entry as { kind: 'table'; name: string; rows: unknown };
            if (typeof tableEntry.name !== 'string' || tableEntry.name.trim() === '') {
                throw new SandboxFaultError('journal-rejected', '[sandbox] journal rejected: malformed table entry');
            }
            const resolvedName = modId ? resolveOwnTableName(modId, tableEntry.name) : tableEntry.name;
            if (!hasCapability(capabilities, tableCapability('write', resolvedName))) {
                throw new SandboxFaultError('journal-rejected', `[sandbox] journal rejected: undeclared table write "${tableEntry.name}"`);
            }
        } else {
            throw new SandboxFaultError('journal-rejected', `[sandbox] journal rejected: unknown entry kind "${String((entry as { kind: string }).kind)}"`);
        }
    }
}

/** Apply a previously validated journal in issue order, atomically. */
export function applyJournal(
    facade: HostFacade,
    writes: readonly SandboxJournalEntry[],
    capabilities: readonly string[],
    modId: string = '',
): void {
    validateJournal(writes, capabilities, modId);
    for (const entry of writes) {
        if (entry.kind === 'store') {
            const storeEntry = entry as { kind: 'store'; name: string; args: unknown[] };
            // Phase 2.3 / API.md §8.2 — two writes were renamed on the mod surface
            // so the capability string, the write, and the read agree. The host
            // facade still carries the old names (`setCharacterProfileData`,
            // `setInventoryItems`); map the mod-facing name back here so the
            // journal applies to the right callback. This keeps the sandbox
            // surface (the new names) and the host facade (the old names)
            // aligned without renaming the host's internal API in this phase.
            const facadeName = SANDBOX_WRITE_TO_FACADE_NAME[storeEntry.name] ?? storeEntry.name;
            const method = facade.write[facadeName as keyof FacadeWrites] as unknown as (...args: unknown[]) => void;
            method(...storeEntry.args);
        } else {
            const tableEntry = entry as { kind: 'table'; name: string; rows: unknown };
            const resolvedName = modId ? resolveOwnTableName(modId, tableEntry.name) : tableEntry.name;
            facade.table.write(resolvedName, tableEntry.rows);
        }
    }
}

/**
 * `API.md` §8.2 — the two renamed writes. The mod surface uses the new names
 * (`setCharacterSheet`, `setInventory`); the host facade still exposes the
 * old names. This map is the single point of translation so a mod's
 * `ctx.write.setCharacterSheet(...)` reaches `facade.write.setCharacterProfileData(...)`.
 */
const SANDBOX_WRITE_TO_FACADE_NAME: Record<string, string> = {
    setCharacterSheet: 'setCharacterProfileData',
    setInventory: 'setInventoryItems',
};

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
    modId: string = '',
): Promise<unknown> {
    // Only `read` is an immediate RPC. `write` is journalled by the worker
    // prelude and applied atomically on clean return (WO-P5-14); a `write`
    // RPC from a worker is a stale or crafted source and is rejected.
    if (message.method !== 'read') {
        return Promise.reject(new Error('[sandbox] table RPC supports only read; write is journalled'));
    }

    const table = message.args[0];
    if (typeof table !== 'string' || table.trim() === '') {
        return Promise.reject(new Error('[sandbox] table RPC requires a table name'));
    }

    const resolvedName = modId ? resolveOwnTableName(modId, table) : table;
    const capability = tableCapability('read', resolvedName);
    if (!hasCapability(capabilities, capability)) {
        return Promise.reject(new Error(`[sandbox] capability denied: ${capability}`));
    }

    if (message.args.length !== 1) {
        return Promise.reject(new Error('[sandbox] table read requires exactly one argument'));
    }
    return facade.table.read(resolvedName);
}

async function handleModelRpc(
    facade: HostFacade,
    message: SandboxRpcMessage,
    capabilities: readonly string[],
    modelSignal: AbortSignal,
    budget: ModelBudget,
): Promise<{ content: unknown }> {
    if (message.method !== 'call' && message.method !== 'callJson') {
        throw new Error('[sandbox] model RPC requires call or callJson');
    }
    if (message.args.length < 2 || message.args.length > 3) {
        throw new Error('[sandbox] model RPC requires role and request');
    }
    const rawRole = message.args[0];
    if (!isModelRole(rawRole)) throw new Error('[sandbox] unknown model role: ' + String(rawRole));
    const role = rawRole;
    const capability = modelCapability(role);
    if (!hasCapability(capabilities, capability)) {
        throw new Error('[sandbox] capability denied: ' + capability);
    }
    if (!facade.model.available(role)) {
        throw new Error('[sandbox] model role not configured: ' + role);
    }
    const request = clampModelRequest(message.args[1]);
    const brokerCall = async (callRole: ModelRole, callRequest: ModelRequest) => {
        consumeModelCall(budget);
        try {
            const response = await facade.model.call(callRole, { ...callRequest, signal: modelSignal });
            return { content: String(response.content) };
        } catch (error) {
            throw safeModelError(error);
        }
    };
    if (message.method === 'call') return brokerCall(role, request);
    const rawOptions = message.args[2];
    const options = rawOptions && typeof rawOptions === 'object' ? rawOptions as { retries?: number } : {};
    const parsed = await callModelJson(role, request, brokerCall, options);
    return { content: parsed };
}

function handleRpc(
    facade: HostFacade,
    message: SandboxRpcMessage,
    capabilities: readonly string[],
    modelSignal: AbortSignal,
    budget: ModelBudget,
    modId: string,
    buildSnapshot: () => SandboxSnapshot,
): Promise<unknown> {
    if (message.channel === 'table') return handleTableRpc(facade, message, capabilities, modId);
    if (message.channel === 'model') return handleModelRpc(facade, message, capabilities, modelSignal, budget);
    if (message.channel !== 'refresh') {
        return Promise.reject(new Error('[sandbox] unknown RPC channel: ' + String(message.channel)));
    }
    if (message.method !== undefined || message.args.length !== 0) {
        return Promise.reject(new Error('[sandbox] refresh RPC takes no arguments'));
    }
    // Phase 4.0 — refresh returns the `ModContext`-shape snapshot, not the raw
    // `FacadeData`/`FacadeConfig`. The worker prelude projects the snapshot
    // onto `ctx.data`/`ctx.config`/`ctx.mod`/`ctx.api`; a mod that calls
    // `await ctx.refresh()` and reads `ctx.data.playerInput` gets the new
    // value, not `undefined` (`API.md` §8.6 item 1).
    return Promise.resolve(buildSnapshot());
}
function isDoneMessage(message: SandboxWorkerMessage): message is SandboxDoneMessage {
    return message.type === 'done';
}

/**
 * Phase 4.0 — project a `HostFacade` into the `ModContext`-shape snapshot
 * handed to the worker. `data` is in `ModData` shape (renamed `playerInput`,
 * promoted `playerCharacter`/`characterSheet`/`inventory`, derived
 * `location`), `config` is the narrow `ModConfig` (`{ aiTier }`), and
 * `mod`/`api` carry the identity and `commitPoint: 'on-return'`. The
 * `ModContext` itself is built once per run by `runSandbox`; this helper
 * builds the snapshot for the initial run message and the `refresh` RPC
 * reply so they agree.
 */
function buildSandboxSnapshot(
    mod: SandboxModIdentity,
    facade: HostFacade,
    locationState?: {
        readonly currentPlaceId: string | null;
        readonly currentFeature: string | null;
        readonly ledger: readonly LocationEntry[];
    },
): SandboxSnapshot {
    const context = buildModContext({
        mod,
        facade,
        commitPoint: 'on-return',
        locationState,
    });
    return {
        mod: { id: context.mod.id, name: context.mod.name, version: context.mod.version },
        api: {
            version: context.api.version,
            commitPoint: context.api.commitPoint,
            // Phase 5.3 — publish the suppressible set on the sandbox path
            // too. A compute mod does not suppress (it has no interceptor), but
            // the snapshot's `api` shape must agree with the native one so the
            // `.d.ts`'s `ModApi` is truthful on both paths.
            suppressibleIds: context.api.suppressibleIds,
        },
        data: context.data as unknown as Readonly<Record<string, unknown>>,
        config: context.config as unknown as Readonly<Record<string, unknown>>,
    };
}

/**
 * Run one compute module in one Worker. A rejected promise means the journal was discarded.
 * Writes are applied only inside the clean `done` branch after the whole journal validates.
 *
 * Phase 4.0 / `API.md` §8.6 item 1 — `mod` is required. The worker receives a
 * `ModContext`-shape snapshot (projected from `facade`), not the raw
 * `FacadeData`; the bare-name own-table alias resolves (`ctx.table.read('arcs')`
 * and `ctx.table.read('mod.arc.arcs')` are the same table); `subscribe`,
 * `events`, `mounts`, and `macros` throw "native tier only" on the worker
 * side (`EVENTS.md` §5.1 / `MOUNTS.md` §8.1 / Phase 5.1 §2).
 */
export async function runSandbox(
    modSource: string,
    facade: HostFacade,
    capabilities: readonly string[],
    options: SandboxHostOptions & {
        mod?: SandboxModIdentity;
        locationState?: {
            readonly currentPlaceId: string | null;
            readonly currentFeature: string | null;
            readonly ledger: readonly LocationEntry[];
        };
    } = {},
): Promise<unknown> {
    const deadlineMs = options.deadlineMs ?? SANDBOX_DEADLINE_MS;
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
        throw new Error('[sandbox] deadline must be a positive finite number');
    }
    const mod = options.mod;
    if (!mod) {
        throw new Error('[sandbox] runSandbox requires a mod identity (Phase 4.0 / API.md §8.6 item 1)');
    }
    const locationState = options.locationState;

    const workerFactory = options.createWorker ?? createBrowserWorker;
    let worker: SandboxWorkerLike;
    try {
        worker = workerFactory(buildWorkerSource(modSource));
    } catch (error) {
        throw new SandboxFaultError('worker-error', asError(error).message);
    }

    return await new Promise<unknown>((resolve, reject) => {
        let settled = false;
        let inboundMessages = 0;
        const pendingRpc = new Set<number>();
        const modelAbort = new AbortController();
        const modelBudget: ModelBudget = { calls: 0 };

        const cleanup = () => {
            modelAbort.abort();
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
                .then(() => handleRpc(facade, message, capabilities, modelAbort.signal, modelBudget, mod.id, () => buildSandboxSnapshot(mod, facade.refresh(), locationState)))
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
                        postErrorReply(worker, message.id, message.channel === 'model' ? safeModelError(error) : error);
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
                    applyJournal(facade, message.writes, capabilities, mod.id);
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
            finish({ ok: false, error: new SandboxFaultError('worker-error', event.message || '[sandbox] browser Worker error') });
        };

        worker.onmessage = onMessage;
        worker.onerror = onError;

        const timer = setTimeout(() => {
            finishWithAbort(new SandboxFaultError('deadline', `[sandbox] deadline exceeded (${deadlineMs} ms)`));
        }, Math.max(1, deadlineMs));

        facade.signal.addEventListener('abort', onAbort, { once: true });
        if (facade.signal.aborted) {
            onAbort();
            return;
        }

        try {
            const snapshot = buildSandboxSnapshot(mod, facade, locationState);
            const runMessage: SandboxHostMessage = {
                type: 'run',
                snapshot,
                deadlineMs,
                modelRoles: MODEL_ROLES.filter((role) => facade.model.available(role)),
            };
            worker.postMessage(runMessage);
        } catch (error) {
            finish({ ok: false, error });
        }
    });
}

export const runSandboxMod = runSandbox;

