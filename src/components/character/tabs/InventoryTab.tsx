import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../../store/useAppStore';
import { scanInventory } from '../../../services/inventoryParser';
import { toast } from '../../Toast';
import type { EndpointConfig, ProviderConfig, InventoryItemCategory, InventoryItem } from '../../../types';
import { normalizeInventoryItem } from '../../../types';
import { isItemInSignatureKit } from '../../../utils/signatureKitMatch';
import { searchInventory } from '../../../utils/inventorySearch';
import { Trash2 } from '../../icons/narrativeIcons';

// Local copy of the ledger's tab union -- deliberately not imported from
// CharacterLedgerModal, which imports this file.
type LedgerTab = 'sheet' | 'record' | 'inventory' | 'stats';

const ALL_CATS: (InventoryItemCategory | 'all' | 'equipped')[] = ['all', 'equipped', 'weapon', 'armor', 'consumable', 'currency', 'key', 'misc'];
const DISPLAY_LABEL: Record<string, string> = {
    all: 'All',
    equipped: 'Equipped',
    weapon: 'Weapon',
    armor: 'Armor',
    consumable: 'Consumable',
    currency: 'Currency',
    key: 'Key',
    misc: 'Misc',
};

function SceneTag({ lastScene }: { lastScene: string }) {
    if (!lastScene || lastScene === 'Never') {
        return <span className="text-text-dim/40">Never updated</span>;
    }
    return <span className="text-terminal/70">Last updated: Scene #{lastScene}</span>;
}

function InventoryRow({
    it,
    onUpdate,
    onRemove,
    inKit,
    onOpenKit,
    selectMode,
    selected,
    onToggleSelected,
}: {
    it: InventoryItem;
    onUpdate: (id: string, patch: Partial<InventoryItem>) => void;
    onRemove: (id: string) => void;
    inKit?: boolean;
    onOpenKit?: () => void;
    selectMode?: boolean;
    selected?: boolean;
    onToggleSelected?: (id: string) => void;
}) {
    const [expanded, setExpanded] = useState(false);
    return (
        <div className={`border rounded transition-colors ${selected ? 'border-danger/60 bg-danger/5' : 'border-border/30 hover:border-border/60'}`}>
            <div className="flex items-center gap-2 px-2 py-1 text-[10px]">
                {/* The two checkboxes swap rather than sit side by side, so a
                    tick in select mode can never be mistaken for Equipped. */}
                {selectMode ? (
                    <input
                        type="checkbox"
                        checked={!!selected}
                        onChange={() => onToggleSelected?.(it.id)}
                        title="Select for deletion"
                        aria-label={`Select ${it.name}`}
                    />
                ) : (
                    <input
                        type="checkbox"
                        checked={it.equipped}
                        onChange={(e) => onUpdate(it.id, { equipped: e.target.checked, locationTag: e.target.checked ? 'inventory' : it.locationTag })}
                        title="Equipped"
                        aria-label={`Equipped ${it.name}`}
                    />
                )}
                <button
                    onClick={() => setExpanded(!expanded)}
                    className="text-text-dim/40 hover:text-text-primary w-3 text-center"
                >
                    {expanded ? '▼' : '▶'}
                </button>
                <input
                    className="flex-1 bg-transparent outline-none text-text-primary px-1 min-w-[0]"
                    value={it.name}
                    onChange={(e) => onUpdate(it.id, { name: e.target.value })}
                />
                {inKit && (
                    <button
                        onClick={onOpenKit}
                        className="text-[8px] px-1 rounded bg-amber-500/10 border border-amber-500/40 text-amber-400/90 shrink-0 hover:border-amber-400 transition-colors"
                        title="Also listed in the Signature Kit, so the GM is reminded of it every turn. Click to open the Sheet tab."
                    >
                        SIG
                    </button>
                )}
                <span className="text-[8px] px-1 rounded bg-void border border-border/40 text-text-dim/70 shrink-0 max-w-[80px] truncate" title={`Location: ${it.locationTag || 'inventory'}`}>
                    {it.locationTag || 'inventory'}
                </span>
                <input
                    className="w-8 bg-transparent outline-none text-text-primary text-center"
                    type="number"
                    value={it.qty}
                    min={1}
                    onChange={(e) => onUpdate(it.id, { qty: Math.max(1, Number(e.target.value)) })}
                />
                <select
                    className="bg-void border border-border/50 rounded text-[9px] outline-none focus:border-terminal"
                    value={it.category}
                    onChange={(e) => onUpdate(it.id, { category: e.target.value as InventoryItemCategory })}
                >
                    {(['weapon', 'armor', 'consumable', 'currency', 'key', 'misc'] as InventoryItemCategory[]).map((c) => (
                        <option key={c} value={c}>{c[0].toUpperCase()}{c.slice(1)}</option>
                    ))}
                </select>
                {!selectMode && (
                    <button
                        onClick={() => onRemove(it.id)}
                        className="text-danger/60 hover:text-danger p-1 shrink-0"
                        title="Delete item"
                        aria-label={`Delete ${it.name}`}
                    >
                        <Trash2 size={11} />
                    </button>
                )}
            </div>
            {expanded && (
                <div className="px-2 pb-2 space-y-1 border-t border-border/20 pt-1">
                    <div className="flex items-center gap-2">
                        <span className="text-[9px] text-text-dim/50 w-14">Location Tag</span>
                        <input
                            className="flex-1 bg-void border border-border/30 rounded text-[10px] px-1 outline-none focus:border-terminal"
                            placeholder="Tag location (e.g. inventory, player base, mom's house)"
                            value={it.locationTag || 'inventory'}
                            onChange={(e) => onUpdate(it.id, { locationTag: e.target.value })}
                        />
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="text-[9px] text-text-dim/50 w-14">Keywords</span>
                        <input
                            className="flex-1 bg-void border border-border/30 rounded text-[10px] px-1 outline-none focus:border-terminal"
                            value={it.keywords.join(', ')}
                            onChange={(e) => onUpdate(it.id, { keywords: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                        />
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="text-[9px] text-text-dim/50 w-14">Notes</span>
                        <input
                            className="flex-1 bg-void border border-border/30 rounded text-[10px] px-1 outline-none focus:border-terminal"
                            value={it.notes}
                            onChange={(e) => onUpdate(it.id, { notes: e.target.value })}
                        />
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="text-[9px] text-text-dim/50 w-14">Importance</span>
                        <input
                            className="w-12 bg-void border border-border/30 rounded text-[10px] px-1 outline-none focus:border-terminal"
                            type="number"
                            value={it.importance}
                            min={1}
                            max={10}
                            onChange={(e) => onUpdate(it.id, { importance: Math.max(1, Math.min(10, Number(e.target.value))) })}
                        />
                    </div>
                </div>
            )}
        </div>
    );
}

function isRawInventoryItem(v: unknown): v is InventoryItem {
    if (typeof v !== 'object' || v === null) return false;
    const item = v as Partial<InventoryItem>;
    return typeof item.id === 'string' && typeof item.name === 'string' && Array.isArray(item.keywords);
}

/**
 * The JSON has to pass through invalid states while it is being edited (deleting
 * one object leaves a stray comma), so the text lives in a local draft and only
 * valid JSON reaches the store. Bound straight to the store, every invalid
 * keystroke snapped back to the saved value.
 */
function RawInventoryEditor({ items, onCommit }: { items: InventoryItem[]; onCommit: (items: InventoryItem[]) => void }) {
    const serialized = JSON.stringify(items, null, 2);
    const [draft, setDraft] = useState(serialized);
    const [error, setError] = useState<string | null>(null);
    const lastSynced = useRef(serialized);

    // Pick up writes from elsewhere (e.g. Check Inventory), but not our own commits.
    useEffect(() => {
        if (serialized === lastSynced.current) return;
        lastSynced.current = serialized;
        setDraft(serialized);
        setError(null);
    }, [serialized]);

    const handleChange = (text: string) => {
        setDraft(text);
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            setError('Invalid JSON, not saved. Check for a stray comma. Use [] for an empty inventory.');
            return;
        }
        if (!Array.isArray(parsed) || !parsed.every(isRawInventoryItem)) {
            setError('Not saved. Must be a list of items, each with an id, name and keywords.');
            return;
        }
        const next = parsed.map(normalizeInventoryItem);
        lastSynced.current = JSON.stringify(next, null, 2);
        setError(null);
        onCommit(next);
    };

    return (
        <>
            <textarea
                className={`w-full bg-void border rounded text-text-primary text-[11px] px-2 py-1 outline-none font-mono ${error ? 'border-danger' : 'border-border focus:border-terminal'}`}
                rows={12}
                aria-label="Raw inventory JSON"
                value={draft}
                onChange={(e) => handleChange(e.target.value)}
            />
            {error && <p role="alert" className="text-[9px] text-danger mt-1">{error}</p>}
        </>
    );
}

/**
 * Character Ledger — Inventory tab.
 *
 * Owner: engine scans, user edits. The inventory grid (+ search, category
 * tabs, raw-edit, `Check Inventory` button), moved verbatim from the upper
 * half of the old ContextDrawer `book` tab (BookkeepingTab.tsx).
 */
export function InventoryTab({ onNavigateTab }: { onNavigateTab?: (tab: LedgerTab) => void } = {}) {
    const context = useAppStore((s) => s.context);
    // Same mirror-then-context read the inventory list uses below.
    const playerCharacter = useAppStore((s) => s.playerCharacter ?? s.context.playerCharacter);
    const kit = playerCharacter?.signatureKit ?? null;
    const updateContext = useAppStore((s) => s.updateContext);
    const messages = useAppStore((s) => s.messages);
    const archiveIndex = useAppStore((s) => s.archiveIndex);

    const inventoryItems = useAppStore((s) => s.inventoryItems ?? s.context.inventoryItems ?? []);
    const setInventoryItems = useAppStore((s) => s.setInventoryItems);
    const getActiveStoryEndpoint = useAppStore((s) => s.getActiveStoryEndpoint);

    const [activeTab, setActiveTab] = useState<InventoryItemCategory | 'all' | 'equipped'>('all');
    const [search, setSearch] = useState('');
    const [rawEdit, setRawEdit] = useState(false);
    const [isScanningInventory, setIsScanningInventory] = useState(false);
    const [selectMode, setSelectMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
    const [confirmingDelete, setConfirmingDelete] = useState(false);

    const getCurrentSceneId = (): string => {
        if (archiveIndex.length === 0) return '1';
        return archiveIndex[archiveIndex.length - 1].sceneId;
    };

    const handleCheckInventory = async () => {
        if (isScanningInventory) return;
        setIsScanningInventory(true);
        try {
            const provider = getActiveStoryEndpoint();
            if (!provider) return;
            const newItems = await scanInventory(provider as ProviderConfig | EndpointConfig, messages, inventoryItems);
            setInventoryItems(newItems);
            updateContext({ inventoryLastScene: getCurrentSceneId() });
        } catch (e) {
            console.error('Failed to scan inventory:', e);
            toast.error('Inventory scan failed');
        } finally {
            setIsScanningInventory(false);
        }
    };

    const updateItem = (id: string, patch: Partial<InventoryItem>) => {
        const target = inventoryItems.find((it) => it.id === id);
        if (!target) return;
        const merged = normalizeInventoryItem({ ...target, ...patch });
        setInventoryItems(inventoryItems.map((it) => it.id === id ? merged : it));
    };
    const addItem = (cat?: InventoryItemCategory) => {
        const newItem: InventoryItem = normalizeInventoryItem({
            id: `inv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name: 'New Item',
            qty: 1,
            category: cat || 'misc',
            keywords: [],
            equipped: false,
            lastUsedScene: '000',
            importance: 5,
            notes: '',
            locationTag: 'inventory',
        });
        setInventoryItems([...inventoryItems, newItem]);
    };
    const deleteItems = (ids: Set<string>) => {
        const removed = inventoryItems.filter((it) => ids.has(it.id));
        if (removed.length === 0) return;
        setInventoryItems(inventoryItems.filter((it) => !ids.has(it.id)));
        toast.info(removed.length === 1 ? `Deleted ${removed[0].name}` : `Deleted ${removed.length} items`, {
            label: 'Undo',
            onClick: () => {
                // Read fresh: the list may have changed while the toast was up.
                const current = useAppStore.getState().inventoryItems;
                const present = new Set(current.map((it) => it.id));
                setInventoryItems([...current, ...removed.filter((it) => !present.has(it.id))]);
            },
        });
    };
    const removeItem = (id: string) => deleteItems(new Set([id]));

    const exitSelectMode = () => {
        setSelectMode(false);
        setSelectedIds(new Set());
        setConfirmingDelete(false);
    };
    const changeSelection = (next: Set<string>) => {
        setSelectedIds(next);
        setConfirmingDelete(false);
    };
    const toggleSelected = (id: string) => {
        const next = new Set(selectedIds);
        if (!next.delete(id)) next.add(id);
        changeSelection(next);
    };

    // Rows the Signature Kit also names. Display only -- the two stores stay separate.
    const sigItemIds = useMemo(
        () => new Set(inventoryItems.filter((it) => isItemInSignatureKit(it, kit)).map((it) => it.id)),
        [inventoryItems, kit],
    );
    const kitCount = kit?.equipment?.length ?? 0;
    const sigCount = sigItemIds.size;

    const tabCounts = useMemo(() => {
        const counts: Record<string, number> = { all: inventoryItems.length };
        for (const it of inventoryItems) {
            counts[it.category] = (counts[it.category] || 0) + 1;
            if (it.equipped) counts.equipped = (counts.equipped || 0) + 1;
        }
        return counts;
    }, [inventoryItems]);

    const filteredItems = useMemo(() => {
        let list = inventoryItems;
        if (activeTab !== 'all') {
            if (activeTab === 'equipped') {
                list = list.filter((it) => it.equipped);
            } else {
                list = list.filter((it) => it.category === activeTab);
            }
        }
        // A search ranks best match first; with no query this is plain A-Z.
        return searchInventory(list, search);
    }, [inventoryItems, activeTab, search]);

    // Selection survives changing the filter so it can be built up across
    // categories, which means some of it may be off screen. Always say so.
    const selectedItems = inventoryItems.filter((it) => selectedIds.has(it.id));
    const shownIds = new Set(filteredItems.map((it) => it.id));
    const selectedShown = selectedItems.filter((it) => shownIds.has(it.id)).length;
    const selectedHidden = selectedItems.length - selectedShown;
    const allShownSelected = filteredItems.length > 0 && selectedShown === filteredItems.length;

    const toggleAllShown = () => {
        const next = new Set(selectedIds);
        for (const it of filteredItems) {
            if (allShownSelected) next.delete(it.id);
            else next.add(it.id);
        }
        changeSelection(next);
    };
    const handleBulkDelete = () => {
        if (!confirmingDelete) {
            setConfirmingDelete(true);
            return;
        }
        deleteItems(selectedIds);
        exitSelectMode();
    };

    return (
        <div className="px-4 py-4 space-y-4">
            <div className="flex items-center gap-2">
                <button
                    onClick={() => {
                        setRawEdit(!rawEdit);
                        exitSelectMode();
                    }}
                    className="px-3 py-1.5 text-[10px] uppercase tracking-wider rounded transition-colors border bg-void border-border text-text-dim hover:border-text-primary"
                >
                    {rawEdit ? 'Grid View' : 'Raw Edit'}
                </button>
            </div>

            <div>
                <div className="flex items-center justify-between mb-1">
                    <h3 className="text-[11px] uppercase tracking-wider text-ice flex items-center gap-2">
                        Player Inventory <span className="text-[9px] text-text-dim/40">({inventoryItems.length} items)</span>
                    </h3>
                    <button
                        onClick={() => addItem(activeTab !== 'all' && activeTab !== 'equipped' ? (activeTab as InventoryItemCategory) : undefined)}
                        className="text-[9px] uppercase tracking-wider text-terminal border border-dashed border-terminal/30 rounded px-2 py-0.5 hover:border-terminal transition-colors"
                    >
                        + Add
                    </button>
                </div>

                {/* What this list is, and what the other one is. These are two
                    different mechanisms, not two copies -- say so here rather
                    than letting them read as an out-of-sync duplicate. */}
                <p className="text-[9px] text-text-dim/50 leading-relaxed mb-2">
                    Everything the character is carrying. The GM is shown the rows that matter to the current scene.
                    Gear that should <em className="not-italic text-text-dim/70">never</em> be forgotten belongs in{' '}
                    <button
                        onClick={() => onNavigateTab?.('sheet')}
                        disabled={!onNavigateTab}
                        className="text-amber-400/80 hover:text-amber-400 underline decoration-dotted underline-offset-2 disabled:no-underline disabled:text-text-dim/50"
                    >
                        Sheet &rsaquo; Signature Kit
                    </button>
                    {kitCount > 0 && <span className="text-text-dim/40"> ({kitCount} there now, {sigCount} matched below)</span>}
                    . Adding an item here does not add it there.
                </p>

                {rawEdit ? (
                    <RawInventoryEditor items={inventoryItems} onCommit={setInventoryItems} />
                ) : (
                    <>
                        {/* Filter, search and select */}
                        <div className="flex flex-wrap items-center gap-2 mb-2">
                            <select
                                aria-label="Filter inventory"
                                className="bg-void border border-border/50 rounded text-[11px] text-text-primary px-2 py-1 outline-none focus:border-terminal"
                                value={activeTab}
                                onChange={(e) => setActiveTab(e.target.value as typeof activeTab)}
                            >
                                {ALL_CATS.map((cat) => (
                                    <option key={cat} value={cat}>
                                        {DISPLAY_LABEL[cat]} ({tabCounts[cat] || 0})
                                    </option>
                                ))}
                            </select>
                            <input
                                aria-label="Search items"
                                className="flex-1 min-w-[160px] bg-void border border-border/50 rounded text-[11px] px-2 py-1 outline-none focus:border-terminal text-text-primary"
                                placeholder='Search items... e.g. spire token, "silver pin", -key, cat:currency'
                                title={'Every word must match, in any order, and small typos are forgiven.\n"exact phrase"  -exclude  cat:currency  loc:base  is:equipped'}
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                            />
                            <button
                                onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
                                className="px-2 py-1 text-[10px] uppercase tracking-wider rounded border bg-void border-border/50 text-text-dim hover:border-text-primary transition-colors"
                            >
                                {selectMode ? 'Cancel' : 'Select'}
                            </button>
                        </div>

                        {selectMode && (
                            <div className="flex flex-wrap items-center gap-3 mb-2 px-2 py-1 border border-border/30 rounded text-[10px] text-text-dim">
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={allShownSelected}
                                        disabled={filteredItems.length === 0}
                                        ref={(el) => {
                                            if (el) el.indeterminate = selectedShown > 0 && !allShownSelected;
                                        }}
                                        onChange={toggleAllShown}
                                    />
                                    Select all shown ({filteredItems.length})
                                </label>
                                <span className="flex-1">
                                    {selectedItems.length} selected
                                    {selectedHidden > 0 && <span className="text-danger"> ({selectedHidden} not shown)</span>}
                                </span>
                                <button
                                    onClick={handleBulkDelete}
                                    disabled={selectedItems.length === 0}
                                    className="flex items-center gap-1 px-2 py-0.5 uppercase tracking-wider rounded border border-danger/50 text-danger hover:border-danger disabled:opacity-40 transition-colors"
                                >
                                    <Trash2 size={11} />
                                    {confirmingDelete ? `Confirm delete ${selectedItems.length}?` : 'Delete selected'}
                                </button>
                            </div>
                        )}

                        {/* List */}
                        <div className="space-y-1 max-h-[300px] overflow-y-auto pr-1 custom-scrollbar">
                            {filteredItems.map((it) => (
                                <InventoryRow
                                    key={it.id}
                                    it={it}
                                    onUpdate={updateItem}
                                    onRemove={removeItem}
                                    inKit={sigItemIds.has(it.id)}
                                    onOpenKit={() => onNavigateTab?.('sheet')}
                                    selectMode={selectMode}
                                    selected={selectedIds.has(it.id)}
                                    onToggleSelected={toggleSelected}
                                />
                            ))}
                            {filteredItems.length === 0 && (
                                <div className="text-[10px] text-text-dim/40 text-center py-4">No items match.</div>
                            )}
                        </div>
                    </>
                )}

                <div className="mt-2 flex items-center justify-between">
                    <span className="text-[9px]"><SceneTag lastScene={context.inventoryLastScene} /></span>
                    <button
                        onClick={handleCheckInventory}
                        disabled={isScanningInventory}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-void border border-border hover:border-terminal text-text-primary text-[10px] uppercase tracking-wider rounded transition-colors disabled:opacity-50"
                    >
                        {isScanningInventory ? 'Scanning...' : 'Check Inventory'}
                    </button>
                </div>
            </div>
        </div>
    );
}