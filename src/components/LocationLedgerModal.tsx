import { useState, useEffect, useMemo } from 'react';
import { X, Plus, MapPin, Trash2, Search, Navigation, BookOpen } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import type { LocationEntry, LocationConnection } from '../types';
import { LocationSuggestionsPanel } from './location-ledger/LocationSuggestionsPanel';
import { LocationEditForm } from './location-ledger/LocationEditForm';
import { filterLocations } from '../utils/ledgerFilters';
import { parseLocationsFromLore } from '../services/lore/loreLocationParser';
import { resolvePlace } from '../services/locationParser';

function newLocationId(): string {
    return `loc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

const EMPTY_ENTRY: LocationEntry = {
    id: '',
    name: '',
    aliases: '',
    broadLocation: '',
    features: [],
    connections: [],
    description: '',
    status: '',
    firstSeenScene: '',
    lastSeenScene: '',
    source: 'manual',
};

export function LocationLedgerModal() {
    const {
        locationLedger,
        locationLedgerOpen,
        toggleLocationLedger,
        addLocation,
        updateLocation,
        removeLocation,
        locationSuggestions,
        setLocationLedger,
        context,
        updateContext,
    } = useAppStore();

    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [isEditing, setIsEditing] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [form, setForm] = useState<Partial<LocationEntry>>({ ...EMPTY_ENTRY });
    // Draft fields kept as comma-separated strings for the chip/field UX
    const [featuresDraft, setFeaturesDraft] = useState('');
    const [newConnectionTo, setNewConnectionTo] = useState('');
    const [newConnectionBand, setNewConnectionBand] = useState<'adjacent' | 'short' | 'long'>('short');
    const [newConnectionNote, setNewConnectionNote] = useState('');

    const displayed = useMemo(() => filterLocations(locationLedger, searchQuery), [locationLedger, searchQuery]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && locationLedgerOpen) toggleLocationLedger();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [locationLedgerOpen, toggleLocationLedger]);

    if (!locationLedgerOpen) return null;

    const handleSelect = (loc: LocationEntry) => {
        setSelectedId(loc.id);
        setForm({ ...loc });
        setFeaturesDraft(loc.features.join(', '));
        setNewConnectionTo('');
        setNewConnectionBand('short');
        setNewConnectionNote('');
        setIsEditing(false);
    };

    const handleStartEditing = () => {
        if (!selectedId) return;
        const latest = locationLedger.find(l => l.id === selectedId);
        if (!latest) return;
        setForm({ ...latest });
        setFeaturesDraft(latest.features.join(', '));
        setIsEditing(true);
    };
    const handleCreateNew = () => {
        setSelectedId(null);
        setForm({ ...EMPTY_ENTRY });
        setFeaturesDraft('');
        setNewConnectionTo('');
        setNewConnectionBand('short');
        setNewConnectionNote('');
        setIsEditing(true);
    };

    const handleSave = () => {
        if (!form.name?.trim()) return;
        const features = featuresDraft
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
            .slice(0, 20);
        const payload: LocationEntry = {
            id: selectedId ?? form.id ?? newLocationId(),
            name: form.name!.trim(),
            aliases: (form.aliases ?? '').trim(),
            broadLocation: (form.broadLocation ?? '').trim(),
            features,
            connections: form.connections ?? [],
            description: (form.description ?? '').trim(),
            status: (form.status ?? '').trim() || undefined,
            firstSeenScene: form.firstSeenScene || String(Date.now()),
            lastSeenScene: form.lastSeenScene || String(Date.now()),
            source: form.source ?? 'manual',
        };
        if (selectedId) {
            updateLocation(selectedId, payload);
        } else {
            addLocation(payload);
        }
        setIsEditing(false);
    };

    const handleDelete = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (confirm('Delete this location from the ledger?')) {
            removeLocation(id);
            if (selectedId === id) { setSelectedId(null); setIsEditing(false); }
        }
    };

    // Re-run the import-time seed against the lore already loaded for this
    // campaign. Additive only: places whose name or alias already resolves in
    // the ledger are skipped, so a player's edits and the estimator's
    // enrichment are never overwritten. One batched write keeps the seeded
    // entries' internal connection ids intact.
    const handleSeedFromLore = () => {
        const chunks = useAppStore.getState().loreChunks || [];
        const parsed = parseLocationsFromLore(chunks);
        if (parsed.length === 0) { alert('No ## LOCATIONS block found in the lore file.'); return; }

        const additions = parsed.filter(loc => !resolvePlace(loc.name, locationLedger));
        if (additions.length === 0) { alert('Every lore location is already in the ledger.'); return; }

        setLocationLedger([...locationLedger, ...additions]);
        alert(`Seeded ${additions.length} place(s) from lore.`);
    };

    const handleSetAsCurrent = (loc: LocationEntry) => {
        updateContext({ currentPlaceId: loc.id, currentFeature: null });
    };

    const handleAddConnection = () => {
        if (!selectedId || !newConnectionTo) return;
        const other = locationLedger.find(l => l.id === newConnectionTo);
        if (!other || other.id === selectedId) return;
        const current = form.connections ?? [];
        if (current.some(c => c.toId === other.id)) return;
        const newConn: LocationConnection = {
            toId: other.id,
            band: newConnectionBand,
            note: newConnectionNote.trim() || undefined,
        };
        const updated = [...current, newConn];
        setForm(prev => ({ ...prev, connections: updated }));
        // Bidirectional default: back-link the other entry too if room and not present
        if (other.connections.length < 8 && !other.connections.some(c => c.toId === selectedId)) {
            updateLocation(other.id, {
                connections: [...other.connections, { toId: selectedId, band: newConnectionBand, note: newConnectionNote.trim() || undefined }],
            });
        }
        setNewConnectionTo('');
        setNewConnectionNote('');
    };

    const handleRemoveConnection = (toId: string) => {
        if (!selectedId) return;
        const updated = (form.connections ?? []).filter(c => c.toId !== toId);
        setForm(prev => ({ ...prev, connections: updated }));
    };

    const handleCancelEdit = () => {
        if (selectedId) {
            const existing = locationLedger.find(l => l.id === selectedId);
            if (existing) handleSelect(existing);
        } else {
            setSelectedId(null);
        }
        setIsEditing(false);
    };

    const currentPlace = context.currentPlaceId
        ? locationLedger.find(l => l.id === context.currentPlaceId)
        : undefined;
    // The ledger can be enriched while this modal is open. In read-only mode,
    // render the live entry instead of the snapshot captured by handleSelect.
    // Editing continues to use the draft so background updates cannot clobber input.
    const renderedForm = !isEditing && selectedId
        ? locationLedger.find(l => l.id === selectedId) ?? form
        : form;

    return (
        <div
            className="fixed inset-0 z-50 flex flex-col bg-void/95 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            aria-label="Location Ledger"
            onClick={toggleLocationLedger}
        >
            <div
                className="bg-surface border border-border flex flex-col sm:flex-row w-full h-full overflow-hidden shadow-2xl"
                onClick={e => e.stopPropagation()}
            >
                {/* Left Sidebar */}
                <div className="w-full sm:w-1/3 md:w-96 lg:w-[420px] border-b sm:border-b-0 sm:border-r border-border flex flex-col bg-void-lighter max-h-[40vh] sm:max-h-none shrink-0">
                    <div className="p-4 border-b border-border flex justify-between items-center bg-void">
                        <div className="flex items-center gap-2 text-terminal font-bold uppercase tracking-widest text-sm">
                            <MapPin size={16} /> Location Ledger
                        </div>
                        <button onClick={toggleLocationLedger} className="text-text-dim hover:text-text-primary p-1 sm:hidden shrink-0">
                            <X size={18} />
                        </button>
                    </div>

                    {/* Search Bar */}
                    <div className="px-3 py-2 border-b border-border bg-void-lighter shrink-0">
                        <div className="relative">
                            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-dim" />
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                                placeholder="Search name, alias, region..."
                                className="w-full pl-8 pr-3 py-1.5 bg-surface border border-border rounded text-xs text-text-primary placeholder:text-text-dim/50 focus:outline-none focus:border-terminal transition-colors"
                            />
                            {searchQuery && (
                                <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-text-dim hover:text-text-primary transition-colors">
                                    <X size={12} />
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Action Bar */}
                    <div className="p-3 border-b border-border bg-void-lighter shrink-0 space-y-2">
                        <button
                            onClick={handleCreateNew}
                            className={`w-full flex items-center justify-center gap-2 py-2 px-4 border border-dashed rounded text-xs uppercase tracking-wider transition-colors ${!selectedId && isEditing ? 'border-terminal text-terminal bg-terminal/10' : 'border-border text-text-dim hover:text-terminal hover:border-terminal'}`}
                        >
                            <Plus size={14} /> New Place
                        </button>
                        <button
                            onClick={handleSeedFromLore}
                            title="Add every place in the world lore's LOCATIONS section that isn't already here"
                            className="w-full flex items-center justify-center gap-2 py-2 px-4 border border-dashed border-border rounded text-xs uppercase tracking-wider text-text-dim hover:text-terminal hover:border-terminal transition-colors"
                        >
                            <BookOpen size={14} /> Seed From Lore
                        </button>
                        {currentPlace && (
                            <div className="text-[10px] text-text-dim text-center">
                                Current: <span className="text-terminal">{currentPlace.name}</span>
                            </div>
                        )}
                    </div>

                    {!searchQuery.trim() && locationSuggestions && locationSuggestions.length > 0 && (
                        <div className="px-3 pt-2 shrink-0">
                            <LocationSuggestionsPanel suggestions={locationSuggestions} />
                        </div>
                    )}

                    {/* List */}
                    <div className="flex-1 overflow-y-auto p-2 space-y-1">
                        {displayed.length === 0 && (
                            // WO-screen-modernization §2c — empty state. The
                            // previous "No places recorded yet." was a single
                            // italic line; the live campaign reads 0 here. Match
                            // the PinnedMemoriesPanel pattern: icon + heading +
                            // one-line instruction. The "New Place" button above
                            // is the actual affordance, so this just confirms to
                            // the user what an empty ledger means.
                            <div className="flex flex-col items-center justify-center py-10 px-4 text-center space-y-2 opacity-60">
                                <MapPin size={32} strokeWidth={1} className="opacity-50" />
                                <p className="text-text-dim text-xs uppercase tracking-widest font-bold">
                                    {searchQuery.trim() ? `No matches for "${searchQuery.trim()}".` : 'No places recorded yet.'}
                                </p>
                                {!searchQuery.trim() && (
                                    <p className="text-text-dim/60 text-[10px] max-w-[260px] leading-relaxed normal-case tracking-normal">
                                        Use "New Place" above, or mention a location in a message and the engine will suggest it.
                                    </p>
                                )}
                            </div>
                        )}
                        {displayed.length > 0 && displayed.map(loc => {
                            const isActive = selectedId === loc.id && !isEditing;
                            const isCurrent = context.currentPlaceId === loc.id;
                            return (
                                <div
                                    key={loc.id}
                                    onClick={() => handleSelect(loc)}
                                    className={`flex items-center justify-between p-3 cursor-pointer border-l-2 transition-all group ${isActive ? 'border-terminal bg-terminal/5' : 'border-transparent hover:bg-surface'}`}
                                >
                                    <div className="flex items-center gap-2 truncate flex-1 min-w-0">
                                        <MapPin size={14} className={`shrink-0 ${isActive ? 'text-terminal' : 'text-text-dim'}`} />
                                        <div className="truncate min-w-0">
                                            <p className={`text-sm font-bold truncate ${isActive ? 'text-terminal glow-green-sm' : 'text-text-primary'}`}>
                                                {loc.name}
                                                {isCurrent && <span className="text-[9px] text-terminal ml-1">●</span>}
                                            </p>
                                            <div className="flex items-center gap-1 text-[10px] mt-0.5 text-text-dim truncate">
                                                {loc.broadLocation && <span className="bg-terminal/10 text-terminal px-1 rounded uppercase">{loc.broadLocation}</span>}
                                                {loc.features.length > 0 && <span className="truncate">{loc.features.length} features</span>}
                                            </div>
                                        </div>
                                    </div>
                                    <button
                                        onClick={(e) => { e.stopPropagation(); handleSetAsCurrent(loc); }}
                                        title="Set as current place"
                                        className="p-1.5 text-text-dim hover:text-terminal hover:bg-terminal/10 rounded transition-colors opacity-100 sm:opacity-0 sm:group-hover:opacity-100 shrink-0"
                                    >
                                        <Navigation size={12} />
                                    </button>
                                    <button
                                        onClick={(e) => handleDelete(loc.id, e)}
                                        className="p-1.5 text-text-dim hover:text-danger hover:bg-danger/10 rounded transition-colors opacity-100 sm:opacity-0 sm:group-hover:opacity-100 shrink-0"
                                    >
                                        <Trash2 size={12} />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Right Detail Pane */}
                <div className="flex-1 flex flex-col bg-surface overflow-hidden relative">
                    <button
                        onClick={toggleLocationLedger}
                        className="absolute top-4 right-4 text-text-dim hover:text-text-primary hidden sm:block p-1 bg-void rounded border border-border hover:border-terminal transition-colors z-10"
                    >
                        <X size={18} />
                    </button>

                    {!selectedId && !isEditing && (
                        <div className="flex-1 flex items-center justify-center p-8 text-text-dim text-sm">
                            <div className="text-center space-y-2">
                                <MapPin size={32} className="mx-auto opacity-30" />
                                <p>Select a place or create a new one.</p>
                            </div>
                        </div>
                    )}

                    {(selectedId || isEditing) && (
                        <LocationEditForm
                            form={form}
                            setForm={setForm}
                            renderedForm={renderedForm}
                            isEditing={isEditing}
                            selectedId={selectedId}
                            featuresDraft={featuresDraft}
                            setFeaturesDraft={setFeaturesDraft}
                            newConnectionTo={newConnectionTo}
                            setNewConnectionTo={setNewConnectionTo}
                            newConnectionBand={newConnectionBand}
                            setNewConnectionBand={setNewConnectionBand}
                            newConnectionNote={newConnectionNote}
                            setNewConnectionNote={setNewConnectionNote}
                            locationLedger={locationLedger}
                            onStartEditing={handleStartEditing}
                            onSetAsCurrent={handleSetAsCurrent}
                            onCancel={handleCancelEdit}
                            onSave={handleSave}
                            onAddConnection={handleAddConnection}
                            onRemoveConnection={handleRemoveConnection}
                            onDelete={handleDelete}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}