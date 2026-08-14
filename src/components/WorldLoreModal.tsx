import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight, Plus, Download, FileText } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import type { WorldLoreDraft } from '../types';
import { uid } from '../utils/uid';
import { AccordionList } from './AccordionList';
import { LoreTextarea } from './LoreTextarea';
import { downloadMarkdown } from '../services/lore/worldLoreExport';
import { LoreImportReviewModal } from './LoreImportReviewModal';
import { ScreenLightbox } from './ScreenLightbox';

const FLAT_SECTIONS: { key: keyof WorldLoreDraft; label: string; placeholder: string }[] = [
    { key: 'background', label: 'World Background', placeholder: 'Describe the world\'s history, core conflict, and tone...' },
    { key: 'languages', label: 'Languages & Naming Conventions', placeholder: 'Explain naming patterns, language families, how place/person names work...' },
    { key: 'powerSystem', label: 'Power System', placeholder: 'How does magic/technology/energy work? What are its limits and costs?' },
    { key: 'techEconomy', label: 'Technology & Economy Level', placeholder: 'What tech level? Currency systems? Trade routes? Scarcity?' },
    { key: 'timeline', label: 'Timeline / Calendar / Current Era', placeholder: 'Calendar system, current date, major historical periods...' },
    { key: 'toneBoundaries', label: 'Tone & Content Boundaries', placeholder: 'What tone should the AI maintain? Any topics to avoid or embrace?' },
    { key: 'houseRules', label: 'House Rules / Mechanical Conventions', placeholder: 'Custom rules, dice conventions, homebrew mechanics the AI should respect...' },
];

const LIST_SECTIONS: { key: keyof Pick<WorldLoreDraft, 'locations' | 'cultures' | 'factions' | 'threats' | 'npcs'>; label: string; noun: string; placeholder: string }[] = [
    { key: 'locations', label: 'Geography & Locations', noun: 'location', placeholder: 'Describe this location...' },
    { key: 'cultures', label: 'Cultures', noun: 'culture', placeholder: 'Describe this culture...' },
    { key: 'factions', label: 'Established Factions', noun: 'faction', placeholder: 'Describe this faction...' },
    { key: 'threats', label: 'Threats / Antagonist Forces', noun: 'threat', placeholder: 'Describe this threat...' },
    { key: 'npcs', label: 'Pre-seeded NPCs', noun: 'NPC', placeholder: 'Describe this NPC...' },
];

export function WorldLoreModal() {
    const { worldLoreDrafts, worldLoreActiveDraftId, worldLoreModalOpen, toggleWorldLoreModal, createDraft, deleteDraft, updateDraftField, addItem, updateItem, removeItem, setActiveDraft, loadWorldLoreDrafts } = useAppStore();

    const [expanded, setExpanded] = useState<Record<string, boolean>>({
        background: true,
    });
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
    const [importModalOpen, setImportModalOpen] = useState(false);

    useEffect(() => {
        loadWorldLoreDrafts();
    }, [loadWorldLoreDrafts]);

    const activeDraft = worldLoreDrafts.find((d) => d.id === worldLoreActiveDraftId) ?? null;

    // Escape-to-close is ScreenLightbox's job now. This component used to run
    // its own `window` keydown listener; once it moved onto the shell BOTH
    // fired for one keypress, calling the toggle twice — the screen closed and
    // immediately reopened, so Escape looked like it did nothing.

    const toggleSection = useCallback((key: string) => {
        setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
    }, []);

    if (!worldLoreModalOpen) return null;

    const handleCreateDraft = () => {
        const id = createDraft();
        setActiveDraft(id);
    };

    const handleDeleteDraft = (id: string) => {
        deleteDraft(id);
        setConfirmDelete(null);
    };

    const handleExport = () => {
        if (!activeDraft) return;
        downloadMarkdown(activeDraft);
    };

    const handleImportMerge = (flatUpdates: Partial<WorldLoreDraft>, listItems: Record<string, { title: string; body: string }[]>, rawSource: string) => {
        if (!activeDraft) return;
        const id = activeDraft.id;
        updateDraftField(id, 'rawSource', rawSource);
        for (const [key, value] of Object.entries(flatUpdates)) {
            updateDraftField(id, key as keyof WorldLoreDraft, value);
        }
        for (const [cat, items] of Object.entries(listItems)) {
            const listKey = cat as 'locations' | 'cultures' | 'factions' | 'threats' | 'npcs';
            for (const item of items) {
                addItem(id, listKey, { id: uid(), title: item.title, body: item.body });
            }
        }
    };

    return (
        <>
            <ScreenLightbox
                size="full"
                width="wide"
                title="World Lore Builder"
                onClose={toggleWorldLoreModal}
                footer={activeDraft ? (
                    <div className="flex items-center justify-between p-4">
                        <button
                            onClick={() => setImportModalOpen(true)}
                            className="flex items-center gap-1.5 text-xs text-text-dim hover:text-terminal transition-colors uppercase tracking-wider"
                        >
                            <FileText size={13} /> Import existing lore
                        </button>
                        <button
                            onClick={handleExport}
                            className="flex items-center gap-1.5 text-xs text-terminal hover:text-terminal/80 transition-colors uppercase tracking-wider bg-terminal/10 border border-terminal/40 px-3 py-1.5"
                        >
                            <Download size={13} /> Export to Markdown
                        </button>
                    </div>
                ) : undefined}
            >
                {/* Draft selector + content. Auto height on purpose — this is a
                    long stacked document, so it should scroll in the shell's
                    scroller rather than be squeezed into the panel height. The
                    old `pb-20` that cleared the in-panel footer is gone: the
                    footer is now a real pinned slot on the shell. Capped at the
                    same 120rem design width the other converted screens use. */}
                <div className="w-full mx-auto max-w-[120rem]">
                    {/* Draft tabs */}
                    <div className="flex items-center gap-1 border-b border-border mb-6 overflow-x-auto pb-px">
                        {worldLoreDrafts.map((d) => (
                            <button
                                key={d.id}
                                onClick={() => setActiveDraft(d.id)}
                                className={`px-3 py-2 text-[11px] uppercase tracking-wider whitespace-nowrap transition-all border-b-2 -mb-px group ${
                                    activeDraft?.id === d.id
                                        ? 'text-terminal border-terminal bg-terminal/5 font-bold'
                                        : 'text-text-dim border-transparent hover:text-text-primary hover:border-border'
                                }`}
                            >
                                {d.name}
                                <span
                                    className="ml-1.5 text-[9px] opacity-0 group-hover:opacity-100 transition-opacity text-danger cursor-pointer"
                                    onClick={(e) => { e.stopPropagation(); setConfirmDelete(d.id); }}
                                >
                                    &#x2715;
                                </span>
                            </button>
                        ))}
                        <button
                            onClick={handleCreateDraft}
                            className="px-3 py-2 text-text-dim hover:text-terminal transition-colors -mb-px border-b-2 border-transparent"
                            title="New Draft"
                        >
                            <Plus size={14} />
                        </button>
                    </div>

                    {/* Delete confirmation */}
                    {confirmDelete && (
                        <div className="mb-4 p-3 border border-danger/40 bg-danger/5 rounded flex items-center justify-between">
                            <span className="text-sm text-text-primary">Delete this draft?</span>
                            <div className="flex gap-2">
                                <button className="text-xs px-2 py-1 border border-border text-text-dim hover:text-text-primary" onClick={() => setConfirmDelete(null)}>Cancel</button>
                                <button className="text-xs px-2 py-1 border border-danger/60 text-danger hover:bg-danger/10" onClick={() => handleDeleteDraft(confirmDelete)}>Delete</button>
                            </div>
                        </div>
                    )}

                    {!activeDraft ? (
                        <div className="text-center py-16 text-text-dim text-sm">
                            <p className="mb-4">No draft selected. Create one to get started.</p>
                            <button
                                onClick={handleCreateDraft}
                                className="px-4 py-2 bg-terminal/10 border border-terminal/40 text-terminal text-xs uppercase tracking-widest hover:bg-terminal/20 transition-colors"
                            >
                                Create Draft
                            </button>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {/* Draft name */}
                            <div>
                                <label className="block text-[10px] text-text-dim uppercase tracking-wider mb-1">Draft Name</label>
                                <input
                                    type="text"
                                    value={activeDraft.name}
                                    onChange={(e) => updateDraftField(activeDraft.id, 'name', e.target.value)}
                                    className="w-full bg-void border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-bold focus:border-terminal focus:outline-none"
                                    placeholder="My World"
                                />
                            </div>

                            {/* Flat sections */}
                            {FLAT_SECTIONS.map((sec) => {
                                const isOpen = expanded[sec.key] ?? false;
                                const value = activeDraft[sec.key] as string;
                                return (
                                    <div key={sec.key} className="border border-border rounded overflow-hidden bg-void-lighter">
                                        <button
                                            onClick={() => toggleSection(sec.key)}
                                            className="w-full flex items-center justify-between p-3 bg-void hover:bg-surface transition-colors"
                                        >
                                            <div className="flex items-center gap-2 text-sm font-bold text-text-primary uppercase tracking-wider">
                                                {isOpen ? <ChevronDown size={16} className="text-terminal" /> : <ChevronRight size={16} className="text-text-dim" />}
                                                {sec.label}
                                            </div>
                                            {value && !isOpen && <span className="text-[9px] text-text-dim italic truncate max-w-[200px] ml-2">{value.substring(0, 60)}...</span>}
                                        </button>
                                        {isOpen && (
                                            <div className="p-3 border-t border-border bg-void">
                                                <LoreTextarea
                                                    value={value}
                                                    onChange={(v) => updateDraftField(activeDraft.id, sec.key as keyof WorldLoreDraft, v)}
                                                    placeholder={sec.placeholder}
                                                    rows={6}
                                                    category={sec.label}
                                                    className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 focus:border-terminal focus:outline-none resize-y min-h-[120px]"
                                                />
                                            </div>
                                        )}
                                    </div>
                                );
                            })}

                            {/* List sections */}
                            {LIST_SECTIONS.map((sec) => {
                                const items = activeDraft[sec.key] as WorldLoreDraft[typeof sec.key];
                                const isOpen = expanded[sec.key] ?? false;
                                return (
                                    <div key={sec.key} className="border border-border rounded overflow-hidden bg-void-lighter">
                                        <button
                                            onClick={() => toggleSection(sec.key)}
                                            className="w-full flex items-center justify-between p-3 bg-void hover:bg-surface transition-colors"
                                        >
                                            <div className="flex items-center gap-2 text-sm font-bold text-text-primary uppercase tracking-wider">
                                                {isOpen ? <ChevronDown size={16} className="text-terminal" /> : <ChevronRight size={16} className="text-text-dim" />}
                                                {sec.label}
                                                {items.length > 0 && <span className="text-[10px] font-normal text-text-dim">({items.length})</span>}
                                            </div>
                                        </button>
                                        {isOpen && (
                                            <div className="p-3 border-t border-border bg-void">
                                                <AccordionList
                                                    items={items}
                                                    listKey={sec.key}
                                                    noun={sec.noun}
                                                    placeholder={sec.placeholder}
                                                    categoryLabel={sec.label}
                                                    onUpdateItem={(listKey, itemId, patch) => updateItem(activeDraft.id, listKey, itemId, patch)}
                                                    onRemoveItem={(listKey, itemId) => removeItem(activeDraft.id, listKey, itemId)}
                                                    onAddItem={(listKey) => addItem(activeDraft.id, listKey)}
                                                />
                                            </div>
                                        )}
                                    </div>
                                );
                            })}

                            {/* Divider + Character Creation Questions */}
                            <div className="border-t-2 border-dashed border-terminal/30 pt-4 mt-6">
                                <div className="flex items-center gap-2 mb-3">
                                    <span className="text-terminal text-[10px] uppercase tracking-widest font-bold">Template</span>
                                    <span className="text-text-dim text-[9px] italic">not lore — questions the AI will ask during character creation</span>
                                </div>
                                <div className="border border-border rounded overflow-hidden bg-void-lighter">
                                    <button
                                        onClick={() => toggleSection('characterCreationQuestions')}
                                        className="w-full flex items-center justify-between p-3 bg-void hover:bg-surface transition-colors"
                                    >
                                        <div className="flex items-center gap-2 text-sm font-bold text-text-primary uppercase tracking-wider">
                                            {expanded['characterCreationQuestions'] ? <ChevronDown size={16} className="text-terminal" /> : <ChevronRight size={16} className="text-text-dim" />}
                                            Character Creation Questions
                                        </div>
                                    </button>
                                    {expanded['characterCreationQuestions'] && (
                                        <div className="p-3 border-t border-border bg-void">
                                            <LoreTextarea
                                                value={activeDraft.characterCreationQuestions}
                                                onChange={(v) => updateDraftField(activeDraft.id, 'characterCreationQuestions', v)}
                                                placeholder="What questions should the AI ask when creating a character? e.g., What is your character's greatest fear? Which faction do they owe allegiance to?"
                                                rows={6}
                                                category="Character Creation Questions"
                                                className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 focus:border-terminal focus:outline-none resize-y min-h-[120px]"
                                            />
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </ScreenLightbox>

            {/* Import Modal — a sibling of the lightbox, not a child, so it
                layers above the screen rather than inside its scroll area. */}
            {importModalOpen && activeDraft && (
                <LoreImportReviewModal
                    draft={activeDraft}
                    onStartClassification={(text) => updateDraftField(activeDraft.id, 'rawSource', text)}
                    onMerge={handleImportMerge}
                    onClose={() => setImportModalOpen(false)}
                />
            )}
        </>
    );
}