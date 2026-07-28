import { useCallback, useEffect, useRef, useState } from 'react';
import { X, UserCircle, FileText, ScrollText, Package, BarChart3, Upload, Download } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { SheetTab, type SheetTabHandle } from './tabs/SheetTab';
import { RecordTab } from './tabs/RecordTab';
import { InventoryTab } from './tabs/InventoryTab';
import { StatsTab } from './tabs/StatsTab';
import { AIGuidedCreationWizard } from './AIGuidedCreationWizard';
import { ImportChoiceDialog } from '../npc-ledger/ImportChoiceDialog';
import { UnsavedChangesDialog } from './UnsavedChangesDialog';
import { prepareImportedNpcs, type NpcImportMode } from '../../services/npc/importTransform';
import { buildCharacterExportData, buildCharacterExportFilename } from '../../services/npc/characterExport';
import { toast } from '../Toast';
import { uid } from '../../utils/uid';
import type { NPCEntry, PlayerCharacter } from '../../types';

type LedgerTab = 'sheet' | 'record' | 'inventory' | 'stats';

const TABS: { key: LedgerTab; Icon: typeof FileText; label: string }[] = [
    { key: 'sheet' as const,     Icon: FileText,  label: 'Sheet' },
    { key: 'record' as const,    Icon: ScrollText, label: 'Record' },
    { key: 'inventory' as const, Icon: Package,   label: 'Inventory' },
    { key: 'stats' as const,     Icon: BarChart3,  label: 'Stats' },
];

/**
 * Character Ledger — the one home for the player character.
 *
 * Replaces `pc/PCPanelModal.tsx` (WO-A Phase 2). Pairs with the NPC Ledger:
 * both are owner-grouped modals. Same store wiring (`pcPanelOpen`,
 * `togglePCPanel`), same Escape handling, plus a 4-tab bar:
 *
 *   Sheet     — user authors (PCEditForm: identity, kit, hex, wants, portrait)
 *   Record    — engine writes, user curates (active traits, superseded, bonds, events)
 *   Inventory — engine scans, user edits (the inventory grid)
 *   Stats     — engine scans, user edits (characterProfileData: hp/level/skills)
 *
 * The old `pc` and `book` drawer tabs are gone; their editors moved in here.
 * Prompt-budget controls (TokenGauge, Smart Injection global toggle,
 * auto-update interval) moved to `EnginesTab` — they are not character data.
 */
export function CharacterLedgerModal() {
    const pcPanelOpen = useAppStore((s) => s.pcPanelOpen);
    const togglePCPanel = useAppStore((s) => s.togglePCPanel);
    const playerCharacter = useAppStore((s) => s.playerCharacter);
    const setPlayerCharacter = useAppStore((s) => s.setPlayerCharacter);

    const sheetRef = useRef<SheetTabHandle>(null);
    const [showUnsavedPrompt, setShowUnsavedPrompt] = useState(false);

    const [activeTab, setActiveTab] = useState<LedgerTab>('sheet');
    const [guidedMode, setGuidedMode] = useState(false);
    const importRef = useRef<HTMLInputElement>(null);
    // Parsed-but-not-yet-committed import, awaiting the user's mode choice.
    const [pendingImport, setPendingImport] = useState<Partial<PlayerCharacter>[] | null>(null);
    // Reset to the Sheet tab whenever the modal opens. Render-phase set
    // pattern (mirrors the prior PCPanelModal's form-sync-on-open) avoids
    // the set-state-in-effect lint error and the stale-tab carryover.
    const [prevOpen, setPrevOpen] = useState(false);
    if (prevOpen !== pcPanelOpen) {
        setPrevOpen(pcPanelOpen);
        if (pcPanelOpen) {
            setActiveTab('sheet');
            setGuidedMode(false);
            setShowUnsavedPrompt(false);
        }
    }

    // Single close-request funnel for all three close paths (backdrop click,
    // Escape key, X button). If the Sheet tab has un-saved edits, surface the
    // UnsavedChangesDialog instead of closing — the user picks Save / Discard
    // / Cancel. The guard only fires on the Sheet tab (the other tabs write
    // to the store on every keystroke, so they have no un-saved state).
    const requestClose = useCallback(() => {
        if (sheetRef.current?.isDirty()) {
            setShowUnsavedPrompt(true);
            return;
        }
        togglePCPanel();
    }, [togglePCPanel]);

    const handleSaveAndClose = useCallback(() => {
        if (sheetRef.current?.save()) {
            setShowUnsavedPrompt(false);
            togglePCPanel();
        }
    }, [togglePCPanel]);

    const handleDiscardAndClose = useCallback(() => {
        sheetRef.current?.discard();
        setShowUnsavedPrompt(false);
        togglePCPanel();
    }, [togglePCPanel]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && pcPanelOpen) requestClose();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [pcPanelOpen, requestClose]);

    if (!pcPanelOpen) return null;

    // ── Import / Export ──────────────────────────────────────────────────
    // Reuses the NPC Ledger's cross-campaign import transform verbatim: a
    // PlayerCharacter IS an NPCEntry (src/types/gamecontext.ts), so the same
    // Full/Strip/Isekai handling applies without a parallel implementation.
    const handleExport = () => {
        if (!playerCharacter) return;
        const exportData = buildCharacterExportData(playerCharacter);
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = buildCharacterExportFilename(playerCharacter.name);
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
                if (!Array.isArray(parsed)) { alert('Invalid format: expected a JSON array.'); return; }
                if (parsed.length === 0) { alert('That file contains no characters.'); return; }
                // Defer insertion until the user picks an import mode (Full / Strip / Isekai).
                setPendingImport(parsed as Partial<PlayerCharacter>[]);
            } catch { alert('Failed to parse JSON file. Please check the file format.'); }
        };
        reader.readAsText(file);
        e.target.value = '';
    };

    const commitImport = (mode: NpcImportMode) => {
        if (!pendingImport) return;
        // PC is singular — only the first entry of the imported array is used.
        const [pc] = prepareImportedNpcs(pendingImport as Partial<NPCEntry>[], mode, uid);
        if (!pc) { setPendingImport(null); return; }
        if (playerCharacter && !window.confirm(`Replace your current character "${playerCharacter.name}"?`)) {
            return;
        }
        setPlayerCharacter(pc);
        setPendingImport(null);
        toast.success(`Imported character "${pc.name}".`);
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-void/80 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-label="Character Ledger" onClick={requestClose}>
            <div
                className="bg-surface border border-border shadow-2xl rounded-lg w-full max-w-4xl max-h-[88vh] flex flex-col overflow-hidden transition-[max-width] duration-200 relative"
                style={guidedMode ? { maxWidth: 1200 } : undefined}
                onClick={e => e.stopPropagation()}
            >
                {/* Hidden import input lives INSIDE the stopPropagation container. If it sat
                    on the backdrop, importRef.current.click() would bubble a click to the
                    overlay's onClick={requestClose}, closing the modal and unmounting the
                    input before the OS file dialog resolved — so onChange never fired.
                    (Same bug class just fixed in NPCLedgerModal — do not reintroduce it.) */}
                <input ref={importRef} type="file" accept=".json" className="hidden" onChange={handleImportFile} />

                {pendingImport && (
                    <ImportChoiceDialog
                        count={pendingImport.length}
                        label="character"
                        onChoose={commitImport}
                        onCancel={() => setPendingImport(null)}
                    />
                )}

                {showUnsavedPrompt && (
                    <UnsavedChangesDialog
                        onSave={handleSaveAndClose}
                        onDiscard={handleDiscardAndClose}
                        onCancel={() => setShowUnsavedPrompt(false)}
                    />
                )}

                <div className="px-4 py-3 border-b border-border flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-2 text-terminal font-bold uppercase tracking-widest text-sm">
                        <UserCircle size={16} /> CHARACTER LEDGER
                    </div>
                    <div className="flex items-center gap-2">
                        <button onClick={() => importRef.current?.click()} title="Import character from JSON" className="flex items-center gap-1 py-1 px-2 border border-border rounded text-[10px] uppercase tracking-wider text-text-dim hover:text-terminal hover:border-terminal transition-colors">
                            <Upload size={12} /> Import
                        </button>
                        <button onClick={handleExport} disabled={!playerCharacter} title="Export character to JSON" className="flex items-center gap-1 py-1 px-2 border border-border rounded text-[10px] uppercase tracking-wider text-text-dim hover:text-terminal hover:border-terminal transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
                            <Download size={12} /> Export
                        </button>
                        <button onClick={requestClose} className="text-text-dim hover:text-text-bright transition-colors text-lg leading-none" aria-label="Close">
                            <X size={18} />
                        </button>
                    </div>
                </div>

                {guidedMode ? (
                    <AIGuidedCreationWizard
                        onCancel={() => setGuidedMode(false)}
                        onCommit={() => {
                            setGuidedMode(false);
                            setActiveTab('sheet');
                        }}
                    />
                ) : (
                    <>
                        {/* Tab Bar */}
                        <div className="flex border-b border-border shrink-0 overflow-x-auto no-scrollbar">
                            {TABS.map(({ key, Icon: TabIcon, label }) => (
                                <button
                                    key={key}
                                    onClick={() => setActiveTab(key)}
                                    className={`flex-1 flex flex-col items-center gap-0.5 py-2 px-1 text-[9px] uppercase tracking-wider transition-colors ${
                                        activeTab === key
                                            ? 'text-terminal border-b-2 border-terminal -mb-px'
                                            : 'text-text-dim hover:text-text-primary'
                                    }`}
                                    title={label}
                                >
                                    <TabIcon size={13} />
                                    {label}
                                </button>
                            ))}
                        </div>

                        {/* Tab Panels */}
                        <div className="flex-1 overflow-y-auto flex flex-col">
                            {activeTab === 'sheet' && <SheetTab ref={sheetRef} onStartGuidedCreation={() => setGuidedMode(true)} />}
                            {activeTab === 'record' && <RecordTab />}
                            {activeTab === 'inventory' && <InventoryTab />}
                            {activeTab === 'stats' && <StatsTab />}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}