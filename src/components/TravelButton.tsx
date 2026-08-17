import { useEffect, useMemo, useRef, useState } from 'react';
import { Compass, X } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import type { DistanceBand } from '../services/location/distance';
import { DISTANCE_BANDS, formatDayRange, formatDayRangeForMode } from '../services/location/distance';
import { TRAVEL_MODES, type TravelMode, gridsPerDayFor } from '../services/location/travelModes';
import {
    composeDeparture,
    travellableFrom,
    type TravelCandidate,
} from '../services/turn/departureComposer';

/**
 * WO 3.1 §2 — TRAVEL is a first-class entry point in the composer action strip,
 * alongside `INJECT EVENT`, `ABSOLUTE: COMMAND`, `ASK GM`, and `INJECT ARC`.
 *
 * Clicking it opens the destination picker directly — the list of travellable
 * places, the mode selector, and `Compose departure`. The Places modal is
 * skipped entirely. The picker reuses `composeDeparture`, the same path the
 * `TRAVEL HERE` button in `LocationLedgerModal` walks, so the two surfaces
 * produce byte-identical departure sentences and `PendingTravelIntent`s.
 *
 * Styling mirrors `OneShotInjectorButton` (terminal accent, size/tracking
 * classes, pipelinePhase streaming guard) — this is the established pattern
 * for "start a structured action" in the strip.
 */
export function TravelButton() {
    const pipelinePhase = useAppStore(s => s.pipelinePhase);
    const [modalOpen, setModalOpen] = useState(false);

    const isStreaming = pipelinePhase !== 'idle';

    return (
        <>
            <button
                onClick={() => setModalOpen(true)}
                disabled={isStreaming}
                title="Open the destination picker and compose a departure"
                className="shrink-0 flex items-center gap-1.5 bg-void border border-terminal/50 text-terminal text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all hover:bg-terminal/5 disabled:cursor-not-allowed whitespace-nowrap"
            >
                <Compass size={13} />
                <span className="hidden xs:inline">Travel</span>
                <span className="inline xs:hidden">Travel</span>
            </button>

            {modalOpen && !isStreaming && (
                <TravelPickerModal onClose={() => setModalOpen(false)} />
            )}
        </>
    );
}

function TravelPickerModal({ onClose }: { onClose: () => void }) {
    const locationLedger = useAppStore(s => s.locationLedger);
    const context = useAppStore(s => s.context);
    const updateLocation = useAppStore(s => s.updateLocation);
    const updateContext = useAppStore(s => s.updateContext);
    const injectToComposer = useAppStore(s => s.injectToComposer);
    const setPendingTravelIntent = useAppStore(s => s.setPendingTravelIntent);

    const fromId = context.currentPlaceId ?? null;
    const candidates = useMemo<TravelCandidate[]>(
        () => travellableFrom(fromId, locationLedger),
        [fromId, locationLedger],
    );

    const [selectedToId, setSelectedToId] = useState<string | null>(
        candidates[0]?.location.id ?? null,
    );
    // If the player opened the picker before a current place was set, we still
    // need a band default for the (theoretical) case where they pick one. The
    // empty-state branch below short-circuits before this is read.
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

    const handleCompose = () => {
        if (!fromId || !selectedToId) return;
        composeDeparture({
            fromId,
            toId: selectedToId,
            mode: travelMode,
            band: effectiveBand,
            ledger: locationLedger,
            deps: {
                updateLocation,
                updateContext,
                injectToComposer,
                setPendingTravelIntent,
            },
        });
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
                        // WO 3.1 §3 — an empty list reads as a broken feature.
                        // Say in words why there is nothing to pick.
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

                            {/* WO 3.1 §3 — live day estimate for the selected
                                 (band, mode). Updates as the mode changes so a
                                 cart and a walker visibly differ before commit. */}
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
                        onClick={handleCompose}
                        disabled={!fromId || !selectedToId}
                        className="px-3 py-1.5 text-xs font-semibold bg-terminal/20 text-terminal rounded hover:bg-terminal/30 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        Compose departure
                    </button>
                </div>
            </div>
        </div>
    );
}