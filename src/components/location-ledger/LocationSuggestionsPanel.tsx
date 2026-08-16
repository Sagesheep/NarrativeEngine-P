import { useState } from 'react';
import { MapPin, X, ChevronDown, ChevronRight } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import type { LocationSuggestion, LocationEntry } from '../../types';
import { queueLocationEnrichment } from '../../services/locationEnrich';

type Props = {
    suggestions: LocationSuggestion[];
};

function newLocationId(): string {
    return `loc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function resolveByNameOrAlias(name: string, ledger: LocationEntry[]): LocationEntry | undefined {
    const target = name.trim().toLowerCase();
    if (!target) return undefined;
    let hit = ledger.find(l => l.name.toLowerCase() === target);
    if (hit) return hit;
    hit = ledger.find(l =>
        l.aliases.split(',').map(a => a.trim().toLowerCase()).filter(Boolean).includes(target)
    );
    return hit;
}

/**
 * Auto-detected places the estimator noticed but did NOT add. One-tap Accept
 * creates a `source: 'llm'` LocationEntry (pre-filling a connection to
 * `connectedTo` when it resolves to an existing entry) or one-tap Dismiss.
 * Mirrors NPCSuggestionsPanel's UX.
 */
export function LocationSuggestionsPanel({ suggestions }: Props) {
    const dismissLocationSuggestion = useAppStore(s => s.dismissLocationSuggestion);
    const clearLocationSuggestions = useAppStore(s => s.clearLocationSuggestions);
    const addLocation = useAppStore(s => s.addLocation);
    const updateLocation = useAppStore(s => s.updateLocation);
    const locationLedger = useAppStore(s => s.locationLedger);

    const [expanded, setExpanded] = useState(true);

    if (suggestions.length === 0) return null;

    const acceptOne = (sug: LocationSuggestion) => {
        const sceneId = newLocationId().slice(4, 17); // strip the `loc_` prefix for sceneId
        const newEntry: LocationEntry = {
            id: newLocationId(),
            name: sug.name,
            aliases: '',
            broadLocation: '',
            features: [],
            connections: [],
            description: '',
            firstSeenScene: sceneId,
            lastSeenScene: sceneId,
            source: 'llm',
        };
        // Pre-fill a connection to `connectedTo` when it resolves to an existing entry
        if (sug.connectedTo) {
            const other = resolveByNameOrAlias(sug.connectedTo, locationLedger);
            if (other && other.id !== newEntry.id) {
                newEntry.connections.push({ toId: other.id, band: 'local' });
                // Bidirectional default: back-link the other entry too
                if (!other.connections.some(c => c.toId === newEntry.id)) {
                    updateLocation(other.id, {
                        connections: [...other.connections, { toId: newEntry.id, band: 'local' }],
                    });
                }
            }
        }
        addLocation(newEntry);
        dismissLocationSuggestion(sug.name);
        // PRO/MAX: background AI fill (description/region/features/connections).
        queueLocationEnrichment(newEntry.id);
    };

    return (
        <div className="border border-ice/30 rounded bg-ice/5 overflow-hidden">
            <button
                onClick={() => setExpanded(v => !v)}
                className="w-full flex items-center gap-2 px-2.5 py-2 text-[10px] uppercase tracking-wider text-ice"
            >
                {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                Place Suggestions ({suggestions.length})
            </button>

            {expanded && (
                <div className="px-2 pb-2 space-y-1.5">
                    <div className="max-h-44 overflow-y-auto space-y-1">
                        {suggestions.map(s => (
                            <div
                                key={s.name}
                                className="flex items-center gap-1.5 px-1.5 py-1 rounded"
                            >
                                <MapPin size={11} className="text-ice shrink-0" />
                                <span className="flex-1 text-xs text-text-primary truncate">
                                    {s.name}
                                    {s.connectedTo && (
                                        <span className="text-text-dim text-[10px]"> · near {s.connectedTo}</span>
                                    )}
                                </span>
                                <button
                                    onClick={() => acceptOne(s)}
                                    title="Add to ledger"
                                    className="p-1 text-text-dim hover:text-terminal"
                                >
                                    <MapPin size={13} />
                                </button>
                                <button
                                    onClick={() => dismissLocationSuggestion(s.name)}
                                    title="Dismiss"
                                    className="p-1 text-text-dim hover:text-red-400"
                                >
                                    <X size={13} />
                                </button>
                            </div>
                        ))}
                    </div>

                    <div className="flex gap-1.5 h-8">
                        <button
                            onClick={() => { clearLocationSuggestions(); }}
                            className="flex-1 border border-red-500/30 rounded text-[10px] uppercase tracking-wider text-red-500"
                        >
                            Delete All
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}