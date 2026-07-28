import { Backpack, Check, LockKeyhole } from 'lucide-react';
import type { AbilityEntry, InventoryItem } from '../types';

export function InventoryGrantedAbilities({
    abilities,
    inventoryItems,
}: {
    abilities: AbilityEntry[];
    inventoryItems: InventoryItem[];
}) {
    const grants = abilities
        .filter(ability => ability.origin === 'item-granted')
        .map(ability => {
            const item = inventoryItems.find(candidate => candidate.id === ability.sourceInventoryItemId);
            const present = Boolean(item && item.qty > 0 && (item.locationTag ?? 'inventory') === 'inventory');
            const active = present && (!ability.inventoryRequiresEquipped || item?.equipped === true);
            return { ability, item, active, present };
        })
        .sort((a, b) => a.ability.name.localeCompare(b.ability.name));

    if (!grants.length) return null;
    return <div className="border-b border-border bg-sky-400/5">
        <div className="px-3 pt-3 pb-1 flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-sky-300">
            <Backpack size={11} />Inventory Powers ({grants.filter(grant => grant.active).length}/{grants.length})
        </div>
        <div className="px-2 pb-2 space-y-1 max-h-40 overflow-y-auto">
            {grants.map(({ ability, item, active, present }) => <div key={ability.id} className={`rounded border px-2 py-1.5 ${active ? 'border-sky-400/30 bg-sky-400/5' : 'border-border/50 opacity-60'}`}>
                <div className="flex items-center gap-1.5">
                    {active ? <Check size={11} className="text-terminal" /> : <LockKeyhole size={11} className="text-text-dim" />}
                    <span className="text-xs font-semibold">{ability.name}</span>
                </div>
                <div className="text-[9px] text-text-dim mt-0.5">
                    {item?.name ?? 'Unlinked or missing item'}
                    {!active && present && ability.inventoryRequiresEquipped ? ' · Equip to activate' : ''}
                    {!present && item ? ' · Not carried' : ''}
                </div>
            </div>)}
        </div>
    </div>;
}
