import { useEffect, useState } from 'react';
import { X, UserCircle, FileText, ScrollText, Package, BarChart3 } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { SheetTab } from './tabs/SheetTab';
import { RecordTab } from './tabs/RecordTab';
import { InventoryTab } from './tabs/InventoryTab';
import { StatsTab } from './tabs/StatsTab';
import { AIGuidedCreationWizard } from './AIGuidedCreationWizard';

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

    const [activeTab, setActiveTab] = useState<LedgerTab>('sheet');
    const [guidedMode, setGuidedMode] = useState(false);
    // Reset to the Sheet tab whenever the modal opens. Render-phase set
    // pattern (mirrors the prior PCPanelModal's form-sync-on-open) avoids
    // the set-state-in-effect lint error and the stale-tab carryover.
    const [prevOpen, setPrevOpen] = useState(false);
    if (prevOpen !== pcPanelOpen) {
        setPrevOpen(pcPanelOpen);
        if (pcPanelOpen) {
            setActiveTab('sheet');
            setGuidedMode(false);
        }
    }

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && pcPanelOpen) togglePCPanel();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [pcPanelOpen, togglePCPanel]);

    if (!pcPanelOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-void/80 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-label="Character Ledger" onClick={togglePCPanel}>
            <div
                className="bg-surface border border-border shadow-2xl rounded-lg w-full max-w-4xl max-h-[88vh] flex flex-col overflow-hidden transition-[max-width] duration-200"
                style={guidedMode ? { maxWidth: 1200 } : undefined}
                onClick={e => e.stopPropagation()}
            >
                <div className="px-4 py-3 border-b border-border flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-2 text-terminal font-bold uppercase tracking-widest text-sm">
                        <UserCircle size={16} /> CHARACTER LEDGER
                    </div>
                    <button onClick={togglePCPanel} className="text-text-dim hover:text-text-bright transition-colors text-lg leading-none" aria-label="Close">
                        <X size={18} />
                    </button>
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
                            {activeTab === 'sheet' && <SheetTab onStartGuidedCreation={() => setGuidedMode(true)} />}
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