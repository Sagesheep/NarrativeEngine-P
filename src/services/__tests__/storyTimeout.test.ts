import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EndpointConfig } from '../../types';

const state = vi.hoisted(() => ({ settings: { storyTimeoutSeconds: 900 as number | undefined } }));
vi.mock('../../store/useAppStore', () => ({ useAppStore: { getState: () => state } }));
vi.mock('../llm/llmFetch', () => ({ llmFetch: vi.fn() }));
vi.mock('../llm/llmRequestQueue', () => ({
    getQueueForEndpoint: () => ({
        acquireSlot: async () => {},
        releaseSlot: vi.fn(),
        onRateLimitHit: vi.fn(),
    }),
}));
vi.mock('../llm/cacheTelemetry', () => ({ recordCacheUsage: vi.fn() }));

import { sendMessage } from '../llm/llmService';
import { llmFetch } from '../llm/llmFetch';
import { clearHistory, extendCall, getActiveCalls, getCallHistory } from '../llm/utilityCallTracker';

const provider = { endpoint: 'http://localhost/v1', modelName: 'test', apiKey: '', apiFormat: 'openai' } as EndpointConfig;
let stream: ReadableStreamDefaultController<Uint8Array>;
let controller: AbortController;
let pending: Promise<void>;
let onError: ReturnType<typeof vi.fn>;
let onDone: ReturnType<typeof vi.fn>;

async function start() {
    onError = vi.fn();
    onDone = vi.fn();
    controller = new AbortController();
    vi.mocked(llmFetch).mockImplementation(async (_url, init) => {
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                stream = c;
                init?.signal?.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')), { once: true });
            },
        });
        return { ok: true, body } as Response;
    });
    pending = sendMessage(provider, [], vi.fn(), onDone, onError, undefined, controller);
    await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
    vi.useFakeTimers();
    state.settings.storyTimeoutSeconds = 900;
    clearHistory();
});
afterEach(async () => {
    controller?.abort();
    await pending;
    vi.useRealTimers();
    vi.clearAllMocks();
});

describe('global story timeout', () => {
    it('waits for the configured first-response deadline and then aborts', async () => {
        await start();
        expect(getActiveCalls()[0].initialTimeoutMs).toBe(900_000);
        await vi.advanceTimersByTimeAsync(899_999);
        expect(controller.signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await pending;
        expect(controller.signal.aborted).toBe(true);
        expect(getCallHistory()[0].status).toBe('timeout');
        expect(onError).toHaveBeenCalledOnce();
    });

    it('resets the full configured idle window after data, keeping active requests stable when settings change', async () => {
        await start();
        await vi.advanceTimersByTimeAsync(800_000);
        state.settings.storyTimeoutSeconds = 30;
        stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
        await vi.advanceTimersByTimeAsync(0);
        expect(getActiveCalls()[0].deadline - Date.now()).toBe(900_000);
        await vi.advanceTimersByTimeAsync(899_999);
        expect(controller.signal.aborted).toBe(false);
        stream.close();
        await pending;
        expect(onDone).toHaveBeenCalledWith('Hello', undefined, undefined);
        expect(getCallHistory()[0].status).toBe('success');
    });

    it('honors Extend beyond the configured deadline', async () => {
        state.settings.storyTimeoutSeconds = 30;
        await start();
        extendCall(getActiveCalls()[0].id);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(controller.signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(60_000);
        await pending;
        expect(getCallHistory()[0].status).toBe('timeout');
    });

    it('defaults older settings to ten minutes and still supports manual cancellation', async () => {
        state.settings.storyTimeoutSeconds = undefined;
        await start();
        expect(getActiveCalls()[0].initialTimeoutMs).toBe(600_000);
        controller.abort();
        await pending;
        expect(getCallHistory()[0].status).toBe('aborted');
    });
});

describe('cache telemetry attribution', () => {
    async function completeStreamWithLabel(trackingLabel?: string) {
        onError = vi.fn();
        onDone = vi.fn();
        controller = new AbortController();
        const encoder = new TextEncoder();
        vi.mocked(llmFetch).mockImplementation(async () => {
            const body = new ReadableStream<Uint8Array>({
                start(c) {
                    c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
                    c.enqueue(encoder.encode('data: [DONE]\n\n'));
                    c.close();
                },
            });
            return { ok: true, body } as Response;
        });
        pending = sendMessage(provider, [], vi.fn(), onDone, onError, undefined, controller,
            undefined, undefined, trackingLabel);
        await vi.advanceTimersByTimeAsync(0);
        await pending;
    }

    it('records cache usage against the caller\'s tracking label', async () => {
        // Swipes, scene-continue and ask-GM all pass a label. They were booked
        // as story calls, so the cache hit rate shown for each was wrong.
        const { recordCacheUsage } = await import('../llm/cacheTelemetry');
        await completeStreamWithLabel('swipe-generation');
        expect(onDone).toHaveBeenCalled();
        // The usage argument is undefined here (no usage chunk in the stream);
        // only the attribution is under test.
        expect(vi.mocked(recordCacheUsage).mock.calls.map(c => c[0])).toEqual(['swipe-generation']);
    });

    it('falls back to the story label when no label is given', async () => {
        const { recordCacheUsage } = await import('../llm/cacheTelemetry');
        await completeStreamWithLabel(undefined);
        expect(vi.mocked(recordCacheUsage).mock.calls.map(c => c[0])).toEqual(['story-generation']);
    });
});
