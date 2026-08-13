import { useState, useMemo } from 'react';
import { Trash2, Plus, AlertCircle, Eye, EyeOff, ScrollText } from 'lucide-react';
import { useAppStore } from '../../../store/useAppStore';
import { uid } from '../../../utils/uid';
import type { CharacterProfileState, CharacterTrait, DivergenceCategory } from '../../../types';
import { TraitRow, IdentityFields } from '../profileFields';
import { selectPcBonds } from '../pcBonds';
import { getEntriesForNpc, CATEGORY_LABELS, EMPTY_REGISTER } from '../../../services/campaign-state/divergenceRegister';
import { RelationshipMemoryEditor } from '../RelationshipMemoryEditor';

const CATEGORY_COLORS: Record<DivergenceCategory, string> = {
    locations: 'text-blue-400',
    npc_events: 'text-terminal',
    promises_debts: 'text-amber-400',
    world_state: 'text-cyan-400',
    party_facts: 'text-emerald-400',
    rules_lore: 'text-purple-400',
    misc: 'text-text-muted',
};

/**
 * Character Ledger — Record tab.
 *
 * Owner: engine writes, user curates. Hosts the CharacterProfileEditor
 * (identity fields, active traits, superseded history, the injection
 * ON/OFF toggle), the Bonds section (read-only pcRelation summary), and the
 * established-events list for this PC. Moved here from the old ContextDrawer
 * `pc` tab (CharacterProfileEditor.tsx) + PCPanelModal's Bonds section +
 * PCEditForm's inline established-events block.
 *
 * Function-identical to the source components — no behaviour changes.
 */
export function RecordTab() {
    const context = useAppStore(s => s.context);
    const updateContext = useAppStore(s => s.updateContext);
    const npcLedger = useAppStore(s => s.npcLedger);
    const playerCharacter = useAppStore(s => s.playerCharacter);
    const togglePCPanel = useAppStore(s => s.togglePCPanel);
    const toggleNPCLedger = useAppStore(s => s.toggleNPCLedger);
    const divergenceRegister = useAppStore(s => s.divergenceRegister);
    const chapters = useAppStore(s => s.chapters);
    const relationshipMemoriesNpcToMc = useAppStore(s => s.relationshipMemoriesNpcToMc);
    const relationshipMemoryEnabled = context.relationshipMemory === true;

    const profile: CharacterProfileState = context.characterProfile ?? { identity: {}, activeTraits: [] };
    const active = context.characterProfileActive ?? false;

    const onChange = (next: CharacterProfileState) => {
        updateContext({ characterProfile: next });
    };

    const onToggle = () => {
        updateContext({ characterProfileActive: !active });
    };

    const activeTraits = profile.activeTraits.filter(t => !t.superseded);
    const supersededTraits = profile.activeTraits.filter(t => t.superseded);
    const [showSuperseded, setShowSuperseded] = useState(false);

    const updateTrait = (id: string, patch: Partial<CharacterTrait>) => {
        onChange({
            ...profile,
            activeTraits: profile.activeTraits.map(t => t.id === id ? { ...t, ...patch } : t),
        });
    };

    const addTrait = () => {
        const newTrait: CharacterTrait = {
            id: uid(),
            subject: profile.identity.name || 'PC',
            category: 'party_facts',
            text: '',
            importance: 5,
            eventTags: [],
            sceneEstablished: 'manual',
            superseded: false,
            source: 'manual',
        };
        onChange({ ...profile, activeTraits: [...profile.activeTraits, newTrait] });
    };

    const removeTrait = (id: string) => {
        onChange({ ...profile, activeTraits: profile.activeTraits.filter(t => t.id !== id) });
    };

    const supersedeTrait = (id: string) => {
        updateTrait(id, { superseded: true });
    };

    const updateIdentity = (patch: Partial<CharacterProfileState['identity']>) => {
        onChange({ ...profile, identity: { ...profile.identity, ...patch } });
    };

    const bonds = useMemo(() => selectPcBonds(npcLedger ?? []), [npcLedger]);

    const openBondInLedger = (npcId: string) => {
        togglePCPanel();
        if (!useAppStore.getState().npcLedgerOpen) toggleNPCLedger();
        void npcId;
    };

    const pcEntries = useMemo(() => {
        if (!playerCharacter?.id) return [];
        const reg = divergenceRegister ?? EMPTY_REGISTER;
        return getEntriesForNpc(reg, playerCharacter.id);
    }, [divergenceRegister, playerCharacter]);

    const chapterTitleMap = useMemo(() => new Map((chapters ?? []).map(c => [c.chapterId, c.title])), [chapters]);

    return (
        <div className="px-4 py-4 space-y-3">
            <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-ember">
                    <span>Character Profile</span>
                </label>
                <button
                    onClick={onToggle}
                    className={`flex items-center gap-1 text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded border transition-colors ${active ? 'border-terminal/40 text-terminal bg-terminal/10' : 'border-border text-text-dim hover:text-text-primary'}`}
                    title={active ? 'Profile is being injected into the prompt' : 'Profile injection is OFF'}
                >
                    {active ? <Eye size={10} /> : <EyeOff size={10} />}
                    {active ? 'ON' : 'OFF'}
                </button>
            </div>

            <div className={`space-y-3 border px-3 py-3 bg-void transition-opacity min-h-[100px] ${active ? 'border-border' : 'border-border/40 opacity-50'}`}>
                {/* Identity section — always injected (Tier 1 core) */}
                <div className="space-y-1.5">
                    <p className="text-[9px] uppercase tracking-widest text-text-dim/70">Identity (always sent)</p>
                    <IdentityFields
                        identity={profile.identity}
                        onChange={updateIdentity}
                        disabled={!active}
                    />
                </div>

                {/* Active traits */}
                <div className="space-y-2">
                    <div className="flex items-center justify-between">
                        <p className="text-[9px] uppercase tracking-widest text-text-dim/70">
                            Active Traits ({activeTraits.length}/10)
                        </p>
                        <button
                            onClick={addTrait}
                            disabled={activeTraits.length >= 10}
                            className="flex items-center gap-1 text-[10px] text-terminal/70 hover:text-terminal disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                            <Plus size={12} /> Add
                        </button>
                    </div>

                    {activeTraits.length === 0 && (
                        <p className="text-[10px] text-text-dim/40 italic px-1">
                            No active traits. The profile parser will add traits as the story progresses, or add one manually.
                        </p>
                    )}

                    {activeTraits.map(trait => (
                        <TraitRow
                            key={trait.id}
                            trait={trait}
                            onChange={(patch) => updateTrait(trait.id, patch)}
                            onSupersede={() => supersedeTrait(trait.id)}
                            onRemove={() => removeTrait(trait.id)}
                        />
                    ))}
                </div>

                {/* Superseded traits (collapsed) */}
                {supersededTraits.length > 0 && (
                    <div>
                        <button
                            onClick={() => setShowSuperseded(!showSuperseded)}
                            className="text-[9px] text-text-dim/50 hover:text-text-dim"
                        >
                            {showSuperseded ? '▾' : '▸'} {supersededTraits.length} superseded (historical)
                        </button>
                        {showSuperseded && (
                            <div className="space-y-1 mt-1">
                                {supersededTraits.map(trait => (
                                    <div key={trait.id} className="flex items-center gap-2 px-2 py-1 opacity-40">
                                        <AlertCircle size={10} className="text-text-dim shrink-0" />
                                        <span className="text-[10px] text-text-dim line-through flex-1 truncate">{trait.text}</span>
                                        <button
                                            onClick={() => removeTrait(trait.id)}
                                            className="text-text-dim/40 hover:text-red-400"
                                        >
                                            <Trash2 size={10} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* Legacy notes (frozen, read-only) */}
                {profile.legacyNotes && (
                    <div>
                        <p className="text-[9px] text-text-dim/50">
                            Legacy profile preserved from upgrade (not injected): {profile.legacyNotes.length.toLocaleString()} chars
                        </p>
                    </div>
                )}
            </div>

            {/* ── Bonds (read-only — engine-owned pcRelation on NPC rows) ─────── */}
            <div className="border-t border-border/30 pt-3">
                <h3 className="text-[10px] uppercase tracking-widest text-terminal/70 border-b border-border/50 pb-1 mb-3">
                    Bonds <span className="text-text-dim/50 normal-case tracking-normal">({relationshipMemoryEnabled ? 'historical — use memories' : 'read-only — engine-owned'})</span>
                </h3>
                {bonds.length === 0 ? (
                    <p className="text-[10px] text-text-dim italic">No established relationships yet.</p>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {bonds.map(n => {
                            const v = n.pcRelation!;
                            const pct = Math.abs(v) / 3 * 100;
                            const color = v > 0 ? 'bg-terminal' : 'bg-ember';
                            return (
                                <button
                                    key={n.id}
                                    onClick={() => openBondInLedger(n.id)}
                                    className="w-full flex items-center gap-3 p-2 bg-void-lighter border border-border/40 rounded hover:border-terminal/40 transition-colors text-left"
                                >
                                    <div className="w-7 h-7 rounded bg-void-dark border border-border/40 flex items-center justify-center text-[9px] text-text-dim uppercase shrink-0 overflow-hidden">
                                        {n.portrait ? <img src={n.portrait} alt={n.name} className="w-full h-full object-cover" /> : n.name.slice(0, 2)}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-[12px] text-text-bright truncate">{n.name}</p>
                                        <div className="h-1.5 bg-void-dark rounded mt-0.5 overflow-hidden">
                                            <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
                                        </div>
                                    </div>
                                    <span className={`text-[11px] font-mono shrink-0 ${v > 0 ? 'text-terminal' : 'text-ember'}`}>{v > 0 ? '+' : ''}{v}</span>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* ── Established Events for this PC ──────────────────────────────── */}
             <div className="border-t border-border/30 pt-3">
                 <RelationshipMemoryEditor
                     records={relationshipMemoriesNpcToMc}
                     allowAdd
                     title="NPC → player memories"
                 />
             </div>

             {playerCharacter?.id && pcEntries.length > 0 && (
                <div className="border-t border-border/30 pt-3">
                    <div className="flex items-center gap-2 text-text-primary font-bold uppercase tracking-widest text-xs mb-2">
                        <ScrollText size={14} /> Events ({pcEntries.length})
                    </div>
                    <div className="space-y-1 max-h-48 overflow-y-auto">
                        {pcEntries.map(e => (
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
            )}
        </div>
    );
}
