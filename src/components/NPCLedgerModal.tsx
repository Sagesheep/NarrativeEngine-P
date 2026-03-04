import { useState, useEffect } from 'react';
import { X, Plus, Trash2, Save, Users, User, LayoutGrid, List } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import type { NPCEntry, NPCVisualProfile } from '../types';

// Helper to format axis labels based on 1-10 value
const AXIS_LABELS: Record<string, string[]> = {
    'Nature': ['Pacifist', 'Gentle', 'Cautious', 'Measured', 'Pragmatic', 'Assertive', 'Aggressive', 'Brutal', 'Savage', 'Feral'],
    'Training': ['Untrained', 'Dabbler', 'Novice', 'Apprentice', 'Competent', 'Seasoned', 'Veteran', 'Expert', 'Master', 'Legendary'],
    'Emotion': ['Hollow', 'Stoic', 'Guarded', 'Composed', 'Steady', 'Sensitive', 'Volatile', 'Intense', 'Explosive', 'Hysterical'],
    'Social': ['Mute', 'Recluse', 'Shy', 'Reserved', 'Neutral', 'Sociable', 'Charismatic', 'Influential', 'Magnetic', 'Manipulative'],
    'Belief': ['Nihilist', 'Apathetic', 'Skeptic', 'Doubter', 'Moderate', 'Faithful', 'Devout', 'Zealous', 'Fanatical', 'Messianic'],
    'Ego': ['Selfless', 'Servile', 'Meek', 'Humble', 'Balanced', 'Confident', 'Proud', 'Arrogant', 'Narcissistic', 'God-Complex']
};

function getAxisLabel(axis: string, value: number) {
    const list = AXIS_LABELS[axis];
    if (!list) return '';
    const index = Math.max(0, Math.min(9, value - 1));
    return list[index];
}

const DEFAULT_VISUAL_PROFILE: NPCVisualProfile = {
    race: '', gender: '', ageRange: '', build: '', symmetry: '',
    hairStyle: '', eyeColor: '', skinTone: '', gait: '', distinctMarks: '', clothing: ''
};

export function NPCLedgerModal() {
    const { npcLedger, npcLedgerOpen, toggleNPCLedger, addNPC, updateNPC, removeNPC } = useAppStore();
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [isEditing, setIsEditing] = useState(false);
    const [viewMode, setViewMode] = useState<'list' | 'gallery'>('list');

    // Form state
    const [form, setForm] = useState<Partial<NPCEntry>>({
        status: 'Alive', nature: 5, training: 1, emotion: 5, social: 5, belief: 5, ego: 5,
        visualProfile: { ...DEFAULT_VISUAL_PROFILE }
    });

    // Close on escape
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && npcLedgerOpen) toggleNPCLedger();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [npcLedgerOpen, toggleNPCLedger]);

    if (!npcLedgerOpen) return null;

    const handleSelect = (npc: NPCEntry) => {
        setSelectedId(npc.id);
        setForm({ ...npc, visualProfile: npc.visualProfile || { ...DEFAULT_VISUAL_PROFILE } });
        setIsEditing(false);
    };

    const handleCreateNew = () => {
        setSelectedId(null);
        setForm({
            name: '', aliases: '', appearance: '', faction: '', storyRelevance: '', disposition: '',
            status: 'Alive', goals: '', nature: 5, training: 1, emotion: 5, social: 5, belief: 5, ego: 5,
            visualProfile: { ...DEFAULT_VISUAL_PROFILE }
        });
        setIsEditing(true);
    };

    const handleSave = () => {
        if (!form.name?.trim()) return;

        if (selectedId) {
            updateNPC(selectedId, form);
        } else {
            addNPC({
                ...form,
                id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
            } as NPCEntry);
        }
        setIsEditing(false);
    };

    const handleDelete = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (confirm('Delete this NPC from the ledger?')) {
            removeNPC(id);
            if (selectedId === id) {
                setSelectedId(null);
                setIsEditing(false);
            }
        }
    };

    const handleVisualProfileChange = (field: keyof NPCVisualProfile, value: string) => {
        setForm(prev => ({
            ...prev,
            visualProfile: {
                ...(prev.visualProfile || DEFAULT_VISUAL_PROFILE),
                [field]: value
            }
        }));
    };

    const renderSlider = (label: keyof NPCEntry, displayLabel: string) => {
        const value = form[label] as number ?? 5;
        return (
            <div className="mb-4">
                <div className="flex justify-between items-end mb-1">
                    <label className="text-text-dim text-xs uppercase tracking-wider">{displayLabel}</label>
                    <span className="text-xs text-terminal">{value} / 10 <span className="text-text-dim ml-1 text-[10px] hidden sm:inline">({getAxisLabel(displayLabel, value)})</span></span>
                </div>
                <input
                    type="range"
                    min="1"
                    max="10"
                    value={value}
                    onChange={(e) => setForm({ ...form, [label]: parseInt(e.target.value, 10) })}
                    disabled={!isEditing}
                    className="w-full accent-terminal"
                />
            </div>
        );
    };

    const renderList = () => (
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {npcLedger.length === 0 && (
                <p className="text-text-dim text-xs text-center p-4 italic opacity-50">No records found.</p>
            )}
            {npcLedger.map(npc => (
                <div
                    key={npc.id}
                    onClick={() => handleSelect(npc)}
                    className={`flex items-center justify-between p-3 cursor-pointer border-l-2 transition-all group ${selectedId === npc.id ? 'border-terminal bg-terminal/5' : 'border-transparent hover:bg-surface'
                        }`}
                >
                    <div className="flex items-center gap-2 truncate">
                        {npc.portrait ? (
                            <img src={npc.portrait} alt={npc.name} className={`w-8 h-8 rounded object-cover ${selectedId === npc.id ? 'ring-1 ring-terminal' : 'opacity-80'}`} />
                        ) : (
                            <User size={14} className={selectedId === npc.id ? 'text-terminal' : 'text-text-dim'} />
                        )}
                        <div className="truncate">
                            <p className={`text-sm font-bold truncate ${selectedId === npc.id ? 'text-terminal glow-green-sm' : 'text-text-primary'}`}>
                                {npc.name}
                            </p>
                            <div className="flex items-center gap-1 text-[10px] mt-0.5 text-text-dim truncate">
                                {npc.faction && <span className="bg-terminal/10 text-terminal px-1 rounded uppercase">{npc.faction}</span>}
                                {npc.aliases && <span>{npc.aliases}</span>}
                            </div>
                        </div>
                    </div>
                    <button
                        onClick={(e) => handleDelete(npc.id, e)}
                        className="p-1.5 text-text-dim hover:text-danger hover:bg-danger/10 rounded transition-colors opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                    >
                        <Trash2 size={12} />
                    </button>
                </div>
            ))}
        </div>
    );

    const renderGallery = () => (
        <div className="flex-1 overflow-y-auto p-4 grid grid-cols-2 md:grid-cols-3 gap-3">
            {npcLedger.length === 0 && (
                <p className="text-text-dim text-xs text-center p-4 italic opacity-50 col-span-full">No records found.</p>
            )}
            {npcLedger.map(npc => (
                <div
                    key={npc.id}
                    onClick={() => handleSelect(npc)}
                    className={`relative aspect-[3/4] rounded overflow-hidden cursor-pointer border group transition-all ${selectedId === npc.id ? 'border-terminal ring-1 ring-terminal shadow-[0_0_15px_rgba(0,255,0,0.15)]' : 'border-border hover:border-terminal/50'}`}
                >
                    {npc.portrait ? (
                        <img src={npc.portrait} alt={npc.name} className="w-full h-full object-cover transition-transform group-hover:scale-105" />
                    ) : (
                        <div className="w-full h-full bg-void-lighter flex flex-col items-center justify-center gap-2">
                            <User size={32} className="text-text-dim/30" />
                            <span className="text-[10px] text-text-dim/50 uppercase tracking-widest">No Portrait</span>
                        </div>
                    )}

                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-void via-void/80 to-transparent p-3 pt-8">
                        <p className={`text-xs font-bold truncate ${selectedId === npc.id ? 'text-terminal glow-green-sm' : 'text-text-primary'}`}>
                            {npc.name}
                        </p>
                        {npc.faction && <p className="text-[9px] text-text-dim truncate uppercase mt-0.5">{npc.faction}</p>}
                    </div>

                    <button
                        onClick={(e) => handleDelete(npc.id, e)}
                        className="absolute top-2 right-2 p-1.5 bg-void/80 rounded text-text-dim hover:text-danger hover:bg-danger/20 transition-all opacity-0 group-hover:opacity-100 flex items-center justify-center"
                    >
                        <Trash2 size={12} />
                    </button>
                </div>
            ))}
        </div>
    );

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-void/80 backdrop-blur-sm p-4 sm:p-8" onClick={toggleNPCLedger}>
            <div className="bg-surface border border-border flex flex-col sm:flex-row w-full max-w-6xl h-full max-h-[850px] overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>

                {/* Left Sidebar: List/Gallery */}
                <div className="w-full sm:w-1/3 md:w-80 border-b sm:border-b-0 sm:border-r border-border flex flex-col bg-void-lighter max-h-[40vh] sm:max-h-none shrink-0">
                    <div className="p-4 border-b border-border flex justify-between items-center bg-void">
                        <div className="flex items-center gap-2 text-terminal font-bold uppercase tracking-widest text-sm">
                            <Users size={16} />
                            NPC Ledger
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="flex bg-surface border border-border rounded overflow-hidden">
                                <button
                                    onClick={() => setViewMode('list')}
                                    className={`p-1.5 transition-colors ${viewMode === 'list' ? 'bg-terminal text-void' : 'text-text-dim hover:text-text-primary'}`}
                                    title="List View"
                                >
                                    <List size={14} />
                                </button>
                                <button
                                    onClick={() => setViewMode('gallery')}
                                    className={`p-1.5 transition-colors ${viewMode === 'gallery' ? 'bg-terminal text-void' : 'text-text-dim hover:text-text-primary'}`}
                                    title="Gallery View"
                                >
                                    <LayoutGrid size={14} />
                                </button>
                            </div>
                            <button onClick={toggleNPCLedger} className="text-text-dim hover:text-text-primary p-1 sm:hidden">
                                <X size={18} />
                            </button>
                        </div>
                    </div>

                    <div className="p-4 border-b border-border bg-void-lighter shrink-0">
                        <button
                            onClick={handleCreateNew}
                            className={`w-full flex items-center justify-center gap-2 py-2 px-4 border border-dashed rounded text-xs uppercase tracking-wider transition-colors ${!selectedId && isEditing ? 'border-terminal text-terminal bg-terminal/10' : 'border-border text-text-dim hover:text-terminal hover:border-terminal'
                                }`}
                        >
                            <Plus size={14} /> New Record
                        </button>
                    </div>

                    {viewMode === 'list' ? renderList() : renderGallery()}
                </div>

                {/* Right Area: Form/Details */}
                <div className="flex-1 flex flex-col bg-surface overflow-hidden relative">
                    <button onClick={toggleNPCLedger} className="absolute top-4 right-4 text-text-dim hover:text-text-primary hidden sm:block p-1 bg-void rounded border border-border hover:border-terminal transition-colors z-10">
                        <X size={18} />
                    </button>

                    {selectedId || isEditing ? (
                        <div className="flex-1 overflow-y-auto flex flex-col p-6 sm:p-8">
                            <div className="flex justify-between items-start mb-6">
                                <div>
                                    <h2 className="text-xl font-bold text-text-primary tracking-wide uppercase">
                                        {isEditing && !selectedId ? 'New Subject Record' : selectedId && !isEditing ? form.name : `Editing: ${form.name}`}
                                    </h2>
                                    <p className="text-xs text-text-dim mt-1">Classified GM Information file.</p>
                                </div>
                                {!isEditing && (
                                    <button
                                        onClick={() => setIsEditing(true)}
                                        className="bg-void border border-border px-4 py-1.5 text-xs text-text-dim hover:text-terminal hover:border-terminal uppercase tracking-widest transition-colors scale-95"
                                    >
                                        Edit Record
                                    </button>
                                )}
                            </div>

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
                                                className="w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-surface disabled:border-transparent focus:outline-none focus:border-terminal"
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
                                            Psychological Axes
                                        </div>
                                        {renderSlider('nature', 'Nature')}
                                        {renderSlider('training', 'Training')}
                                        {renderSlider('emotion', 'Emotion')}
                                        {renderSlider('social', 'Social')}
                                        {renderSlider('belief', 'Belief')}
                                        {renderSlider('ego', 'Ego')}
                                    </div>
                                </div>

                                {/* Right Form Column (Visual Profile) */}
                                <div className="space-y-4">
                                    <div className="bg-void-lighter p-4 rounded border border-border shadow-inner">
                                        <div className="flex items-center justify-between mb-4 border-b border-border/50 pb-2">
                                            <div className="text-terminal font-bold uppercase tracking-widest text-xs">
                                                Visual Profile (AI Ready)
                                            </div>
                                            <div className="text-[9px] uppercase tracking-wider text-text-dim hidden sm:block">Portrait Generation Data</div>
                                        </div>

                                        <div className="grid grid-cols-2 gap-3">
                                            {[
                                                { k: 'race', l: 'Race / Species' },
                                                { k: 'gender', l: 'Gender' },
                                                { k: 'ageRange', l: 'Age Range' },
                                                { k: 'build', l: 'Build / Body Type' },
                                                { k: 'symmetry', l: 'Attract / Symmetry' },
                                                { k: 'skinTone', l: 'Skin Tone' },
                                                { k: 'hairStyle', l: 'Hair Style & Color' },
                                                { k: 'eyeColor', l: 'Eye Color' },
                                                { k: 'gait', l: 'Gait / Posture' },
                                                { k: 'clothing', l: 'Clothing Style' },
                                                { k: 'distinctMarks', l: 'Distinct Marks' },
                                            ].map(({ k, l }) => (
                                                <div key={k} className={k === 'clothing' || k === 'distinctMarks' ? 'col-span-2' : ''}>
                                                    <label className="block text-text-dim text-[9px] uppercase tracking-wider mb-1">{l}</label>
                                                    <input
                                                        type="text"
                                                        value={form.visualProfile?.[k as keyof NPCVisualProfile] || ''}
                                                        onChange={e => handleVisualProfileChange(k as keyof NPCVisualProfile, e.target.value)}
                                                        disabled={!isEditing}
                                                        className="w-full bg-surface border border-border rounded px-2 py-1.5 text-xs text-text-primary disabled:opacity-70 disabled:bg-surface disabled:border-transparent focus:outline-none focus:border-terminal"
                                                    />
                                                </div>
                                            ))}
                                        </div>

                                        <div className="mt-4 pt-4 border-t border-border/50">
                                            <label className="block text-text-dim text-[9px] uppercase tracking-wider mb-1">Legacy Appearance Notes (Fallback)</label>
                                            <textarea
                                                value={form.appearance || ''}
                                                onChange={e => setForm({ ...form, appearance: e.target.value })}
                                                disabled={!isEditing}
                                                rows={2}
                                                className="w-full bg-surface border border-border rounded px-2 py-1.5 text-xs text-text-primary disabled:opacity-70 disabled:bg-surface disabled:border-transparent resize-none focus:outline-none focus:border-terminal"
                                            />
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Actions Bar */}
                            {isEditing && (
                                <div className="mt-8 pt-4 border-t border-border flex justify-between gap-3 shrink-0">
                                    {selectedId ? (
                                        <button
                                            onClick={(e) => handleDelete(selectedId, e)}
                                            className="px-4 py-2 text-xs uppercase tracking-widest text-danger hover:bg-danger/10 border border-danger/30 rounded transition-colors"
                                        >
                                            <div className="flex items-center gap-2">
                                                <Trash2 size={14} /> Delete Record
                                            </div>
                                        </button>
                                    ) : (
                                        <div /> /* Spacer */
                                    )}

                                    <div className="flex gap-3">
                                        {selectedId && (
                                            <button
                                                onClick={() => {
                                                    const npc = npcLedger.find(n => n.id === selectedId);
                                                    if (npc) setForm({ ...npc, visualProfile: npc.visualProfile || { ...DEFAULT_VISUAL_PROFILE } });
                                                    setIsEditing(false);
                                                }}
                                                className="px-4 py-2 text-xs uppercase tracking-widest text-text-dim hover:text-text-primary border border-border bg-void transition-colors"
                                            >
                                                Discard Change
                                            </button>
                                        )}
                                        <button
                                            onClick={handleSave}
                                            disabled={!form.name?.trim()}
                                            className="flex items-center gap-2 px-6 py-2 text-xs uppercase tracking-widest text-void bg-terminal font-bold hover:brightness-110 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                                        >
                                            <Save size={14} /> Commit Record
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="flex-1 flex flex-col items-center justify-center text-center p-8 opacity-50 bg-void">
                            <Users size={64} className="mb-6 text-text-dim/30 drop-shadow-lg" />
                            <p className="text-text-dim uppercase tracking-widest text-sm font-bold">No Record Selected</p>
                            <p className="text-text-dim/60 text-xs mt-2 max-w-xs">Select a subject from the ledger to view their classified file, or create a new entry.</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
