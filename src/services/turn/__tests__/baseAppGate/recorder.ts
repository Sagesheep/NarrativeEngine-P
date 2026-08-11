// Phase 0.5 — Recorder for the canonical turn + post-turn effect trace.
//
// Wraps every callback, API call, background-queue push, and lifecycle event
// the turn pipeline emits. The trace is the ordered list of effects, plus the
// full OpenAIMessage[] payload. The gate asserts byte-identity against the
// checked-in baseline.
//
// Recording is append-only and ordered. Effects are stamped with a monotonic
// sequence number so a sort is a no-op (we never reorder). The trace does
// NOT normalize, redact, or weaken the comparison (Phase 0.5 §2): a changed
// byte is a changed base-app behavior.

import type { ChatMessage, NPCEntry, PipelinePhase, GameContext, ArchiveIndexEntry, TimelineEvent, DivergenceRegister, CharacterProfile, InventoryItem, LocationEntry, LocationSuggestion } from '../../../../types';
import type { TurnCallbacks } from '../../turnOrchestrator';
import type { PayloadTrace } from '../../../../types';
import type { OpenAIMessage } from '../../llm/llmService';

export type EffectKind =
    | 'callback'
    | 'api'
    | 'queue.push'
    | 'queue.start'
    | 'queue.complete'
    | 'lifecycle';

export type RecordedEffect = {
    seq: number;
    kind: EffectKind;
    name: string;
    args?: unknown;
    result?: unknown;
};

export type CanonicalTrace = {
    payload: OpenAIMessage[];
    payloadTrace?: PayloadTrace[];
    effects: RecordedEffect[];
    finalMessages: ChatMessage[];
};

export class Recorder {
    private seq = 0;
    readonly effects: RecordedEffect[] = [];
    payload: OpenAIMessage[] | null = null;
    payloadTrace: PayloadTrace[] | undefined;
    finalMessages: ChatMessage[] = [];

    private next(): number { return ++this.seq; }

    recordCallback(name: string, args?: unknown, result?: unknown): void {
        this.effects.push({ seq: this.next(), kind: 'callback', name, args: deepNormalize(args), result: deepNormalize(result) });
    }
    recordApi(name: string, args?: unknown, result?: unknown): void {
        this.effects.push({ seq: this.next(), kind: 'api', name, args: deepNormalize(args), result: deepNormalize(result) });
    }
    recordQueuePush(label: string): void {
        this.effects.push({ seq: this.next(), kind: 'queue.push', name: label });
    }
    recordQueueStart(label: string): void {
        this.effects.push({ seq: this.next(), kind: 'queue.start', name: label });
    }
    recordQueueComplete(label: string, result?: unknown): void {
        this.effects.push({ seq: this.next(), kind: 'queue.complete', name: label, result: deepNormalize(result) });
    }
    recordLifecycle(name: string, args?: unknown): void {
        this.effects.push({ seq: this.next(), kind: 'lifecycle', name, args: deepNormalize(args) });
    }

    setPayload(messages: OpenAIMessage[], trace?: PayloadTrace[]): void {
        this.payload = messages;
        this.payloadTrace = trace;
    }

    setFinalMessages(messages: ChatMessage[]): void {
        this.finalMessages = messages;
    }

    toTrace(): CanonicalTrace {
        if (!this.payload) throw new Error('Recorder: payload was never set');
        return {
            payload: deepNormalize(this.payload) as OpenAIMessage[],
            payloadTrace: deepNormalize(this.payloadTrace) as PayloadTrace[] | undefined,
            effects: this.effects,
            finalMessages: deepNormalize(this.finalMessages) as ChatMessage[],
        };
    }
}

// ── deepNormalize ───────────────────────────────────────────────────────
// Functions, Symbols, class instances, and circular refs are not part of the
// byte contract. JSON.stringify with a stable replacer is the canonical form.
// We DO NOT redact or sort — the gate's whole point is that an unchanged base
// app produces an unchanged string. The replacer only drops keys whose values
// are functions (e.g. bound callback refs carried on state) so the trace is
// JSON-serializable.

export function deepNormalize<T>(value: T): T {
    if (value === null || value === undefined) return value;
    if (typeof value === 'function') return '[Function]' as unknown as T;
    if (typeof value !== 'object') return value;
    try {
        return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'function' ? '[Function]' : v))) as T;
    } catch {
        return '[Unserializable]' as unknown as T;
    }
}

// ── Recording callback wrapper ──────────────────────────────────────────
// Wraps a TurnCallbacks object so every callback fires the recorder. The
// underlying store still receives the calls — recording is observational,
// not interceptive. The recorder is the ONLY place effects are stamped; the
// store mutates state but never writes to the trace.

export function wrapCallbacksWithRecorder(
    inner: TurnCallbacks,
    recorder: Recorder,
): TurnCallbacks {
    const wrap = <A extends unknown[]>(name: string, fn: (...a: A) => void) =>
        (...a: A): void => {
            recorder.recordCallback(name, a);
            fn(...a);
        };
    const wrapOptional = <A extends unknown[]>(name: string, fn: ((...a: A) => void) | undefined) =>
        fn ? wrap(name, fn) : undefined;

    return {
        onCheckingNotes: wrap('onCheckingNotes', inner.onCheckingNotes),
        addMessage: wrap('addMessage', inner.addMessage),
        updateLastAssistant: wrap('updateLastAssistant', inner.updateLastAssistant),
        updateLastMessage: wrap('updateLastMessage', inner.updateLastMessage),
        updateLastAssistantMessage: wrap('updateLastAssistantMessage', inner.updateLastAssistantMessage),
        updateContext: wrap('updateContext', inner.updateContext),
        getFreshLocationState: inner.getFreshLocationState,
        setCharacterProfileData: wrap('setCharacterProfileData', inner.setCharacterProfileData),
        setInventoryItems: wrap('setInventoryItems', inner.setInventoryItems),
        setLocationLedger: wrap('setLocationLedger', inner.setLocationLedger),
        addLocationSuggestions: wrap('addLocationSuggestions', inner.addLocationSuggestions),
        setArchiveIndex: wrap('setArchiveIndex', inner.setArchiveIndex),
        setTimeline: wrapOptional('setTimeline', inner.setTimeline),
        updateNPC: wrap('updateNPC', inner.updateNPC),
        addNPC: wrap('addNPC', inner.addNPC),
        setCondensed: wrap('setCondensed', inner.setCondensed),
        setStreaming: wrap('setStreaming', inner.setStreaming),
        setLastPayloadTrace: wrapOptional('setLastPayloadTrace', inner.setLastPayloadTrace),
        setLoadingStatus: wrapOptional('setLoadingStatus', inner.setLoadingStatus),
        setPipelinePhase: wrapOptional('setPipelinePhase', inner.setPipelinePhase),
        setDivergenceRegister: wrapOptional('setDivergenceRegister', inner.setDivergenceRegister),
        setOnStageNpcIds: wrapOptional('setOnStageNpcIds', inner.setOnStageNpcIds),
        addNpcSuggestions: wrapOptional('addNpcSuggestions', inner.addNpcSuggestions),
        archiveNPC: wrap('archiveNPC', inner.archiveNPC),
        restoreNPC: wrap('restoreNPC', inner.restoreNPC),
        stageInventoryProposal: wrapOptional('stageInventoryProposal', inner.stageInventoryProposal),
        onDirectorBriefPhase: wrapOptional('onDirectorBriefPhase', inner.onDirectorBriefPhase),
        persistTurnState: wrapOptional('persistTurnState', inner.persistTurnState),
    };
}

// Type-only re-exports for the recorder's benefit.
export type {
    ChatMessage,
    NPCEntry,
    PipelinePhase,
    GameContext,
    ArchiveIndexEntry,
    TimelineEvent,
    DivergenceRegister,
    CharacterProfile,
    InventoryItem,
    LocationEntry,
    LocationSuggestion,
};