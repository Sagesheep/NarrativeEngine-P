import { Package, Check, X } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { toast } from '../Toast';
import { uid } from '../../utils/uid';
import type { InventoryProposal, InventoryItem, InventoryItemCategory } from '../../types';

import { normalizeLocationTag } from '../../types';

/**
 * Phase 6: GM-proposed inventory change awaiting user confirmation.
 * Renders the amber staging banner above the composer; Apply commits the
 * proposal as a real delta on the inventory ledger, Dismiss drops it.
 */
export function InventoryStagingBar({
    proposal,
    onDone,
}: {
    proposal: InventoryProposal;
    onDone: () => void;
}) {
    const archiveIndex = useAppStore(s => s.archiveIndex);

    const applyInventoryProposal = (p: InventoryProposal) => {
        const store = useAppStore.getState();
        const items = store.inventoryItems ?? [];
        const lastScene = archiveIndex.length > 0 ? archiveIndex[archiveIndex.length - 1].sceneId : '000';

        const findTarget = (locTag?: string) => {
            const locNorm = locTag ? normalizeLocationTag(locTag) : undefined;
            if (locNorm) {
                const matchLoc = items.find(it => it.name.toLowerCase() === p.name.toLowerCase() && normalizeLocationTag(it.locationTag) === locNorm);
                if (matchLoc) return matchLoc;
            }
            return items.find(it => it.name.toLowerCase() === p.name.toLowerCase());
        };

        if (p.op === 'relocate') {
            const target = findTarget(p.fromLocationTag);
            const destLoc = normalizeLocationTag(p.locationTag);
            if (target) {
                store.updateInventoryItem(target.id, { locationTag: destLoc });
                toast.success(`Relocated ${p.name} to ${destLoc}`);
            } else {
                toast.warning(`"${p.name}" not found to relocate`);
            }
        } else if (p.op === 'remove') {
            const target = findTarget(p.fromLocationTag || p.locationTag);
            if (target) { store.removeInventoryItem(target.id); toast.info(`Removed ${p.name}`); }
            else toast.warning(`"${p.name}" not found in inventory`);
        } else if (p.op === 'equip') {
            const target = findTarget(p.fromLocationTag || p.locationTag);
            if (target) { store.updateInventoryItem(target.id, { equipped: true, locationTag: 'inventory' }); toast.success(`Equipped ${p.name}`); }
            else toast.warning(`"${p.name}" not found to equip`);
        } else {
            const category: InventoryItemCategory = p.kind === 'weapon' ? 'weapon'
                : p.kind === 'armor' ? 'armor'
                : p.kind === 'consumable' ? 'consumable'
                : 'misc';
            const newItem: InventoryItem = {
                id: uid(),
                name: p.name,
                qty: 1,
                category,
                keywords: p.name.toLowerCase().split(/\s+/).filter(w => w.length > 2),
                equipped: p.equip,
                lastUsedScene: lastScene,
                importance: 5,
                notes: [p.description, p.properties.length ? `(${p.properties.join(', ')})` : ''].filter(Boolean).join(' '),
                locationTag: normalizeLocationTag(p.locationTag),
            };
            store.addInventoryItem(newItem);
            toast.success(`Added ${p.name}`);
        }
        onDone();
    };

    return (
        <div className="bg-amber-500/10 border-b border-amber-500/40 px-4 py-2 flex items-center justify-between gap-3">
            <span className="text-amber-400 text-[11px] font-mono flex items-center gap-2 min-w-0">
                <Package size={13} className="shrink-0" />
                <span className="truncate">
                    GM proposes:{' '}
                    <span className="font-bold uppercase">{proposal.op}</span>{' '}
                    <span className="text-text-primary">{proposal.name}</span>
                    {proposal.op === 'relocate' && (
                        <span className="text-text-dim"> ({proposal.fromLocationTag || 'inventory'} → {proposal.locationTag || 'inventory'})</span>
                    )}
                    {proposal.op === 'grant' && (
                        <span className="text-text-dim"> ({proposal.quality} {proposal.kind}, tag: {proposal.locationTag || 'inventory'})</span>
                    )}
                </span>
            </span>
            <div className="flex items-center gap-1.5 shrink-0">
                <button
                    onClick={() => applyInventoryProposal(proposal)}
                    className="flex items-center gap-1 bg-green-900/30 border border-green-600 text-green-400 hover:bg-green-900/50 text-[10px] uppercase tracking-wider px-2 py-1 rounded-sm transition-colors"
                >
                    <Check size={12} /> Apply
                </button>
                <button
                    onClick={onDone}
                    className="flex items-center gap-1 text-text-dim hover:text-text-primary border border-border hover:border-text-dim text-[10px] uppercase tracking-wider px-2 py-1 rounded-sm transition-colors"
                >
                    <X size={12} /> Dismiss
                </button>
            </div>
        </div>
    );
}
