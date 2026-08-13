import { useState, useMemo } from 'react';
import { Trash2, Save, Loader2, Sparkles, Users, ScrollText, X, ChevronUp, ChevronDown, Search } from 'lucide-react';
import { NPCPortraitSection } from './NPCPortraitSection';
import type { NPCEntry, NPCVisualProfile, NPCBehavioralTrigger, DivergenceCategory, HexAxis } from '../../types';
import { DEFAULT_VISUAL_PROFILE } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import { getEntriesForNpc, CATEGORY_LABELS, EMPTY_REGISTER } from '../../services/campaign-state/divergenceRegister';
import { TRAIT_NAMES, TRAIT_VOCAB } from '../../services/npc/agency/agencyPools';
import { hexBand, relationBand } from '../../services/npc/agency/agencyBands';
import { RelationshipMemoryEditor } from '../character/RelationshipMemoryEditor';

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
    onUploadPortrait: (file: File) => void;
    onRemovePortrait: () => void;
};

export function NPCEditForm({
    form, setForm, selectedId, isEditing, isAIUpdating, isGeneratingImage,
    onEdit, onSave, onCancel, onDelete, onAIUpdate, onGeneratePortrait, onUploadPortrait, onRemovePortrait,
}: Props) {
    const handleVisualProfileChange = (field: keyof NPCVisualProfile, value: string) => {
        setForm(prev => ({
            ...prev,
            visualProfile: { ...(prev.visualProfile || DEFAULT_VISUAL_PROFILE), [field]: value }
        }));
    };

    const [traitSearch, setTraitSearch] = useState('');
    const [relationTargetId, setRelationTargetId] = useState('');
    const npcLedger = useAppStore(s => s.npcLedger);
    const playerCharacter = useAppStore(s => s.playerCharacter);
    const relationshipMemoriesNpcToMc = useAppStore(s => s.relationshipMemoriesNpcToMc);
    const relationshipMemoryEnabled = useAppStore(s => s.context.relationshipMemory === true);

    const traitTierMap = useMemo(() => Object.fromEntries(TRAIT_VOCAB.map(t => [t.text, t.tier])), []);
    const HEX_AXES: HexAxis[] = ['drive', 'diligence', 'boldness', 'warmth', 'empathy', 'composure'];

    const filteredTraitOptions = useMemo(() => {
        const q = traitSearch.toLowerCase();
        return TRAIT_NAMES.filter(t => t.toLowerCase().includes(q));
    }, [traitSearch]);

    const otherNpcs = useMemo(() => {
        const currentId = form.id;
        const list: Array<{ id: string; name: string }> = [];
        if (playerCharacter?.id && playerCharacter.id !== currentId) {
            list.push({
                id: playerCharacter.id,
                name: `${playerCharacter.name || 'Player Character'} (Player)`,
            });
        }
        for (const n of npcLedger) {
            if (n.id !== currentId) {
                list.push(n);
            }
        }
        return list;
    }, [npcLedger, playerCharacter, form.id]);

    const updateTrigger = (index: number, field: keyof NPCBehavioralTrigger, value: string) => {
        const triggers = [...(form.behavioralTriggers || [])];
        triggers[index] = { ...triggers[index], [field]: value };
        setForm({ ...form, behavioralTriggers: triggers });
    };

    const addTrigger = () => {
        setForm({ ...form, behavioralTriggers: [...(form.behavioralTriggers || []), { keyword: '', shift: '' }] });
    };

    const removeTrigger = (index: number) => {
        const triggers = [...(form.behavioralTriggers || [])];
        triggers.splice(index, 1);
        setForm({ ...form, behavioralTriggers: triggers });
    };

    const updateBoundary = (field: 'hardBoundaries' | 'softBoundaries', index: number, value: string) => {
        const list = [...(form[field] || [])];
        list[index] = value;
        setForm({ ...form, [field]: list });
    };

    const addBoundary = (field: 'hardBoundaries' | 'softBoundaries') => {
        setForm({ ...form, [field]: [...(form[field] || []), ''] });
    };

    const removeBoundary = (field: 'hardBoundaries' | 'softBoundaries', index: number) => {
        const list = [...(form[field] || [])];
        list.splice(index, 1);
        setForm({ ...form, [field]: list });
    };

    // ── Signature Kit (durable loadout) — bounded to KIT_MAX per channel, mirroring
    // sanitizeSignatureKit's cap so the UI can't author a kit the parser would trim.
    const KIT_MAX = 8;
    const emptyKit = { equipment: [] as string[], abilities: [] as string[] };
    const updateKitEntry = (field: 'equipment' | 'abilities', index: number, value: string) => {
        const kit = form.signatureKit ?? emptyKit;
        const list = [...(kit[field] || [])];
        list[index] = value;
        setForm({ ...form, signatureKit: { ...kit, [field]: list } });
    };
    const addKitEntry = (field: 'equipment' | 'abilities') => {
        const kit = form.signatureKit ?? emptyKit;
        if ((kit[field] || []).length >= KIT_MAX) return;
        setForm({ ...form, signatureKit: { ...kit, [field]: [...(kit[field] || []), ''] } });
    };
    const removeKitEntry = (field: 'equipment' | 'abilities', index: number) => {
        const kit = form.signatureKit ?? emptyKit;
        const list = [...(kit[field] || [])].filter((_, i) => i !== index);
        setForm({ ...form, signatureKit: { ...kit, [field]: list } });
    };
    const setKitElement = (value: string) => {
        const kit = form.signatureKit ?? emptyKit;
        setForm({ ...form, signatureKit: { ...kit, element: value } });
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
                        <div className="w-1/4">
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
                        <div className="w-1/4">
                            <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">Tier</label>
                            <select
                                value={form.tier || 'oneshot'}
                                onChange={e => setForm({ ...form, tier: e.target.value as 'recurring' | 'oneshot' | 'walkon' })}
                                disabled={!isEditing}
                                className="w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary disabled:opacity-70 disabled:bg-surface disabled:border-transparent outline-none focus:border-terminal transition-colors"
                            >
                                <option value="recurring">Recurring</option>
                                <option value="oneshot">One-shot</option>
                                <option value="walkon">Walk-on</option>
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
                                placeholder="e.g. Ironspire Knights, Mages Guild"
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
                            <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">Affinity (0-100) <span className="text-text-dim/50 normal-case tracking-normal">— legacy</span></label>
                            <input
                                type="number"
                                min={0}
                                max={100}
                                value={form.affinity ?? 50}
                                onChange={e => setForm({ ...form, affinity: parseInt(e.target.value, 10) || 50 })}
                                disabled={!isEditing || relationshipMemoryEnabled}
                                className="w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary disabled:opacity-70 disabled:bg-surface disabled:border-transparent focus:outline-none focus:border-terminal"
                            />
                            {form.pcRelation !== undefined && (
                                <p className="text-[9px] text-text-dim/60 mt-1 italic">Superseded by PC Relation ({form.pcRelation >= 0 ? '+' : ''}{form.pcRelation}, {relationBand(form.pcRelation)}). Shown for legacy saves only.</p>
                            )}
                        </div>
                    </div>

                    <div>
                        <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">Core Motive / Goals <span className="text-text-dim/50 normal-case tracking-normal">— legacy</span></label>
                        <textarea
                            value={form.goals || ''}
                            onChange={e => setForm({ ...form, goals: e.target.value })}
                            disabled={!isEditing}
                            placeholder="What does this character ultimately want?"
                            rows={2}
                            className="w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-surface disabled:border-transparent resize-none focus:outline-none focus:border-terminal"
                        />
                        {((form.wants?.long || '') || (form.wants?.medium?.length ?? 0) > 0) && (
                            <p className="text-[9px] text-text-dim/60 mt-1 italic">Superseded by Wants (below). Shown for legacy saves only.</p>
                        )}
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

                    {/* ── Signature Kit (durable loadout — anti-drift for gear + powers) ─────── */}
                    <div className="bg-void p-4 rounded border border-border space-y-3">
                        <div className="flex items-center justify-between">
                            <span className="text-text-primary font-bold uppercase tracking-widest text-xs">Signature Kit</span>
                            <span className="text-[9px] text-text-dim/50 normal-case tracking-normal">Durable gear &amp; powers — stays consistent across scenes</span>
                        </div>
                        <div>
                            <div className="flex items-center justify-between mb-1">
                                <label className="text-amber-400 text-[10px] uppercase tracking-wider">Equipment</label>
                                {isEditing && (form.signatureKit?.equipment?.length ?? 0) < KIT_MAX && (
                                    <button onClick={() => addKitEntry('equipment')} className="text-[9px] text-terminal hover:text-terminal/80 uppercase tracking-wider">+ Add</button>
                                )}
                            </div>
                            {(form.signatureKit?.equipment || []).map((item, i) => (
                                <div key={i} className="flex gap-2 items-center mb-1">
                                    <input
                                        type="text"
                                        value={item}
                                        onChange={e => updateKitEntry('equipment', i, e.target.value)}
                                        disabled={!isEditing}
                                        placeholder="e.g. Excalibur (holy longsword)"
                                        className="flex-1 bg-surface border border-border rounded px-2 py-1.5 text-[12px] text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-void focus:outline-none focus:border-amber-500"
                                    />
                                    {isEditing && <button onClick={() => removeKitEntry('equipment', i)} className="text-danger/60 hover:text-danger p-1 shrink-0"><Trash2 size={11} /></button>}
                                </div>
                            ))}
                            {(form.signatureKit?.equipment || []).length === 0 && (
                                <p className="text-[10px] text-text-dim/40 italic">No signature gear. This character travels light.</p>
                            )}
                        </div>
                        <div>
                            <div className="flex items-center justify-between mb-1">
                                <label className="text-ice text-[10px] uppercase tracking-wider">Abilities / Powers</label>
                                {isEditing && (form.signatureKit?.abilities?.length ?? 0) < KIT_MAX && (
                                    <button onClick={() => addKitEntry('abilities')} className="text-[9px] text-terminal hover:text-terminal/80 uppercase tracking-wider">+ Add</button>
                                )}
                            </div>
                            {(form.signatureKit?.abilities || []).map((item, i) => (
                                <div key={i} className="flex gap-2 items-center mb-1">
                                    <input
                                        type="text"
                                        value={item}
                                        onChange={e => updateKitEntry('abilities', i, e.target.value)}
                                        disabled={!isEditing}
                                        placeholder="e.g. fire magic"
                                        className="flex-1 bg-surface border border-border rounded px-2 py-1.5 text-[12px] text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-void focus:outline-none focus:border-ice"
                                    />
                                    {isEditing && <button onClick={() => removeKitEntry('abilities', i)} className="text-danger/60 hover:text-danger p-1 shrink-0"><Trash2 size={11} /></button>}
                                </div>
                            ))}
                            {(form.signatureKit?.abilities || []).length === 0 && (
                                <p className="text-[10px] text-text-dim/40 italic">No signature powers.</p>
                            )}
                        </div>
                        <div>
                            <label className="block text-amber-300 text-[10px] uppercase tracking-wider mb-1">Element / Affinity</label>
                            <input
                                type="text"
                                value={form.signatureKit?.element || ''}
                                onChange={e => setKitElement(e.target.value)}
                                disabled={!isEditing}
                                placeholder="e.g. fire (optional)"
                                className="w-full bg-surface border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-void disabled:border-transparent focus:outline-none focus:border-amber-300"
                            />
                        </div>
                    </div>

                    {/* ── Drives (legacy) UI hidden — superseded by Wants. The `drives` data still
                        round-trips through `form`/handleSave; only the editor is removed. ───────── */}

                    {/* ── Traits (searchable multi-select, max 5) ────────────────── */}
                    <div className="bg-void p-4 rounded border border-border space-y-3">
                        <div className="flex items-center justify-between">
                            <span className="text-text-primary font-bold uppercase tracking-widest text-xs">Traits</span>
                            {isEditing && (
                                <span className="text-[10px] text-text-dim uppercase tracking-wider">{(form.traits || []).length}/5</span>
                            )}
                        </div>
                        {(form.traits || []).length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                                {(form.traits || []).map(trait => (
                                    <span key={trait} className="inline-flex items-center gap-1 bg-surface border border-border rounded px-2 py-0.5 text-[12px] text-text-primary">
                                        {trait}
                                        <span className={`text-[9px] uppercase font-bold px-1 rounded ${traitTierMap[trait] === 'mature' ? 'bg-red-900/40 text-red-400' : 'bg-surface text-text-dim'}`}>
                                            {traitTierMap[trait] || 'default'}
                                        </span>
                                        {isEditing && (
                                            <button
                                                type="button"
                                                onClick={() => setForm({ ...form, traits: (form.traits || []).filter(t => t !== trait) })}
                                                className="text-text-dim hover:text-danger"
                                            >
                                                <X size={12} />
                                            </button>
                                        )}
                                    </span>
                                ))}
                            </div>
                        )}
                        {isEditing && (form.traits || []).length < 5 && (
                            <div className="relative">
                                <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-dim/50" />
                                <input
                                    type="text"
                                    value={traitSearch}
                                    onChange={e => setTraitSearch(e.target.value)}
                                    placeholder="Search traits..."
                                    className="w-full bg-surface border border-border rounded pl-7 pr-3 py-1.5 text-[12px] text-text-primary placeholder:text-text-dim/50 focus:outline-none focus:border-terminal"
                                />
                                {traitSearch && filteredTraitOptions.length > 0 && (
                                    <div className="absolute z-20 left-0 right-0 mt-1 bg-void border border-border rounded max-h-32 overflow-y-auto shadow-lg">
                                        {filteredTraitOptions
                                            .filter(t => !(form.traits || []).includes(t))
                                            .slice(0, 10)
                                            .map(t => (
                                                <button
                                                    key={t}
                                                    type="button"
                                                    onClick={() => {
                                                        setForm({ ...form, traits: [...(form.traits || []), t] });
                                                        setTraitSearch('');
                                                    }}
                                                    className="w-full text-left px-3 py-1.5 text-[12px] text-text-primary hover:bg-terminal/10 flex items-center gap-2"
                                                >
                                                    <span>{t}</span>
                                                    <span className={`text-[9px] uppercase font-bold px-1 rounded ${traitTierMap[t] === 'mature' ? 'bg-red-900/40 text-red-400' : 'bg-surface text-text-dim'}`}>
                                                        {traitTierMap[t] || 'default'}
                                                    </span>
                                                </button>
                                            ))}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    {/* ── Personality Hexagon ────────────────────────────────────── */}
                    <div className="bg-void p-4 rounded border border-border space-y-3">
                        <div className="flex items-center justify-between">
                            <span className="text-text-primary font-bold uppercase tracking-widest text-xs">Personality Hexagon</span>
                        </div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                            {HEX_AXES.map(axis => {
                                const val = form.personalityHex?.[axis] ?? 0;
                                const clamped = Math.max(-3, Math.min(3, Math.round(val)));
                                const label = hexBand(axis, clamped);
                                return (
                                    <div key={axis} className="flex flex-col gap-0.5">
                                        <label className="block text-text-dim text-[10px] uppercase tracking-wider">{axis}</label>
                                        <div className="flex items-center gap-2">
                                            <button
                                                type="button"
                                                disabled={!isEditing || clamped <= -3}
                                                onClick={() => {
                                                    const hex = { ...(form.personalityHex ?? { drive: 0, diligence: 0, boldness: 0, warmth: 0, empathy: 0, composure: 0 }) };
                                                    hex[axis] = clamped - 1;
                                                    setForm({ ...form, personalityHex: hex });
                                                }}
                                                className="p-1 text-text-dim hover:text-terminal disabled:opacity-30 disabled:cursor-not-allowed"
                                            >
                                                <ChevronDown size={14} />
                                            </button>
                                            <span className="text-[12px] font-mono text-text-primary w-4 text-center">{clamped}</span>
                                            <button
                                                type="button"
                                                disabled={!isEditing || clamped >= 3}
                                                onClick={() => {
                                                    const hex = { ...(form.personalityHex ?? { drive: 0, diligence: 0, boldness: 0, warmth: 0, empathy: 0, composure: 0 }) };
                                                    hex[axis] = clamped + 1;
                                                    setForm({ ...form, personalityHex: hex });
                                                }}
                                                className="p-1 text-text-dim hover:text-terminal disabled:opacity-30 disabled:cursor-not-allowed"
                                            >
                                                <ChevronUp size={14} />
                                            </button>
                                            <span className="text-[11px] text-terminal/80 ml-1">{label}</span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* ── Wants ─────────────────────────────────────────────────── */}
                    <div className="bg-void p-4 rounded border border-border space-y-3">
                        <div className="flex items-center justify-between">
                            <span className="text-text-primary font-bold uppercase tracking-widest text-xs">Wants</span>
                        </div>
                        <div>
                            <div className="flex items-center justify-between mb-1">
                                <label className="text-amber-400 text-[10px] uppercase tracking-wider">Short-term</label>
                                {isEditing && (
                                    <button onClick={() => setForm({ ...form, wants: { short: [...(form.wants?.short || []), ''], medium: form.wants?.medium || [], long: form.wants?.long || '' } })} className="text-[9px] text-terminal hover:text-terminal/80 uppercase tracking-wider">+ Add</button>
                                )}
                            </div>
                            {(form.wants?.short || []).map((w, i) => (
                                <div key={i} className="flex gap-2 items-center mb-1">
                                    <input
                                        type="text"
                                        value={w}
                                        onChange={e => {
                                            const short = [...(form.wants?.short || [])];
                                            short[i] = e.target.value;
                                            setForm({ ...form, wants: { short, medium: form.wants?.medium || [], long: form.wants?.long || '' } });
                                        }}
                                        disabled={!isEditing}
                                        placeholder="e.g. rest"
                                        className="flex-1 bg-surface border border-border rounded px-2 py-1.5 text-[12px] text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-void focus:outline-none focus:border-amber-500"
                                    />
                                    {isEditing && <button onClick={() => {
                                        const short = (form.wants?.short || []).filter((_, idx) => idx !== i);
                                        setForm({ ...form, wants: { short, medium: form.wants?.medium || [], long: form.wants?.long || '' } });
                                    }} className="text-danger/60 hover:text-danger p-1 shrink-0"><Trash2 size={11} /></button>}
                                </div>
                            ))}
                        </div>
                        <div>
                            <div className="flex items-center justify-between mb-1">
                                <label className="text-ice text-[10px] uppercase tracking-wider">Medium-term</label>
                                {isEditing && (
                                    <button onClick={() => setForm({ ...form, wants: { short: form.wants?.short || [], medium: [...(form.wants?.medium || []), ''], long: form.wants?.long || '' } })} className="text-[9px] text-terminal hover:text-terminal/80 uppercase tracking-wider">+ Add</button>
                                )}
                            </div>
                            {(form.wants?.medium || []).map((w, i) => (
                                <div key={i} className="flex gap-2 items-center mb-1">
                                    <input
                                        type="text"
                                        value={w}
                                        onChange={e => {
                                            const medium = [...(form.wants?.medium || [])];
                                            medium[i] = e.target.value;
                                            setForm({ ...form, wants: { short: form.wants?.short || [], medium, long: form.wants?.long || '' } });
                                        }}
                                        disabled={!isEditing}
                                        placeholder="e.g. earn wealth"
                                        className="flex-1 bg-surface border border-border rounded px-2 py-1.5 text-[12px] text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-void focus:outline-none focus:border-ice"
                                    />
                                    {isEditing && <button onClick={() => {
                                        const medium = (form.wants?.medium || []).filter((_, idx) => idx !== i);
                                        setForm({ ...form, wants: { short: form.wants?.short || [], medium, long: form.wants?.long || '' } });
                                    }} className="text-danger/60 hover:text-danger p-1 shrink-0"><Trash2 size={11} /></button>}
                                </div>
                            ))}
                        </div>
                        <div>
                            <label className="block text-amber-300 text-[10px] uppercase tracking-wider mb-1">Long-term Goal</label>
                            <input
                                type="text"
                                value={form.wants?.long || ''}
                                onChange={e => setForm({ ...form, wants: { short: form.wants?.short || [], medium: form.wants?.medium || [], long: e.target.value } })}
                                disabled={!isEditing}
                                placeholder="Single overarching life goal"
                                className="w-full bg-surface border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-void disabled:border-transparent focus:outline-none focus:border-amber-300"
                            />
                        </div>
                    </div>

                    {/* ── Region / Haunt ──────────────────────────────────────────── */}
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">Region</label>
                            <input
                                type="text"
                                value={form.region || ''}
                                onChange={e => setForm({ ...form, region: e.target.value })}
                                disabled={!isEditing}
                                placeholder="e.g. academy"
                                className="w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-surface disabled:border-transparent focus:outline-none focus:border-terminal"
                            />
                        </div>
                        <div>
                            <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">Haunt</label>
                            <input
                                type="text"
                                value={form.haunt || ''}
                                onChange={e => setForm({ ...form, haunt: e.target.value })}
                                disabled={!isEditing}
                                placeholder="e.g. the garden"
                                className="w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-surface disabled:border-transparent focus:outline-none focus:border-terminal"
                            />
                        </div>
                    </div>

                    {/* ── PC Relation ─────────────────────────────────────────────── */}
                    <div className="bg-void p-4 rounded border border-border space-y-3">
                        <div className="flex items-center justify-between">
                            <span className="text-text-primary font-bold uppercase tracking-widest text-xs">PC Relation <span className="text-text-dim/50 normal-case tracking-normal">(historical when memory is on)</span></span>
                        </div>
                        {(() => {
                            const val = form.pcRelation ?? 0;
                            const clamped = Math.max(-3, Math.min(3, Math.round(val)));
                            const label = relationBand(clamped);
                            const setClampedPcRelation = (nextVal: number) => {
                                const patch: Partial<NPCEntry> = { pcRelation: nextVal };
                                if (playerCharacter?.id && form.relations && form.relations[playerCharacter.id] !== undefined) {
                                    patch.relations = { ...form.relations, [playerCharacter.id]: nextVal };
                                }
                                setForm(prev => ({ ...prev, ...patch }));
                            };
                            return (
                                <div className="flex items-center gap-3">
                                    <button
                                        type="button"
                                        disabled={!isEditing || relationshipMemoryEnabled || clamped <= -3}
                                        onClick={() => setClampedPcRelation(clamped - 1)}
                                        className="p-1.5 text-text-dim hover:text-terminal disabled:opacity-30 disabled:cursor-not-allowed"
                                    >
                                        <ChevronDown size={16} />
                                    </button>
                                    <span className="text-sm font-mono text-text-primary w-5 text-center">{clamped}</span>
                                    <button
                                        type="button"
                                        disabled={!isEditing || relationshipMemoryEnabled || clamped >= 3}
                                        onClick={() => setClampedPcRelation(clamped + 1)}
                                        className="p-1.5 text-text-dim hover:text-terminal disabled:opacity-30 disabled:cursor-not-allowed"
                                    >
                                        <ChevronUp size={16} />
                                    </button>
                                    <span className="text-sm text-terminal/80">{label}</span>
                                </div>
                            );
                        })()}
                    </div>

                    {/* ── NPC Relations ───────────────────────────────────────────── */}
                    <div className="bg-void p-4 rounded border border-border space-y-3">
                        <div className="flex items-center justify-between">
                            <span className="text-text-primary font-bold uppercase tracking-widest text-xs">NPC Relations <span className="text-text-dim/50 normal-case tracking-normal">(historical when memory is on)</span></span>
                        </div>
                        {Object.entries(form.relations || {}).length === 0 && (
                            <p className="text-[10px] text-text-dim/40 italic">No NPC relations defined. Add one below.</p>
                        )}
                        {Object.entries(form.relations || {}).map(([targetId, value]) => {
                            const isPlayer = playerCharacter?.id === targetId;
                            const targetNpc = npcLedger.find(n => n.id === targetId) || (isPlayer ? playerCharacter : undefined);
                            const displayName = isPlayer
                                ? `${playerCharacter?.name || 'Player Character'} (Player)`
                                : (targetNpc?.name || targetId);
                            const clamped = Math.max(-3, Math.min(3, Math.round(value)));
                            const label = relationBand(clamped);

                            const updateVal = (newVal: number) => {
                                const nextRelations = { ...(form.relations || {}), [targetId]: newVal };
                                const patch: Partial<NPCEntry> = { relations: nextRelations };
                                if (isPlayer) {
                                    patch.pcRelation = newVal;
                                }
                                setForm(prev => ({ ...prev, ...patch }));
                            };

                            return (
                                <div key={targetId} className="flex items-center gap-2">
                                    <span className="flex-1 text-[12px] text-text-primary truncate">{displayName}</span>
                                    <button
                                        type="button"
                                        disabled={!isEditing || clamped <= -3}
                                        onClick={() => updateVal(clamped - 1)}
                                        className="p-1 text-text-dim hover:text-terminal disabled:opacity-30 disabled:cursor-not-allowed"
                                    >
                                        <ChevronDown size={14} />
                                    </button>
                                    <span className="text-[12px] font-mono text-text-primary w-4 text-center">{clamped}</span>
                                    <button
                                        type="button"
                                        disabled={!isEditing || clamped >= 3}
                                        onClick={() => updateVal(clamped + 1)}
                                        className="p-1 text-text-dim hover:text-terminal disabled:opacity-30 disabled:cursor-not-allowed"
                                    >
                                        <ChevronUp size={14} />
                                    </button>
                                    <span className="text-[11px] text-terminal/80 min-w-[60px]">{label}</span>
                                    {isEditing && !relationshipMemoryEnabled && (
                                        <button
                                            type="button"
                                            onClick={() => {
                                                const rest = Object.fromEntries(Object.entries(form.relations || {}).filter(([id]) => id !== targetId));
                                                setForm(prev => ({ ...prev, relations: rest }));
                                            }}
                                            className="text-danger/60 hover:text-danger p-1 shrink-0"
                                        >
                                            <Trash2 size={12} />
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                        {isEditing && !relationshipMemoryEnabled && (
                            <div className="flex gap-2 items-center">
                                <select
                                    value={relationTargetId}
                                    onChange={e => setRelationTargetId(e.target.value)}
                                    className="flex-1 bg-void border border-border rounded px-2 py-1.5 text-[12px] text-text-primary outline-none focus:border-terminal"
                                >
                                    <option value="">-- Select Character / NPC --</option>
                                    {otherNpcs.map(n => (
                                        <option key={n.id} value={n.id}>{n.name}</option>
                                    ))}
                                </select>
                                <button
                                    type="button"
                                    disabled={!relationTargetId}
                                    onClick={() => {
                                        if (!relationTargetId) return;
                                        if ((form.relations || {})[relationTargetId] !== undefined) return;
                                        const isPlayer = playerCharacter?.id === relationTargetId;
                                        const nextRelations = { ...(form.relations || {}), [relationTargetId]: 0 };
                                        const patch: Partial<NPCEntry> = { relations: nextRelations };
                                        if (isPlayer) {
                                            patch.pcRelation = 0;
                                        }
                                        setForm(prev => ({ ...prev, ...patch }));
                                         setRelationTargetId('');
                                     }}
                                     className="px-3 py-1.5 bg-terminal text-void font-bold text-[10px] uppercase tracking-wider hover:brightness-110 disabled:opacity-40 transition-all"
                                 >
                                     Add
                                 </button>
                             </div>
                         )}
                     </div>

                    <RelationshipMemoryEditor
                        records={relationshipMemoriesNpcToMc}
                        subjectId={form.id}
                        subjectLabel={form.name}
                        allowAdd={isEditing}
                        title="NPC → player memories"
                        compact
                    />

                    {/* ── Behavioral Triggers ────────────────────────────────────── */}
                    <div className="bg-void p-4 rounded border border-border space-y-3">
                        <div className="flex items-center justify-between">
                            <span className="text-text-primary font-bold uppercase tracking-widest text-xs">Behavioral Triggers</span>
                            {isEditing && (
                                <button onClick={addTrigger} className="text-[9px] text-terminal hover:text-terminal/80 uppercase tracking-wider">+ Add</button>
                            )}
                        </div>
                        {(form.behavioralTriggers || []).length === 0 && (
                            <p className="text-[10px] text-text-dim/40 italic">No triggers defined. These fire when specific keywords appear in player input.</p>
                        )}
                        {(form.behavioralTriggers || []).map((trigger, i) => (
                            <div key={i} className="flex gap-2 items-start">
                                <input
                                    type="text"
                                    value={trigger.keyword}
                                    onChange={e => updateTrigger(i, 'keyword', e.target.value)}
                                    disabled={!isEditing}
                                    placeholder="Keyword"
                                    className="flex-1 bg-surface border border-border rounded px-2 py-1.5 text-[12px] text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-void focus:outline-none focus:border-purple-400"
                                />
                                <input
                                    type="text"
                                    value={trigger.shift}
                                    onChange={e => updateTrigger(i, 'shift', e.target.value)}
                                    disabled={!isEditing}
                                    placeholder="Behavioral shift (physical/verbal)"
                                    className="flex-[2] bg-surface border border-border rounded px-2 py-1.5 text-[12px] text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-void focus:outline-none focus:border-purple-400"
                                />
                                {isEditing && (
                                    <button onClick={() => removeTrigger(i)} className="text-danger/60 hover:text-danger p-1 shrink-0">
                                        <Trash2 size={12} />
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>

                    {/* ── Boundaries ─────────────────────────────────────────────── */}
                    <div className="bg-void p-4 rounded border border-border space-y-3">
                        <div className="flex items-center justify-between">
                            <span className="text-text-primary font-bold uppercase tracking-widest text-xs">Boundaries</span>
                        </div>
                        <div>
                            <div className="flex items-center justify-between mb-1">
                                <label className="text-danger text-[10px] uppercase tracking-wider">Hard (will never do)</label>
                                {isEditing && <button onClick={() => addBoundary('hardBoundaries')} className="text-[9px] text-terminal hover:text-terminal/80 uppercase tracking-wider">+ Add</button>}
                            </div>
                            {(form.hardBoundaries || []).map((b, i) => (
                                <div key={i} className="flex gap-2 items-center mb-1">
                                    <input
                                        type="text"
                                        value={b}
                                        onChange={e => updateBoundary('hardBoundaries', i, e.target.value)}
                                        disabled={!isEditing}
                                        placeholder="e.g. Will not betray her sister"
                                        className="flex-1 bg-surface border border-border rounded px-2 py-1.5 text-[12px] text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-void focus:outline-none focus:border-danger/50"
                                    />
                                    {isEditing && <button onClick={() => removeBoundary('hardBoundaries', i)} className="text-danger/60 hover:text-danger p-1 shrink-0"><Trash2 size={11} /></button>}
                                </div>
                            ))}
                        </div>
                        <div>
                            <div className="flex items-center justify-between mb-1">
                                <label className="text-amber-400 text-[10px] uppercase tracking-wider">Soft (dislikes but may tolerate)</label>
                                {isEditing && <button onClick={() => addBoundary('softBoundaries')} className="text-[9px] text-terminal hover:text-terminal/80 uppercase tracking-wider">+ Add</button>}
                            </div>
                            {(form.softBoundaries || []).map((b, i) => (
                                <div key={i} className="flex gap-2 items-center mb-1">
                                    <input
                                        type="text"
                                        value={b}
                                        onChange={e => updateBoundary('softBoundaries', i, e.target.value)}
                                        disabled={!isEditing}
                                        placeholder="e.g. Dislikes being excluded from plans"
                                        className="flex-1 bg-surface border border-border rounded px-2 py-1.5 text-[12px] text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-void focus:outline-none focus:border-amber-500/50"
                                    />
                                    {isEditing && <button onClick={() => removeBoundary('softBoundaries', i)} className="text-danger/60 hover:text-danger p-1 shrink-0"><Trash2 size={11} /></button>}
                                </div>
                            ))}
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
                        onUploadPortrait={onUploadPortrait}
                        onRemovePortrait={onRemovePortrait}
                        onVisualProfileChange={handleVisualProfileChange}
                        appearance={form.appearance || ''}
                        onAppearanceChange={(v) => setForm(prev => ({ ...prev, appearance: v }))}
                    />
                </div>
            </div>

            {/* Established Facts for this NPC */}
            {selectedId && (() => {
                const reg = useAppStore.getState().divergenceRegister ?? EMPTY_REGISTER;
                const npcEntries = getEntriesForNpc(reg, selectedId);
                if (npcEntries.length === 0) return null;
                const chapters = useAppStore.getState().chapters ?? [];
                const chapterTitleMap = new Map(chapters.map(c => [c.chapterId, c.title]));
                const CATEGORY_COLORS: Record<DivergenceCategory, string> = {
                    locations: 'text-blue-400',
                    npc_events: 'text-terminal',
                    promises_debts: 'text-amber-400',
                    world_state: 'text-cyan-400',
                    party_facts: 'text-emerald-400',
                    rules_lore: 'text-purple-400',
                    misc: 'text-text-muted',
                };
                return (
                    <div className="mt-4 bg-void p-4 rounded border border-border space-y-2">
                        <div className="flex items-center gap-2 text-text-primary font-bold uppercase tracking-widest text-xs">
                            <ScrollText size={14} /> Events ({npcEntries.length})
                        </div>
                        <div className="space-y-1 max-h-48 overflow-y-auto">
                            {npcEntries.map(e => (
                                <div key={e.id} className="flex items-start gap-1.5 text-[11px]">
                                    <span className={`shrink-0 mt-0.5 text-[9px] uppercase font-bold ${CATEGORY_COLORS[e.category] ?? 'text-text-dim'}`}>
                                        {CATEGORY_LABELS[e.category] ?? e.category}
                                    </span>
                                    <span className="text-text-secondary min-w-0 flex-1">{e.text}</span>
                                    <span className="text-text-dim/40 text-[9px] shrink-0">[#{e.sceneRef}]{e.source === 'manual' ? ' ⚡' : ''}</span>
                                    <span className="text-text-dim/30 text-[9px] shrink-0">{chapterTitleMap.get(e.chapterId) ?? e.chapterId}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                );
            })()}

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
