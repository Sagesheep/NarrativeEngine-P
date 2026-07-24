import { useState, useEffect, useRef, useMemo } from 'react';
import { X, Plus, Users, LayoutGrid, List, CheckSquare, Upload, Download, BookOpen, Trash2, Search, ArrowDownAZ, ArrowUpZA, Sparkles, Images } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { updateExistingNPCs } from '../services/chatEngine';
import { parseNPCsFromLore } from '../services/lore/loreNPCParser';
import type { NPCEntry, NPCVisualProfile } from '../types';
import { DEFAULT_VISUAL_PROFILE } from '../types';
import { toast } from './Toast';
import { uid } from '../utils/uid';
import { prepareImportedNpcs, type NpcImportMode } from '../services/npc/importTransform';
import { filterNPCs, type SortOrder } from '../utils/ledgerFilters';

import { NPCListView } from './npc-ledger/NPCListView';
import { NPCGalleryView } from './npc-ledger/NPCGalleryView';
import { NPCEditForm } from './npc-ledger/NPCEditForm';
import { NPCSuggestionsPanel } from './npc-ledger/NPCSuggestionsPanel';
import { NPCReviewModal } from './NPCReviewModal';
import { ImportChoiceDialog } from './npc-ledger/ImportChoiceDialog';
import { useNpcReview } from './hooks/useNpcReview';
import { useNpcPortraits } from './hooks/useNpcPortraits';

export function NPCLedgerModal() {
    const { npcLedger, npcLedgerOpen, toggleNPCLedger, addNPC, updateNPC, removeNPC, setNPCLedger, addNPCs, restoreNPC, npcSuggestions } = useAppStore();
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [isEditing, setIsEditing] = useState(false);

    const [viewMode, setViewMode] = useState<'list' | 'gallery'>('list');
    const [isAIUpdating, setIsAIUpdating] = useState(false);

    const [selectMode, setSelectMode] = useState(false);
    const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
    const [searchQuery, setSearchQuery] = useState('');
    const [sortOrder, setSortOrder] = useState<SortOrder>('none');
    const importRef = useRef<HTMLInputElement>(null);
    // Parsed-but-not-yet-committed import, awaiting the user's mode choice.
    const [pendingImport, setPendingImport] = useState<Partial<NPCEntry>[] | null>(null);

    const displayedNPCs = useMemo(() => filterNPCs(npcLedger, searchQuery, sortOrder), [npcLedger, searchQuery, sortOrder]);

    const review = useNpcReview();
    const portraits = useNpcPortraits();

    const [form, setForm] = useState<Partial<NPCEntry>>({
        status: 'Alive', voice: '', personality: '', exampleOutput: '',
        visualProfile: { ...DEFAULT_VISUAL_PROFILE }
    });

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && npcLedgerOpen) toggleNPCLedger();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [npcLedgerOpen, toggleNPCLedger]);

    if (!npcLedgerOpen) return null;

    // ── Handlers ─────────────────────────────────────────────────────────
    const handleSelect = (npc: NPCEntry) => {
        if (selectMode) return;
        setSelectedId(npc.id);
        setForm({ ...npc, visualProfile: npc.visualProfile || { ...DEFAULT_VISUAL_PROFILE } });
        setIsEditing(false);
    };

    const handleCreateNew = () => {
        setSelectedId(null);
        setForm({
            name: '', aliases: '', appearance: '', faction: '', storyRelevance: '', disposition: '',
            status: 'Alive', goals: '', voice: '', personality: '', exampleOutput: '',
            visualProfile: { ...DEFAULT_VISUAL_PROFILE }
        });
        setIsEditing(true);
        setSelectMode(false);
        setCheckedIds(new Set());
    };

    const handleSave = () => {
        if (!form.name?.trim()) return;
        if (selectedId) {
            updateNPC(selectedId, form);
        } else {
            addNPC({ ...form, id: uid() } as NPCEntry);
        }
        setIsEditing(false);
    };

    const handleDelete = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (confirm('Delete this NPC from the ledger?')) {
            removeNPC(id);
            if (selectedId === id) { setSelectedId(null); setIsEditing(false); }
        }
    };

    const toggleCheck = (id: string) => {
        setCheckedIds(prev => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    };

    const allChecked = displayedNPCs.length > 0 && checkedIds.size === displayedNPCs.length;

    const handleSelectAll = () => {
        setCheckedIds(allChecked ? new Set() : new Set(displayedNPCs.map(n => n.id)));
    };

    const handleDeleteSelected = () => {
        if (checkedIds.size === 0) return;
        if (!confirm(`Delete ${checkedIds.size} selected NPC(s) from the ledger?`)) return;
        setNPCLedger(npcLedger.filter(n => !checkedIds.has(n.id)));
        if (selectedId && checkedIds.has(selectedId)) { setSelectedId(null); setIsEditing(false); }
        setCheckedIds(new Set());
        setSelectMode(false);
    };

    const handleExitSelectMode = () => { setSelectMode(false); setCheckedIds(new Set()); };

    // ── Import / Export ──────────────────────────────────────────────────
    const handleExport = () => {
        const exportData = npcLedger.map(({ portrait: _p, ...rest }) => rest);
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `npc_ledger_export_${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const parsed = JSON.parse(ev.target?.result as string);
                if (!Array.isArray(parsed)) { alert('Invalid format: expected a JSON array of NPCs.'); return; }
                if (parsed.length === 0) { alert('That file contains no NPCs.'); return; }
                // Defer insertion until the user picks an import mode (Full / Strip / Isekai).
                setPendingImport(parsed as Partial<NPCEntry>[]);
            } catch { alert('Failed to parse JSON file. Please check the file format.'); }
        };
        reader.readAsText(file);
        e.target.value = '';
    };

    const commitImport = (mode: NpcImportMode) => {
        if (!pendingImport) return;
        const imported = prepareImportedNpcs(pendingImport, mode, uid);
        addNPCs(imported);
        setPendingImport(null);
        toast.success(`Imported ${imported.length} NPC(s).`);
    };

    const handleSeedFromLore = () => {
        const chunks = useAppStore.getState().loreChunks || [];
        const parsed = parseNPCsFromLore(chunks);
        if (parsed.length === 0) { alert('No ## CHARACTERS block found in the lore file.'); return; }

        const existingByName = new Map(npcLedger.map(n => [n.name.toLowerCase(), n]));
        const newNpcs: NPCEntry[] = [];
        let updatedCount = 0;

        const hasVisualData = (vp?: NPCVisualProfile) => !!(vp && (vp.race || vp.gender || vp.ageRange || vp.build || vp.symmetry || vp.hairStyle || vp.eyeColor || vp.skinTone || vp.gait || vp.distinctMarks || vp.clothing));

        for (const incoming of parsed) {
            const existing = existingByName.get(incoming.name.toLowerCase());
            if (!existing) { newNpcs.push(incoming); continue; }
            const incomingVP = incoming.visualProfile;
            if (!hasVisualData(incomingVP)) continue;
            const currentVP = existing.visualProfile || { ...DEFAULT_VISUAL_PROFILE };
            const mergedVP: NPCVisualProfile = {
                race: currentVP.race || incomingVP?.race || '', gender: currentVP.gender || incomingVP?.gender || '',
                ageRange: currentVP.ageRange || incomingVP?.ageRange || '', build: currentVP.build || incomingVP?.build || '',
                symmetry: currentVP.symmetry || incomingVP?.symmetry || '', hairStyle: currentVP.hairStyle || incomingVP?.hairStyle || '',
                eyeColor: currentVP.eyeColor || incomingVP?.eyeColor || '', skinTone: currentVP.skinTone || incomingVP?.skinTone || '',
                gait: currentVP.gait || incomingVP?.gait || '', distinctMarks: currentVP.distinctMarks || incomingVP?.distinctMarks || '',
                clothing: currentVP.clothing || incomingVP?.clothing || '', artStyle: currentVP.artStyle || incomingVP?.artStyle || 'Stylized Game Realism',
            };
            const vpChanged = Object.keys(mergedVP).some(k => mergedVP[k as keyof NPCVisualProfile] !== (currentVP[k as keyof NPCVisualProfile] || (k === 'artStyle' ? 'Stylized Game Realism' : '')));
            const appearanceChanged = !existing.appearance && !!incoming.appearance;
            if (vpChanged || appearanceChanged) {
                updateNPC(existing.id, { appearance: existing.appearance || incoming.appearance, visualProfile: mergedVP });
                updatedCount += 1;
            }
        }

        if (newNpcs.length > 0) addNPCs(newNpcs);
        if (newNpcs.length === 0 && updatedCount === 0) { alert('No new lore characters found, and no existing records needed visual-profile updates.'); return; }
        alert(`Lore sync complete: added ${newNpcs.length} new NPC(s), updated ${updatedCount} existing NPC(s).`);
    };

    // ── Portrait / AI ────────────────────────────────────────────────────
    const handleGeneratePortrait = () => portraits.generateForForm(form, form.id, isEditing, (patch) => setForm(prev => ({ ...prev, ...patch })));
    const handleUploadPortrait = (file: File) => portraits.uploadForForm(file, form.name || 'Unknown', form.id, isEditing, (patch) => setForm(prev => ({ ...prev, ...patch })));
    const handleRemovePortrait = () => {
        const patch = { portrait: '' };
        setForm(prev => ({ ...prev, ...patch }));
        if (!isEditing && form.id) useAppStore.getState().updateNPC(form.id, patch);
    };
    const handlePopulateImages = () => portraits.populateAll(npcLedger, selectedId, (patch) => setForm(prev => ({ ...prev, ...patch })));

    const handleAIUpdate = async () => {
        if (!selectedId || !form.name) return;
        const state = useAppStore.getState();
        const provider = state.getActiveStoryEndpoint();
        if (!provider) { alert('Story AI endpoint is not configured.'); return; }
        const npc = npcLedger.find(n => n.id === selectedId);
        if (!npc) return;
        setIsAIUpdating(true);
        try {
            await updateExistingNPCs(provider, state.messages, [npc], (id, patch) => {
                updateNPC(id, patch);
                setForm(prev => ({ ...prev, ...patch }));
            });
        } catch (err: unknown) {
            console.error('[NPC Manual AI Update] Error:', err);
            toast.error('AI update failed for this NPC');
        } finally {
            setIsAIUpdating(false);
        }
    };

    const handleCancelEdit = () => {
        const npc = npcLedger.find(n => n.id === selectedId);
        if (npc) setForm({ ...npc, visualProfile: npc.visualProfile || { ...DEFAULT_VISUAL_PROFILE } });
        setIsEditing(false);
    };

    const missingPortraitCount = npcLedger.filter(n => !n.portrait).length;

    // ── Render ────────────────────────────────────────────────────────────
    return (
        <div className="fixed inset-0 z-50 flex flex-col bg-void/95 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="NPC Ledger" onClick={toggleNPCLedger}>
            <div className="relative bg-surface border border-border flex flex-col sm:flex-row w-full h-full overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>
                {/* Hidden import input lives INSIDE the stopPropagation container. If it sat
                    on the backdrop, importRef.current.click() would bubble a click to the
                    overlay's onClick={toggleNPCLedger}, closing the modal and unmounting the
                    input before the OS file dialog resolved — so onChange never fired. */}
                <input ref={importRef} type="file" accept=".json" className="hidden" onChange={handleImportFile} />

                {pendingImport && (
                    <ImportChoiceDialog
                        count={pendingImport.length}
                        label="NPC"
                        onChoose={commitImport}
                        onCancel={() => setPendingImport(null)}
                    />
                )}

                {/* Left Sidebar */}
                <div className="w-full sm:w-1/3 md:w-96 lg:w-[420px] border-b sm:border-b-0 sm:border-r border-border flex flex-col bg-void-lighter max-h-[40vh] sm:max-h-none shrink-0">
                    {/* Header */}
                    <div className="p-4 border-b border-border flex justify-between items-center bg-void">
                        <div className="flex items-center gap-2 text-terminal font-bold uppercase tracking-widest text-sm">
                            <Users size={16} /> NPC Ledger
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="flex bg-surface border border-border rounded overflow-hidden">
                                <button onClick={() => setViewMode('list')} className={`p-1.5 transition-colors ${viewMode === 'list' ? 'bg-terminal text-void' : 'text-text-dim hover:text-text-primary'}`} title="List View">
                                    <List size={14} />
                                </button>
                                <button onClick={() => setViewMode('gallery')} className={`p-1.5 transition-colors ${viewMode === 'gallery' ? 'bg-terminal text-void' : 'text-text-dim hover:text-text-primary'}`} title="Gallery View">
                                    <LayoutGrid size={14} />
                                </button>
                            </div>
                            <button onClick={() => setSortOrder(prev => prev === 'none' ? 'az' : prev === 'az' ? 'za' : 'none')} className={`p-1.5 border border-border rounded transition-colors ${sortOrder !== 'none' ? 'bg-terminal text-void border-terminal' : 'text-text-dim hover:text-text-primary'}`} title={sortOrder === 'az' ? 'Sorted A→Z (click for Z→A)' : sortOrder === 'za' ? 'Sorted Z→A (click to clear)' : 'Sort alphabetically'}>
                                {sortOrder === 'za' ? <ArrowUpZA size={14} /> : <ArrowDownAZ size={14} />}
                            </button>
                            <button onClick={toggleNPCLedger} className="text-text-dim hover:text-text-primary p-1 sm:hidden shrink-0"><X size={18} /></button>
                        </div>
                    </div>

                    {/* Search Bar */}
                    <div className="px-3 py-2 border-b border-border bg-void-lighter shrink-0">
                        <div className="relative">
                            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-dim" />
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                                placeholder="Search name, alias, faction..."
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
                        <div className="flex gap-1.5">
                            <button onClick={handleCreateNew} className={`flex-1 flex items-center justify-center gap-2 py-2 px-4 border border-dashed rounded text-xs uppercase tracking-wider transition-colors ${!selectedId && isEditing ? 'border-terminal text-terminal bg-terminal/10' : 'border-border text-text-dim hover:text-terminal hover:border-terminal'}`}>
                                <Plus size={14} /> New Record
                            </button>
                            <button
                                onClick={review.startReview}
                                disabled={review.reviewRunning || npcLedger.length === 0}
                                className="flex-1 flex items-center justify-center gap-1.5 border border-amber-500/30 rounded text-xs uppercase tracking-wider text-amber-400 hover:bg-amber-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer animate-pulse-subtle"
                                title="Run AI review to flag non-character ledger entries"
                            >
                                <Sparkles size={12} className="shrink-0" /> Review & Prune
                            </button>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <button onClick={() => importRef.current?.click()} title="Import NPCs from JSON" className="flex-1 flex items-center justify-center gap-1 py-1.5 px-2 border border-border rounded text-[10px] uppercase tracking-wider text-text-dim hover:text-terminal hover:border-terminal transition-colors">
                                <Upload size={11} /> Import
                            </button>
                            <button onClick={handleSeedFromLore} title="Seed from Lore" className="flex-1 flex items-center justify-center gap-1 py-1.5 px-2 border border-border rounded text-[10px] uppercase tracking-wider text-text-dim hover:text-terminal hover:border-terminal transition-colors">
                                <BookOpen size={11} /> Seed
                            </button>
                            <button onClick={handleExport} disabled={npcLedger.length === 0} title="Export NPCs to JSON" className="flex-1 flex items-center justify-center gap-1 py-1.5 px-2 border border-border rounded text-[10px] uppercase tracking-wider text-text-dim hover:text-terminal hover:border-terminal transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
                                <Download size={11} /> Export
                            </button>
                            <button onClick={selectMode ? handleExitSelectMode : () => setSelectMode(true)} title={selectMode ? 'Exit select mode' : 'Select NPCs for bulk action'} className={`flex-1 flex items-center justify-center gap-1 py-1.5 px-2 border rounded text-[10px] uppercase tracking-wider transition-colors ${selectMode ? 'border-terminal text-terminal bg-terminal/10' : 'border-border text-text-dim hover:text-terminal hover:border-terminal'}`}>
                                <CheckSquare size={11} /> Select
                            </button>
                        </div>
                        {missingPortraitCount > 0 && (
                            <button
                                onClick={handlePopulateImages}
                                disabled={!!portraits.populating}
                                className="w-full flex items-center justify-center gap-1.5 py-1.5 border border-terminal/30 rounded text-[10px] uppercase tracking-wider text-terminal hover:bg-terminal/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                            >
                                <Images size={12} className="shrink-0" />
                                {portraits.populating
                                    ? `Generating ${portraits.populating.done}/${portraits.populating.total}…`
                                    : `Populate Images (${missingPortraitCount})`}
                            </button>
                        )}
                        {selectMode && (
                            <div className="flex items-center justify-between gap-2 pt-1">
                                <button onClick={handleSelectAll} className="text-[10px] uppercase tracking-wider text-text-dim hover:text-terminal transition-colors">
                                    {allChecked ? 'Deselect All' : 'Select All'}
                                </button>
                                <button onClick={handleDeleteSelected} disabled={checkedIds.size === 0} className="flex items-center gap-1 px-3 py-1 bg-danger/10 border border-danger/30 text-danger text-[10px] uppercase tracking-wider rounded hover:bg-danger/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
                                    <Trash2 size={10} /> Delete ({checkedIds.size})
                                </button>
                            </div>
                        )}
                    </div>

                    {/* List or Gallery */}
                    {searchQuery.trim() && displayedNPCs.length !== npcLedger.length && (
                        <div className="px-3 py-1.5 text-[10px] text-text-dim border-b border-border bg-void-lighter shrink-0">
                            Showing {displayedNPCs.length} of {npcLedger.length} records
                        </div>
                    )}
                    {!searchQuery.trim() && npcSuggestions && npcSuggestions.length > 0 && (
                        <div className="px-3 pt-2 shrink-0">
                            <NPCSuggestionsPanel suggestions={npcSuggestions} />
                        </div>
                    )}
                    {viewMode === 'list'
                        ? <NPCListView npcLedger={displayedNPCs} selectedId={selectedId} selectMode={selectMode} checkedIds={checkedIds} onSelect={handleSelect} onToggleCheck={toggleCheck} onDelete={handleDelete} onRestore={(id) => restoreNPC(id)} />
                        : <NPCGalleryView npcLedger={displayedNPCs} selectedId={selectedId} selectMode={selectMode} checkedIds={checkedIds} onSelect={handleSelect} onToggleCheck={toggleCheck} onDelete={handleDelete} onRestore={(id) => restoreNPC(id)} />
                    }
                </div>

                {/* Right Detail Pane */}
                <div className="flex-1 flex flex-col bg-surface overflow-hidden relative">
                    <button onClick={toggleNPCLedger} className="absolute top-4 right-4 text-text-dim hover:text-text-primary hidden sm:block p-1 bg-void rounded border border-border hover:border-terminal transition-colors z-10">
                        <X size={18} />
                    </button>
                    <NPCEditForm
                        form={form}
                        setForm={setForm}
                        selectedId={selectedId}
                        isEditing={isEditing}
                        isAIUpdating={isAIUpdating}
                        isGeneratingImage={portraits.isGeneratingImage}
                        onEdit={() => setIsEditing(true)}
                        onSave={handleSave}
                        onCancel={handleCancelEdit}
                        onDelete={handleDelete}
                        onAIUpdate={handleAIUpdate}
                        onGeneratePortrait={handleGeneratePortrait}
                        onUploadPortrait={handleUploadPortrait}
                        onRemovePortrait={handleRemovePortrait}
                    />
                </div>
            </div>
            <NPCReviewModal
                open={review.reviewOpen}
                running={review.reviewRunning}
                progress={review.reviewProgress}
                candidates={review.reviewCandidates}
                failedBatches={review.reviewFailedBatches}
                actions={review.reviewActions}
                error={review.reviewError}
                onCancel={review.closeReview}
                onStop={review.stopReview}
                onSetAction={review.setReviewAction}
                onApply={() => review.applyReview({
                    selectedId,
                    onClearedSelection: () => { setSelectedId(null); setIsEditing(false); },
                })}
            />
        </div>
    );
}