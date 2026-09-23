import { useEffect, useRef, useState } from 'react';
import { API_BASE as API } from '../lib/apiBase';

export type EmbedJobKind = 'lore' | 'archive' | 'rules';

export type EmbedJob = {
    campaignId: string;
    kind: EmbedJobKind;
    done: number;
    total: number;
    startedAt: number;
};

/** Server-reported state of semantic recall. See `getVectorHealth` in vectorStore.js. */
export type VectorHealth =
    | { status: 'ok' }
    | { status: 'unavailable'; detail: string }
    | { status: 'reindex-needed'; count: number };

export type EmbeddingRuntime = {
    modelReady: boolean;
    jobs: EmbedJob[];
    /** Absent from servers older than this field; treated as healthy. */
    vectorHealth?: VectorHealth;
};

const ACTIVE_MS = 1500;   // poll fast while the model is cold or a bulk embed runs
// Idle backoff schedule: stay responsive right after a turn settles, then ease
// off to a low-frequency heartbeat. Resets to the start whenever activity is
// detected (model goes cold, a job appears, or the campaign changes) so the
// snackbar still pops promptly when a new import starts. Cap at IDLE_MAX_MS.
const IDLE_SCHEDULE_MS = [8000, 8000, 8000, 12000, 16000, 18000, 24000, 30000];

/**
 * Polls the server's embedder runtime so the UI can surface indexing progress.
 * Adaptive cadence: fast while warming/working, progressively slower when idle.
 * Starts optimistic (ready, no jobs) so nothing flashes before the first poll
 * resolves.
 */
export function useEmbeddingStatus(campaignId: string | null): EmbeddingRuntime {
    const [runtime, setRuntime] = useState<EmbeddingRuntime>({ modelReady: true, jobs: [] });
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        let cancelled = false;
        let idleStep = 0;

        const poll = async () => {
            let next = IDLE_SCHEDULE_MS[0];
            try {
                const qs = campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : '';
                const res = await fetch(`${API}/embedding/runtime${qs}`);
                if (res.ok) {
                    const data = (await res.json()) as EmbeddingRuntime;
                    if (!cancelled) setRuntime(data);
                    if (!data.modelReady || data.jobs.length > 0) {
                        // Active: poll fast, reset idle backoff so the next idle
                        // phase starts fresh from the schedule's beginning.
                        idleStep = 0;
                        next = ACTIVE_MS;
                    } else {
                        // Idle: walk the backoff schedule, capped at the last step.
                        next = IDLE_SCHEDULE_MS[Math.min(idleStep, IDLE_SCHEDULE_MS.length - 1)];
                        idleStep++;
                    }
                }
            } catch {
                next = IDLE_SCHEDULE_MS[Math.min(idleStep, IDLE_SCHEDULE_MS.length - 1)];
                idleStep++;
            }
            if (!cancelled) timerRef.current = setTimeout(poll, next);
        };

        poll();
        return () => {
            cancelled = true;
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, [campaignId]);

    return runtime;
}
