import type {
    FacadeConfig,
    FacadeData,
    FacadeWrites,
    ModelJsonOptions,
    ModelRequest,
    ModelResponse,
    ModelRole,
} from '../../turn/hostFacade';

/**
 * Project 5 / WO-P5-09 — the browser-worker sandbox wire contract.
 *
 * The worker is a defence-in-depth boundary for buggy, hand-installed, local mods in a
 * single-user application. It is not a claim that determined code with JavaScript execution
 * cannot find an escape. The server never executes this code; the browser worker is the only
 * runtime for a compute mod.
 */

/** Termination begins at the deadline; host control returns after teardown. */
export const SANDBOX_DEADLINE_MS = 5000;
/** Tolerance band for worker teardown after termination begins. */
export const SANDBOX_TEARDOWN_MS = 50;
/** Maximum number of journalled writes (store + table) a single clean run may carry. */
export const MAX_JOURNAL_ENTRIES = 500;
/** Maximum number of inbound worker messages handled by the host in a single run. */
export const MAX_INBOUND_MESSAGES = 1000;
/** Maximum brokered model calls in one compute run; callJson retries count individually. */
export const MAX_MODEL_CALLS_PER_RUN = 3;
/** Maximum requested output tokens for one brokered model call. */
export const MAX_MODEL_TOKENS_PER_CALL = 2048;
/** Three consecutive faulted runs latch a mod until the app reloads. */
export const SANDBOX_FAULT_STRIKES = 3;

export type SandboxFaultKind =
    | 'deadline'
    | 'threw'
    | 'worker-error'
    | 'journal-rejected'
    | 'flood'
    | 'load';

/** A host-classified sandbox failure that is safe to surface to the policy layer. */
export class SandboxFaultError extends Error {
    readonly kind: SandboxFaultKind;

    constructor(kind: SandboxFaultKind, message: string) {
        super(message);
        this.name = 'SandboxFaultError';
        this.kind = kind;
    }
}


export interface SandboxSnapshot {
    readonly data: FacadeData;
    readonly config: FacadeConfig;
}

/**
 * A deliberately untrusted journal entry received from a worker.
 *
 * The journal is a tagged union of store and table entries. Both kinds are
 * appended in issue order and applied atomically on clean return only, so a
 * mod that writes the store, then a table, then the store again has those
 * three applied in that order (WO-P5-14, closing the §7.3 defect).
 *
 * v1 limitation, documented here so it is found as a decision rather than a
 * bug: a mod that writes a table and then reads the same table in the same
 * run sees the OLD value, because the write is still pending in the journal.
 * The alternative is a read-overlay shadowing pending writes, which is real
 * machinery for a pattern no measured feature uses (a compute mod holds its
 * working data in a local variable and writes once at the end, as Arc does).
 */
export type SandboxJournalEntry =
    | { readonly kind: 'store'; readonly name: string; readonly args: unknown[] }
    | { readonly kind: 'table'; readonly name: string; readonly rows: unknown };

export interface SandboxRunMessage {
    readonly type: 'run';
    readonly snapshot: SandboxSnapshot;
    readonly deadlineMs: number;
    readonly modelRoles: readonly ModelRole[];
}

export interface SandboxAbortMessage {
    readonly type: 'abort';
}

export interface SandboxRpcReplyMessage {
    readonly type: 'rpc-reply';
    readonly id: number;
    readonly ok: boolean;
    readonly value?: unknown;
    readonly error?: string;
}

export type SandboxHostMessage = SandboxRunMessage | SandboxAbortMessage | SandboxRpcReplyMessage;

export interface SandboxDoneMessage {
    readonly type: 'done';
    readonly writes: SandboxJournalEntry[];
    readonly result: unknown;
}

export interface SandboxErrorMessage {
    readonly type: 'error';
    readonly message: string;
    readonly stack?: string;
    readonly kind?: Exclude<SandboxFaultKind, 'load'>;
}

export interface SandboxRpcMessage {
    readonly type: 'rpc';
    readonly id: number;
    readonly channel: 'table' | 'refresh' | 'model';
    readonly method?: 'read' | 'call' | 'callJson';
    readonly args: unknown[];
}

export interface SandboxLogMessage {
    readonly type: 'log';
    readonly args: unknown[];
}

export type SandboxWorkerMessage =
    | SandboxDoneMessage
    | SandboxErrorMessage
    | SandboxRpcMessage
    | SandboxLogMessage;

/** The injectable Worker seam used by jsdom unit tests and the real browser implementation. */
export interface SandboxWorkerLike {
    onmessage: ((event: MessageEvent<SandboxWorkerMessage>) => void) | null;
    onerror: ((event: ErrorEvent) => void) | null;
    postMessage(message: SandboxHostMessage): void;
    terminate(): void;
}

/**
 * The table adapter the mod sees inside the worker.
 *
 * `read` is an immediate RPC: it crosses the worker boundary and returns the
 * committed value. `write` is journalled and returns immediately (void); the
 * host applies it on clean return only, atomically with store writes
 * (WO-P5-14, closing the 06_FACADE.md §7.3 defect).
 *
 * v1 limitation: a mod that writes a table then reads the same table in the
 * same run sees the OLD value, because the write is still pending. Reads do
 * not shadow pending writes — the pattern no measured feature uses. A
 * compute mod holds its working data in a local variable and writes once at
 * the end, as Arc does.
 */
export interface SandboxTableAdapter {
    read(name: string): Promise<unknown>;
    write(name: string, rows: unknown): void;
}

/**
 * The context reconstructed inside a compute worker.
 *
 * `refresh()` is intentionally asynchronous here and returns a fresh snapshot rather than a
 * `HostFacade`: a synchronous facade cannot cross the worker boundary.
 * Model calls are brokered through the host and never carry an EndpointConfig into this context.
 */
export interface SandboxContext {
    readonly data: FacadeData;
    readonly config: FacadeConfig;
    readonly write: FacadeWrites;
    readonly model: {
        call(role: ModelRole, req: ModelRequest): Promise<ModelResponse>;
        callJson(role: ModelRole, req: ModelRequest, options?: ModelJsonOptions): Promise<unknown>;
        available(role: ModelRole): boolean;
    };
    readonly table: SandboxTableAdapter;
    readonly signal: AbortSignal;
    refresh(): Promise<SandboxSnapshot>;
    log(...args: unknown[]): void;
}

