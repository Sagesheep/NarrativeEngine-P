import type {
    FacadeConfig,
    FacadeData,
    FacadeWrites,
    HostFacadeTableAdapter,
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
/** Maximum number of synchronous writes a single clean run may journal. */
export const MAX_JOURNAL_ENTRIES = 500;
/** Maximum number of inbound worker messages handled by the host in a single run. */
export const MAX_INBOUND_MESSAGES = 1000;

export interface SandboxSnapshot {
    readonly data: FacadeData;
    readonly config: FacadeConfig;
}

/** A deliberately untrusted journal entry received from a worker. */
export interface SandboxJournalEntry {
    readonly name: string;
    readonly args: unknown[];
}

export interface SandboxRunMessage {
    readonly type: 'run';
    readonly snapshot: SandboxSnapshot;
    readonly deadlineMs: number;
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
}

export interface SandboxRpcMessage {
    readonly type: 'rpc';
    readonly id: number;
    readonly channel: 'table' | 'refresh';
    readonly method?: 'read' | 'write';
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
 * The context reconstructed inside a compute worker.
 *
 * `refresh()` is intentionally asynchronous here and returns a fresh snapshot rather than a
 * `HostFacade`: a synchronous facade cannot cross the worker boundary. `model` is absent in 3.4;
 * model access arrives in 3.6.
 */
export interface SandboxContext {
    readonly data: FacadeData;
    readonly config: FacadeConfig;
    readonly write: FacadeWrites;
    readonly table: HostFacadeTableAdapter;
    readonly signal: AbortSignal;
    refresh(): Promise<SandboxSnapshot>;
    log(...args: unknown[]): void;
}

