import { useEffect } from 'react';
import { flushAllPendingSaves, hasPendingSaves } from '../store/slices/campaignSlice';

/**
 * Campaign saves are debounced by a second, so the last second of edits lives
 * only in memory. Nothing flushed them when the window went away; the only
 * durable-on-close path was the Exit button.
 *
 * - When the page is hidden (switching tab, minimising, and the first step of
 *   closing), pending saves are sent at once. The page is still alive then,
 *   so an ordinary request completes.
 * - If saves are still pending as the page is about to unload, the browser's
 *   standard "leave site?" prompt is shown. Requests started during unload
 *   can be cancelled, and the campaign state is several megabytes — far over
 *   the 64 KB a keepalive request may carry — so the prompt is the only way to
 *   guarantee nothing is lost. It appears only inside that one-second window.
 */
export function useFlushSavesOnExit(): void {
    useEffect(() => {
        const onVisibilityChange = () => {
            if (document.visibilityState === 'hidden' && hasPendingSaves()) {
                void flushAllPendingSaves();
            }
        };
        const onBeforeUnload = (event: BeforeUnloadEvent) => {
            if (!hasPendingSaves()) return;
            void flushAllPendingSaves();
            event.preventDefault();
            // Some browsers still require a returnValue to show the prompt.
            event.returnValue = '';
        };
        document.addEventListener('visibilitychange', onVisibilityChange);
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => {
            document.removeEventListener('visibilitychange', onVisibilityChange);
            window.removeEventListener('beforeunload', onBeforeUnload);
        };
    }, []);
}
