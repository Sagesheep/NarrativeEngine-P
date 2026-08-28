import { useEffect, useMemo, useRef, useState } from 'react';
import { Compass, X } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import type { DistanceBand } from '../services/location/distance';
import { DISTANCE_BANDS, formatDayRange, formatDayRangeForMode } from '../services/location/distance';
import { TRAVEL_MODES, type TravelMode, gridsPerDayFor } from '../services/location/travelModes';
import {
    composeDeparture,
    travellableFrom,
    mergeUpserts,
    type TravelCandidate,
} from '../services/turn/departureComposer';
import {
    buildCheckpointMessage,
    pressTravelAdvance,
    travelButtonLabel,
    travelButtonTitle,
} from '../services/turn/travelPress';

/**
 * WO 6.5 — TRAVEL is a first-class entry point in the composer action strip.
 *
 * When no journey is active, clicking it opens the destination picker. On
 * confirm, the engine departs directly: `composeDeparture` applies the
 * `depart()` transition, the checkpoint system message is posted, and the
 * composer is not touched. No LLM call.
 *
 * When a journey IS active, the button reads `Continue →` (or `Arrive` on
 * the last leg) and clicking it advances one leg — again, no LLM.
 */
/**
 * Advance one leg and post the engine's line. Called by this button and by
 * the World Map panel's Continue button (through the travel bridge), so the
 * two cannot drift.
 *
 * No-op when no journey is active — the caller has nothing to advance.
 */
export function applyTravelAdvance(): void {
    const state = useAppStore.getState();
    const travel = state.context.travel;
    if (!travel) return;
    const pressed = pressTravelAdvance(travel, state.context.worldDay, state.locationLedger ?? []);
    if (!pressed) return;
    state.updateContext(pressed.result.contextPatch);
    state.addMessage(pressed.message);
}

export function TravelButton() {
    const pipelinePhase = useAppStore(s => s.pipelinePhase);
    const [modalOpen, setModalOpen] = useState(false);

    const isStreaming = pipelinePhase !== 'idle';

    return (
        <>
            <TravelPressButton onOpenPicker={() => setModalOpen(true)} disabled={isStreaming} />
            {modalOpen && !isStreaming && (
                <TravelPickerModal onClose={() => setModalOpen(false)} />
            )}
        </>
    );
}

/**
 * The button itself. Renders `Travel` when no journey is active, `Continue →`
 * mid-journey, or `Arrive` on the last leg. Clicking opens the picker when
 * idle, or advances one leg when travelling.
 *
 * The advance is `applyTravelAdvance`, shared with the map panel's Continue
 * button. This component used to inline its own copy of the same six lines,
 * which is how two controls for one act start meaning two different things.
 */
function TravelPressButton({ onOpenPicker, disabled }: { onOpenPicker: () => void; disabled: boolean }) {
    const travel = useAppStore(s => s.context.travel);

    const handleAdvance = () => {
        if (!travel) { onOpenPicker(); return; }
        applyTravelAdvance();
    };

    const label = travelButtonLabel(travel);

    return (
        <button
            onClick={handleAdvance}
            disabled={disabled}
            title={travelButtonTitle(travel)}
            className="shrink-0 flex items-center gap-1.5 bg-void border border-terminal/50 text-terminal text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all hover:bg-terminal/5 disabled:cursor-not-allowed whitespace-nowrap"
        >
            <Compass size={13} />
            <span>{label}</span>
        </button>
    );
}

function TravelPickerModal({ onClose }: { onClose: () => void }) {
    const locationLedger = useAppStore(s => s.locationLedger);
    const context = useAppStore(s => s.context);
    const updateLocation = useAppStore(s => s.updateLocation);
    const updateContext = useAppStore(s => s.updateContext);
    const addMessage = useAppStore(s => s.addMessage);

    const fromId = context.currentPlaceId ?? null;
    const candidates = useMemo<TravelCandidate[]>(
        () => travellableFrom(fromId, locationLedger),
        [fromId, locationLedger],
    );

    const [selectedToId, setSelectedToId] = useState<string | null>(
        candidates[0]?.location.id ?? null,
    );
    const [travelBand, setTravelBand] = useState<DistanceBand>('regional');
    const [travelMode, setTravelMode] = useState<TravelMode>(context.travelMode ?? 'foot');

    const openedAtRef = useRef(0);
    useEffect(() => {
        openedAtRef.current = Date.now();
    }, []);

    const handleBackdropClick = () => {
        if (Date.now() - openedAtRef.current < 350) return;
        onClose();
    };

    const fromPlace = fromId ? locationLedger.find(l => l.id === fromId) : undefined;
    const selectedCandidate = candidates.find(c => c.location.id === selectedToId) ?? null;
    const hasDirectConnection = selectedCandidate?.band != null;
    const effectiveBand: DistanceBand = selectedCandidate?.band ?? travelBand;
    const dayEstimate = formatDayRangeForMode(effectiveBand, gridsPerDayFor(travelMode));
    const baselineDayRange = selectedCandidate?.band ? formatDayRange(selectedCandidate.band) : null;

    const handleDepart = () => {
        if (!fromId || !selectedToId) return;
        const state = useAppStore.getState();
        const currentWorldDay = state.context.worldDay;
        const result = composeDeparture({
            fromId,
            toId: selectedToId,
            mode: travelMode,
            band: effectiveBand,
            ledger: locationLedger,
            deps: { updateLocation, updateContext },
            currentWorldDay,
        });
        if (!result) return;

        state.updateContext(result.contextPatch);
        if (result.ledgerUpsert && result.ledgerUpsert.length > 0) {
            state.setLocationLedger(mergeUpserts(locationLedger, result.ledgerUpsert));
        }

        if (result.travel) {
            const newDay = result.contextPatch.worldDay ?? (currentWorldDay ?? 0) + 1;
            addMessage(buildCheckpointMessage(result.travel, newDay, locationLedger));
        } else {
            // Single-day journey: arrived immediately.
            const newDay = result.contextPatch.worldDay ?? (currentWorldDay ?? 0) + 1;
            const to = locationLedger.find(l => l.id === selectedToId);
            addMessage({
                id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
                role: 'system',
                name: 'travel-arrive',
                content: `Day ${newDay} · arrived at ${to?.name ?? selectedToId}`,
                timestamp: Date.now(),
            });
        }
        onClose();
    };

    const noCurrentPlace = !fromId;
    const noDestinations = candidates.length === 0;

    return (
        <div
            className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60"
            onClick={handleBackdropClick}
        >
            <div
                className="bg-surface border border-border rounded-lg w-full max-w-md mx-4 flex flex-col"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center justify-between p-4 border-b border-border">
                    <h2 className="text-terminal text-sm font-bold tracking-[0.2em] uppercase flex items-center gap-2">
                        <Compass size={14} /> Travel
                    </h2>
                    <button
                        onClick={onClose}
                        className="text-text-dim hover:text-text-primary"
                    >
                        <X size={18} />
                    </button>
                </div>

                <div className="p-4 space-y-3">
                    <div className="text-[11px] text-text-dim">
                        {fromPlace ? (
                            <>Departing from <span className="text-terminal">{fromPlace.name}</span>.</>
                        ) : (
                            <>No current place set. Set one in the Places panel to start travel.</>
                        )}
                    </div>

                    {noCurrentPlace || noDestinations ? (
                        <div className="flex flex-col items-center justify-center py-8 px-4 text-center space-y-2">
                            <Compass size={28} strokeWidth={1} className="opacity-40" />
                            <p className="text-text-dim text-xs uppercase tracking-widest font-bold">
                                {noCurrentPlace
                                    ? 'No departure point.'
                                    : 'No destinations available.'}
                            </p>
                            <p className="text-text-dim/70 text-[10px] max-w-[280px] leading-relaxed normal-case tracking-normal">
                                {noCurrentPlace
                                    ? 'Set a current place in the Places panel — the picker lists every place you can travel to from there.'
                                    : 'Every other place in the ledger is either the current place or a transit node. Add or discover more places to open new routes.'}
                            </p>
                        </div>
                    ) : (
                        <>
                            <label className="block text-[10px] uppercase tracking-wider text-text-dim">
                                Destination
                                <select
                                    aria-label="Travel destination"
                                    value={selectedToId ?? ''}
                                    onChange={e => setSelectedToId(e.target.value || null)}
                                    className="mt-1 w-full bg-void border border-border focus:border-terminal text-[13px] text-text-primary rounded px-2 py-1.5 outline-none"
                                >
                                    {candidates.map(({ location, band }) => (
                                        <option key={location.id} value={location.id}>
                                            {location.name}
                                            {band ? ` — ${band}, ${formatDayRange(band)}` : ' — no road yet'}
                                        </option>
                                    ))}
                                </select>
                            </label>

                            {!hasDirectConnection && selectedCandidate && (
                                <label className="block text-[10px] uppercase tracking-wider text-text-dim">
                                    Distance band
                                    <select
                                        aria-label="Distance band"
                                        value={travelBand}
                                        onChange={e => setTravelBand(e.target.value as DistanceBand)}
                                        className="mt-1 w-full bg-void border border-border focus:border-terminal text-[13px] text-text-primary rounded px-2 py-1.5 outline-none"
                                    >
                                        {DISTANCE_BANDS
                                            .filter(b => b.id !== 'adjacent')
                                            .map(({ id, label }) => (
                                                <option key={id} value={id}>{label}</option>
                                            ))}
                                    </select>
                                </label>
                            )}

                            <label className="block text-[10px] uppercase tracking-wider text-text-dim">
                                Travel mode
                                <select
                                    aria-label="Travel mode"
                                    value={travelMode}
                                    onChange={e => setTravelMode(e.target.value as TravelMode)}
                                    className="mt-1 w-full bg-void border border-border focus:border-terminal text-[13px] text-text-primary rounded px-2 py-1.5 outline-none"
                                >
                                    {TRAVEL_MODES.map(({ id, label, gridsPerDay }) => (
                                        <option key={id} value={id}>{label} ({gridsPerDay} grids/day)</option>
                                    ))}
                                </select>
                            </label>

                            <div className="text-[11px] text-text-dim flex justify-between border-t border-border pt-2">
                                <span>
                                    {selectedCandidate?.band
                                        ? <span>Estimated travel time <span className="text-text-dim/60">(mode-adjusted)</span></span>
                                        : <span>Estimated travel time <span className="text-text-dim/60">(at chosen band)</span></span>}
                                </span>
                                <span className="text-terminal tabular-nums">{dayEstimate}</span>
                            </div>
                            {baselineDayRange && baselineDayRange !== 'no travel' && (
                                <div className="text-[10px] text-text-dim/60 flex justify-between">
                                    <span>Baseline (on foot)</span>
                                    <span className="tabular-nums">{baselineDayRange}</span>
                                </div>
                            )}
                        </>
                    )}
                </div>

                <div className="px-4 py-3 border-t border-border flex justify-end gap-2">
                    <button
                        onClick={onClose}
                        className="px-3 py-1.5 text-xs text-text-dim hover:text-text-primary rounded"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleDepart}
                        disabled={!fromId || !selectedToId}
                        className="px-3 py-1.5 text-xs font-semibold bg-terminal/20 text-terminal rounded hover:bg-terminal/30 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        Depart
                    </button>
                </div>
            </div>
        </div>
    );
}