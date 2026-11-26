import { X } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { abandonJourney } from '../../services/turn/travelState';
import { buildAbandonMessage } from '../../services/turn/travelPress';

/**
 * Abandon the active journey and post the engine's line. Shared with the
 * World Map panel's Abandon button (through the travel bridge) so both
 * controls perform the same act and say the same sentence.
 *
 * No-op when no journey is active.
 */
export function applyAbandonJourney(): void {
    const state = useAppStore.getState();
    const travel = state.context.travel;
    if (!travel) return;
    const message = buildAbandonMessage(travel, state.locationLedger ?? []);
    state.updateContext(abandonJourney().contextPatch);
    state.addMessage(message);
}

/**
 * WO 6.5 §4 — the Abandon journey chip.
 *
 * Renders only while `context.travel` is active. The party is on the road and
 * the player must always be able to leave it — a movement system you cannot
 * get out of is a trap. Clicking clears `travel` without arriving; the mod's
 * location-watch (WO 6.2 §4) clears the journey record.
 *
 * Placed at the end of the composer action strip, where the DEPARTING chip
 * used to be. Uses the same violet accent so it reads as travel-related.
 */
export function AbandonJourneyChip() {
    const travel = useAppStore(s => s.context.travel);

    if (!travel) return null;

    return (
        <button
            type="button"
            onClick={applyAbandonJourney}
            aria-label="Abandon journey"
            title="Abandon the journey — stop travelling without arriving"
            className="shrink-0 flex items-center gap-1.5 h-[32px] whitespace-nowrap px-3 rounded-sm bg-violet-500/10 text-violet-400 border border-violet-500/40 hover:bg-violet-500/20 transition-colors"
        >
            <X size={13} />
            <span className="text-[10px] sm:text-[11px] uppercase tracking-wider">Abandon</span>
        </button>
    );
}