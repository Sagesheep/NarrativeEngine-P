import { useEffect, useRef, useState } from 'react';
import { getTtsStatus, type TtsStatus } from './ttsClient';

/**
 * Tracks Kokoro model readiness. Polls /api/tts/status while the model is still
 * initializing; stops once modelReady && !initializing to avoid pointless
 * background traffic. Restarts polling if init is triggered again later.
 *
 * The speaker button in MessageBubble uses this to decide whether to render.
 */
export function useTtsStatus(pollMs = 3000) {
    const [status, setStatus] = useState<TtsStatus | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        let cancelled = false;

        const schedule = (delay: number) => {
            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(tick, delay);
        };

        const tick = async () => {
            try {
                const s = await getTtsStatus();
                if (cancelled) return;
                setStatus(s);
                // Stop polling once the model is ready and no longer initializing.
                // A later /api/tts/init will flip initializing back on; the component
                // re-mounts / re-runs this effect on key interactions, restarting polls.
                if (s.modelReady && !s.initializing) return;
                schedule(pollMs);
            } catch {
                if (cancelled) return;
                schedule(pollMs); // transient failure → retry, don't spam tight
            }
        };

        tick();
        return () => {
            cancelled = true;
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, [pollMs]);

    return status;
}