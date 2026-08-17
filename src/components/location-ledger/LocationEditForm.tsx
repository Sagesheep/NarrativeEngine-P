import { Link2, Trash2, X } from 'lucide-react';
import type { LocationEntry, LocationConnection } from '../../types';
import { connectionBand } from '../../services/locationParser';
import { DISTANCE_BANDS, type DistanceBand } from '../../services/location/distance';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div>
            <label className="block text-[10px] uppercase tracking-wider text-text-dim mb-1">{label}</label>
            {children}
        </div>
    );
}

function inputClass(enabled: boolean): string {
    return `w-full bg-void border border-border rounded px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-dim/50 focus:outline-none focus:border-terminal transition-colors ${enabled ? '' : 'opacity-80 cursor-default'}`;
}

type Props = {
    form: Partial<LocationEntry>;
    setForm: React.Dispatch<React.SetStateAction<Partial<LocationEntry>>>;
    renderedForm: Partial<LocationEntry>;
    isEditing: boolean;
    selectedId: string | null;
    featuresDraft: string;
    setFeaturesDraft: React.Dispatch<React.SetStateAction<string>>;
    newConnectionTo: string;
    setNewConnectionTo: React.Dispatch<React.SetStateAction<string>>;
    newConnectionBand: DistanceBand;
    setNewConnectionBand: React.Dispatch<React.SetStateAction<DistanceBand>>;
    newConnectionNote: string;
    setNewConnectionNote: React.Dispatch<React.SetStateAction<string>>;
    locationLedger: LocationEntry[];
    onStartEditing: () => void;
    onSetAsCurrent: (loc: LocationEntry) => void;
    onCancel: () => void;
    onSave: () => void;
    onAddConnection: () => void;
    onRemoveConnection: (toId: string) => void;
    onDelete: (id: string, e: React.MouseEvent) => void;
};

export function LocationEditForm({
    form, setForm, renderedForm, isEditing, selectedId,
    featuresDraft, setFeaturesDraft,
    newConnectionTo, setNewConnectionTo,
    newConnectionBand, setNewConnectionBand,
    newConnectionNote, setNewConnectionNote,
    locationLedger,
    onStartEditing, onSetAsCurrent, onCancel, onSave,
    onAddConnection, onRemoveConnection, onDelete,
}: Props) {
    return (
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
            <div className="flex items-center justify-between gap-2 pr-8">
                <h2 className="text-terminal text-base font-bold tracking-widest uppercase">
                    {isEditing ? (selectedId ? 'Edit Place' : 'New Place') : 'Place Details'}
                </h2>
                <div className="flex gap-2">
                    {!isEditing && selectedId && (
                        <>
                            <button
                                onClick={onStartEditing}
                                className="px-3 py-1.5 border border-border rounded text-[10px] uppercase tracking-wider text-text-dim hover:text-terminal hover:border-terminal transition-colors"
                            >
                                Edit
                            </button>
                            <button
                                onClick={() => onSetAsCurrent(form as LocationEntry)}
                                disabled={!form.id}
                                className="px-3 py-1.5 border border-terminal/30 rounded text-[10px] uppercase tracking-wider text-terminal hover:bg-terminal/10 transition-colors disabled:opacity-30"
                            >
                                Set as Current
                            </button>
                        </>
                    )}
                    {isEditing && (
                        <>
                            <button
                                onClick={onCancel}
                                className="px-3 py-1.5 border border-border rounded text-[10px] uppercase tracking-wider text-text-dim hover:text-text-primary transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={onSave}
                                className="px-3 py-1.5 border border-terminal bg-terminal/10 rounded text-[10px] uppercase tracking-wider text-terminal hover:bg-terminal/20 transition-colors"
                            >
                                Save
                            </button>
                        </>
                    )}
                </div>
            </div>

            {/* Name */}
            <Field label="Name">
                <input
                    type="text"
                    value={renderedForm.name ?? ''}
                    onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
                    disabled={!isEditing}
                    placeholder="Ninja Academy"
                    className={inputClass(isEditing)}
                />
            </Field>

            {/* Aliases + Broad Location */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field label="Aliases (comma-separated)">
                    <input
                        type="text"
                        value={renderedForm.aliases ?? ''}
                        onChange={e => setForm(prev => ({ ...prev, aliases: e.target.value }))}
                        disabled={!isEditing}
                        placeholder="the academy, NA"
                        className={inputClass(isEditing)}
                    />
                </Field>
                <Field label="Broad Location (region)">
                    <input
                        type="text"
                        value={renderedForm.broadLocation ?? ''}
                        onChange={e => setForm(prev => ({ ...prev, broadLocation: e.target.value }))}
                        disabled={!isEditing}
                        placeholder="Konoha"
                        className={inputClass(isEditing)}
                    />
                </Field>
            </div>

            {/* Kind — WO 4.1 §2. A `kind` selector next to the existing fields.
                Defaults to `place`; a transit row is treated by the solver as a
                waypoint on the edge between the two places it connects, not as a
                free vertex. Explicit data — never inferred from the name. */}
            <Field label="Kind">
                <select
                    value={renderedForm.kind ?? 'place'}
                    onChange={e => setForm(prev => ({ ...prev, kind: e.target.value as LocationEntry['kind'] }))}
                    disabled={!isEditing}
                    className={inputClass(isEditing)}
                >
                    <option value="place">Place (a destination)</option>
                    <option value="transit">Transit (road / route between two places)</option>
                </select>
            </Field>

            {/* Description */}
            <Field label="Description">
                <textarea
                    value={renderedForm.description ?? ''}
                    onChange={e => setForm(prev => ({ ...prev, description: e.target.value }))}
                    disabled={!isEditing}
                    rows={2}
                    placeholder="1-2 sentences of texture."
                    className={`${inputClass(isEditing)} resize-none`}
                />
            </Field>

            {/* Status */}
            <Field label="Status (optional)">
                <input
                    type="text"
                    value={renderedForm.status ?? ''}
                    onChange={e => setForm(prev => ({ ...prev, status: e.target.value }))}
                    disabled={!isEditing}
                    placeholder="burned down in ch. 12"
                    className={inputClass(isEditing)}
                />
            </Field>

            {/* Features */}
            <Field label="Features / Rooms (comma-separated)">
                <input
                    type="text"
                    value={isEditing ? featuresDraft : (renderedForm.features ?? []).join(', ')}
                    onChange={e => setFeaturesDraft(e.target.value)}
                    disabled={!isEditing}
                    placeholder="Class A, training yard, teacher lounge"
                    className={inputClass(isEditing)}
                />
                {renderedForm.features && renderedForm.features.length > 0 && !isEditing && (
                    <div className="flex flex-wrap gap-1 mt-2">
                        {renderedForm.features.map((f, i) => (
                            <span key={i} className="text-[10px] bg-terminal/10 text-terminal px-1.5 py-0.5 rounded">
                                {f}
                            </span>
                        ))}
                    </div>
                )}
            </Field>

            {/* Connections */}
            <Field label="Connections">
                <div className="space-y-2">
                    {(renderedForm.connections ?? []).length > 0 ? (
                        <div className="space-y-1">
                            {(renderedForm.connections ?? []).map((c: LocationConnection) => {
                                const other = locationLedger.find(l => l.id === c.toId);
                                return (
                                    <div key={c.toId} className="flex items-center gap-2 text-xs bg-void border border-border rounded px-2 py-1">
                                        <Link2 size={11} className="text-text-dim shrink-0" />
                                        <span className="flex-1 truncate">
                                            {other?.name ?? c.toId}
                                            <span className="text-text-dim text-[10px] ml-1">({connectionBand(c)})</span>
                                            {c.note && <span className="text-text-dim text-[10px] ml-1">— {c.note}</span>}
                                        </span>
                                        {isEditing && (
                                            <button
                                                onClick={() => onRemoveConnection(c.toId)}
                                                aria-label={`Remove connection to ${other?.name ?? c.toId}`}
                                                className="text-text-dim hover:text-danger shrink-0"
                                            >
                                                <X size={11} />
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    ) : !isEditing ? (
                        <p className="text-[10px] text-text-dim/60 italic">
                            No connections recorded.
                        </p>
                    ) : null}
                    {isEditing && (
                        <div className="flex flex-col sm:flex-row gap-2">
                            <select
                                value={newConnectionTo}
                                onChange={e => setNewConnectionTo(e.target.value)}
                                className="flex-1 bg-void border border-border rounded px-2 py-1.5 text-xs text-text-primary"
                            >
                                <option value="">Select place...</option>
                                {locationLedger
                                    .filter(l => l.id !== selectedId)
                                    .map(l => (
                                        <option key={l.id} value={l.id}>{l.name}</option>
                                    ))}
                            </select>
                            <select
                                value={newConnectionBand}
                                onChange={e => setNewConnectionBand(e.target.value as DistanceBand)}
                                className="bg-void border border-border rounded px-2 py-1.5 text-xs text-text-primary"
                            >
                                {DISTANCE_BANDS.map(({ id, label }) => (
                                    <option key={id} value={id}>{label}</option>
                                ))}
                            </select>

                            <input
                                type="text"
                                value={newConnectionNote}
                                onChange={e => setNewConnectionNote(e.target.value)}
                                placeholder="note (optional)"
                                className="flex-1 bg-void border border-border rounded px-2 py-1.5 text-xs text-text-primary placeholder:text-text-dim/50"
                            />
                            <button
                                onClick={onAddConnection}
                                disabled={!newConnectionTo}
                                className="px-3 py-1.5 border border-terminal/30 rounded text-[10px] uppercase tracking-wider text-terminal disabled:opacity-30"
                            >
                                Add
                            </button>
                        </div>
                    )}
                </div>
            </Field>

            {/* Metadata */}
            <div className="grid grid-cols-2 gap-4 text-[10px] text-text-dim">
                <div>First seen: <span className="text-text-primary">{renderedForm.firstSeenScene || '—'}</span></div>
                <div>Last seen: <span className="text-text-primary">{renderedForm.lastSeenScene || '—'}</span></div>
                <div>Source: <span className="text-text-primary">{renderedForm.source ?? 'manual'}</span></div>
            </div>

            {/* Delete (only when editing an existing entry) */}
            {isEditing && selectedId && (
                <button
                    onClick={(e) => onDelete(selectedId, e)}
                    className="flex items-center gap-1.5 px-3 py-1.5 border border-danger/30 text-danger text-[10px] uppercase tracking-wider rounded hover:bg-danger/10 transition-colors"
                >
                    <Trash2 size={11} /> Delete Place
                </button>
            )}
        </div>
    );
}