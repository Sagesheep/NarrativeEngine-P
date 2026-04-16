import { Trash2, Save, Loader2, Sparkles, Users } from 'lucide-react';
import { NPCPortraitSection } from './NPCPortraitSection';
import type { NPCEntry, NPCVisualProfile } from '../../types';
import { DEFAULT_VISUAL_PROFILE } from '../../types';

type Props = {
    form: Partial<NPCEntry>;
    setForm: React.Dispatch<React.SetStateAction<Partial<NPCEntry>>>;
    selectedId: string | null;
    isEditing: boolean;
    isAIUpdating: boolean;
    isGeneratingImage: boolean;
    onEdit: () => void;
    onSave: () => void;
    onCancel: () => void;
    onDelete: (id: string, e: React.MouseEvent) => void;
    onAIUpdate: () => void;
    onGeneratePortrait: () => void;
};

export function NPCEditForm({
    form, setForm, selectedId, isEditing, isAIUpdating, isGeneratingImage,
    onEdit, onSave, onCancel, onDelete, onAIUpdate, onGeneratePortrait,
}: Props) {
    const handleVisualProfileChange = (field: keyof NPCVisualProfile, value: string) => {
        setForm(prev => ({
            ...prev,
            visualProfile: { ...(prev.visualProfile || DEFAULT_VISUAL_PROFILE), [field]: value }
        }));
    };

    if (!selectedId && !isEditing) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-8 opacity-50 bg-void">
                <Users size={64} className="mb-6 text-text-dim/30 drop-shadow-lg" />
                <p className="text-text-dim uppercase tracking-widest text-sm font-bold">No Record Selected</p>
                <p className="text-text-dim/60 text-xs mt-2 max-w-xs">Select a subject from the ledger to view their classified file, or create a new entry.</p>
            </div>
        );
    }

    return (
        <div className="flex-1 overflow-y-auto flex flex-col p-6 sm:p-8">
            {/* Title row */}
            <div className="flex justify-between items-start mb-5">
                <div>
                    <h2 className="text-xl font-bold text-text-primary tracking-wide uppercase">
                        {isEditing && !selectedId ? 'New Subject Record' : selectedId && !isEditing ? form.name : `Editing: ${form.name}`}
                    </h2>
                    <p className="text-xs text-text-dim mt-1">Classified GM Information file.</p>
                </div>
                {!isEditing && (
                    <div className="flex items-center gap-2">
                        <button
                            onClick={onAIUpdate}
                            disabled={isAIUpdating || !selectedId}
                            title="Ask AI to update this NPC based on recent chat history"
                            className="flex items-center gap-1.5 bg-void border border-terminal/30 px-3 py-1.5 text-xs text-terminal hover:border-terminal uppercase tracking-widest transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            {isAIUpdating ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                            AI Update
                        </button>
                        <button
                            onClick={onEdit}
                            className="bg-void border border-border px-4 py-1.5 text-xs text-text-dim hover:text-terminal hover:border-terminal uppercase tracking-widest transition-colors"
                        >
                            Edit Record
                        </button>
                    </div>
                )}
            </div>

            {/* Form grid */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-8 flex-1">
                {/* Left Form Column */}
                <div className="space-y-4">
                    <div className="flex gap-4">
                        <div className="flex-1">
                            <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">Primary Designation</label>
                            <input
                                type="text"
                                value={form.name || ''}
                                onChange={e => setForm({ ...form, name: e.target.value })}
                                disabled={!isEditing}
                                placeholder="Subject Name"
                                className="w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-surface disabled:border-transparent focus:outline-none focus:border-terminal"
                            />
                        </div>
                        <div className="w-1/3">
                            <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">Status</label>
                            <select
                                value={form.status || 'Alive'}
                                onChange={e => setForm({ ...form, status: e.target.value })}
                                disabled={!isEditing}
                                className="w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary disabled:opacity-70 disabled:bg-surface disabled:border-transparent outline-none focus:border-terminal transition-colors"
                            >
                                <option value="Alive">Alive</option>
                                <option value="Deceased">Deceased</option>
                                <option value="Missing">Missing</option>
                                <option value="Unknown">Unknown</option>
                                <option value="In Custody">In Custody</option>
                            </select>
                        </div>
                    </div>

                    <div className="flex gap-4">
                        <div className="flex-1">
                            <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">Faction / Organization</label>
                            <input
                                type="text"
                                value={form.faction || ''}
                                onChange={e => setForm({ ...form, faction: e.target.value })}
                                disabled={!isEditing}
                                placeholder="e.g. Ironspire Knights"
                                className="w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-surface disabled:border-transparent focus:outline-none focus:border-terminal"
                            />
                        </div>
                        <div className="flex-1">
                            <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">Known Aliases</label>
                            <input
                                type="text"
                                value={form.aliases || ''}
                                onChange={e => setForm({ ...form, aliases: e.target.value })}
                                disabled={!isEditing}
                                placeholder="Comma separated"
                                className="w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-surface disabled:border-transparent focus:outline-none focus:border-terminal"
                            />
                        </div>
                    </div>

                    <div>
                        <label className="block text-terminal text-[10px] uppercase tracking-wider font-bold mb-1">Story Relevance</label>
                        <textarea
                            value={form.storyRelevance || ''}
                            onChange={e => setForm({ ...form, storyRelevance: e.target.value })}
                            disabled={!isEditing}
                            placeholder="Why does this NPC matter to the narrative?"
                            rows={2}
                            className="w-full bg-terminal/5 border border-terminal/30 rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-surface disabled:border-transparent resize-none focus:outline-none focus:border-terminal"
                        />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">Default Disposition</label>
                            <input
                                type="text"
                                value={form.disposition || ''}
                                onChange={e => setForm({ ...form, disposition: e.target.value })}
                                disabled={!isEditing}
                                placeholder="Helpful, Suspicious..."
                                className="w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-surface disabled:border-transparent focus:outline-none focus:border-terminal"
                            />
                        </div>
                        <div>
                            <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">Affinity (0-100)</label>
                            <input
                                type="number"
                                min={0}
                                max={100}
                                value={form.affinity ?? 50}
                                onChange={e => setForm({ ...form, affinity: parseInt(e.target.value, 10) || 50 })}
                                disabled={!isEditing}
                                className="w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary disabled:opacity-70 disabled:bg-surface disabled:border-transparent focus:outline-none focus:border-terminal"
                            />
                        </div>
                    </div>

                    <div>
                        <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">Core Motive / Goals</label>
                        <textarea
                            value={form.goals || ''}
                            onChange={e => setForm({ ...form, goals: e.target.value })}
                            disabled={!isEditing}
                            placeholder="What does this character ultimately want?"
                            rows={2}
                            className="w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-surface disabled:border-transparent resize-none focus:outline-none focus:border-terminal"
                        />
                    </div>

                    <div className="bg-void p-4 rounded border border-border">
                        <div className="flex items-center gap-2 text-text-primary font-bold uppercase tracking-widest text-xs mb-4">
                            Character Profile
                        </div>
                        <div className="space-y-3">
                            <div>
                                <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">Personality</label>
                                <textarea
                                    value={form.personality ?? ''}
                                    onChange={e => setForm({ ...form, personality: e.target.value })}
                                    disabled={!isEditing}
                                    placeholder="Core personality traits in plain language..."
                                    rows={2}
                                    className="w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-surface disabled:border-transparent resize-none focus:outline-none focus:border-terminal"
                                />
                            </div>
                            <div>
                                <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">Voice &amp; Speech Pattern</label>
                                <textarea
                                    value={form.voice ?? ''}
                                    onChange={e => setForm({ ...form, voice: e.target.value })}
                                    disabled={!isEditing}
                                    placeholder="How this NPC speaks: tone, cadence, verbal quirks..."
                                    rows={2}
                                    className="w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-surface disabled:border-transparent resize-none focus:outline-none focus:border-terminal"
                                />
                            </div>
                            <div>
                                <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">Example Dialogue</label>
                                <textarea
                                    value={form.exampleOutput ?? ''}
                                    onChange={e => setForm({ ...form, exampleOutput: e.target.value })}
                                    disabled={!isEditing}
                                    placeholder="A sample line showing how this NPC talks and acts..."
                                    rows={2}
                                    className="w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-surface disabled:border-transparent resize-none focus:outline-none focus:border-terminal"
                                />
                            </div>
                        </div>
                    </div>
                </div>

                {/* Right Form Column (Visual Profile) */}
                <div className="space-y-4">
                    <NPCPortraitSection
                        portrait={form.portrait}
                        name={form.name || ''}
                        visualProfile={form.visualProfile || DEFAULT_VISUAL_PROFILE}
                        isEditing={isEditing}
                        isGeneratingImage={isGeneratingImage}
                        onGeneratePortrait={onGeneratePortrait}
                        onVisualProfileChange={handleVisualProfileChange}
                        appearance={form.appearance || ''}
                        onAppearanceChange={(v) => setForm(prev => ({ ...prev, appearance: v }))}
                    />
                </div>
            </div>

            {/* Actions Bar */}
            {isEditing && (
                <div className="mt-8 pt-4 border-t border-border flex justify-between gap-3 shrink-0">
                    {selectedId ? (
                        <button
                            onClick={(e) => onDelete(selectedId, e)}
                            className="px-4 py-2 text-xs uppercase tracking-widest text-danger hover:bg-danger/10 border border-danger/30 rounded transition-colors"
                        >
                            <div className="flex items-center gap-2">
                                <Trash2 size={14} /> Delete Record
                            </div>
                        </button>
                    ) : (
                        <div />
                    )}

                    <div className="flex gap-3">
                        {selectedId && (
                            <button
                                onClick={onCancel}
                                className="px-4 py-2 text-xs uppercase tracking-widest text-text-dim hover:text-text-primary border border-border bg-void transition-colors"
                            >
                                Discard Change
                            </button>
                        )}
                        <button
                            onClick={onSave}
                            disabled={!form.name?.trim()}
                            className="flex items-center gap-2 px-6 py-2 text-xs uppercase tracking-widest text-void bg-terminal font-bold hover:brightness-110 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                        >
                            <Save size={14} /> Commit Record
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
