/**
 * inventoryParser.ts
 * ------------------
 * Delta-patch parser for structured inventory.
 * Sends recent history + current inventory JSON to the LLM.
 * Expects back a JSON array of operations which are applied locally.
 */

import type { ChatMessage, ProviderConfig, EndpointConfig, InventoryItem } from '../types';
import { callLLM } from './callLLM';

export type InventoryOp =
    | { action: 'add'; name: string; qty: number; category?: string; keywords?: string[]; notes?: string }
    | { action: 'remove'; id: string }
    | { action: 'update'; id: string; changes: Partial<Pick<InventoryItem, 'name' | 'qty' | 'category' | 'keywords' | 'notes'>> }
    | { action: 'consume'; id: string; qty: number }
    | { action: 'equip'; id: string }
    | { action: 'unequip'; id: string };

function buildInventoryJson(items: InventoryItem[]): string {
    if (items.length === 0) return '(empty)';
    return items.map(i => `{"id":"${i.id}","name":"${i.name}","qty":${i.qty},"cat":"${i.category}","eq":${i.equipped}}`).join('\n');
}

export async function scanInventory(
    provider: ProviderConfig | EndpointConfig,
    messages: ChatMessage[],
    currentItems: InventoryItem[]
): Promise<InventoryItem[]> {
    const recentMessages = messages.slice(-15);
    if (recentMessages.length === 0) return currentItems;

    const turns = recentMessages
        .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
        .join('\n\n');

    const prompt = `You are an AI inventory manager for an RPG. Review the recent chat and inventory below.\nIdentify items gained, lost, consumed, equipped, or unequipped.\n\n=== CURRENT INVENTORY ===\n${buildInventoryJson(currentItems)}\n\n=== RECENT CHAT HISTORY ===\n${turns}\n\n=== INSTRUCTIONS ===\nReturn ONLY a valid JSON array of operations. No other text.\nEach operation is an object with an "action" field.\n\nActions:\n- add: {action:"add", name:"Torch", qty:3, category:"misc", keywords:["fire","light"]}\n- remove: {action:"remove", id:"ITEM_ID_HERE"}\n- update: {action:"update", id:"ITEM_ID_HERE", changes:{qty:2, name:"New Name"}}\n- consume: {action:"consume", id:"ITEM_ID_HERE", qty:1}\n- equip: {action:"equip", id:"ITEM_ID_HERE"}\n- unequip: {action:"unequip", id:"ITEM_ID_HERE"}\n\nIf nothing changed, return: []`;

    try {
        const result = await callLLM(provider, prompt, { priority: 'low' });
        let text = result;
        const md = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (md) text = md[1];
        const arrMatch = text.match(/\[[\s\S]*\]/);
        const arr = arrMatch ? JSON.parse(arrMatch[0]) : [];
        if (!Array.isArray(arr)) return currentItems;
        return applyOps(currentItems, arr);
    } catch (e) {
        console.error('[InventoryParser]', e);
        return currentItems;
    }
}

export function applyOps(items: InventoryItem[], ops: InventoryOp[]): InventoryItem[] {
    const next = items.map(it => ({ ...it }));
    const sceneId = String(Date.now());

    function findById(id: string) {
        const idx = next.findIndex(it => it.id === id);
        return idx !== -1 ? { idx, item: next[idx] } : undefined;
    }

    for (const op of ops) {
        if (op.action === 'add') {
            const existing = next.find(it => it.name.toLowerCase() === op.name.toLowerCase());
            if (existing) {
                existing.qty += op.qty || 1;
            } else {
                next.push({
                    id: `inv_${sceneId}_${Math.random().toString(36).slice(2, 7)}`,
                    name: op.name,
                    qty: op.qty || 1,
                    category: (op.category as any) || 'misc',
                    keywords: op.keywords || op.name.toLowerCase().split(/\s+/).filter(w => w.length > 2),
                    equipped: false,
                    lastUsedScene: sceneId,
                    importance: 5,
                    notes: op.notes || '',
                });
            }
        } else if (op.action === 'remove') {
            const idx = next.findIndex(it => it.id === op.id);
            if (idx !== -1) next.splice(idx, 1);
        } else if (op.action === 'update') {
            const f = findById(op.id);
            if (!f) continue;
            if (op.changes.name !== undefined) f.item.name = op.changes.name;
            if (op.changes.qty !== undefined) f.item.qty = Math.max(0, op.changes.qty);
            if (op.changes.category !== undefined) f.item.category = op.changes.category as any;
            if (op.changes.keywords !== undefined) f.item.keywords = op.changes.keywords;
            if (op.changes.notes !== undefined) f.item.notes = op.changes.notes;
        } else if (op.action === 'consume') {
            const f = findById(op.id);
            if (!f) continue;
            f.item.qty -= op.qty;
            f.item.lastUsedScene = sceneId;
            if (f.item.qty <= 0) {
                next.splice(f.idx, 1);
            }
        } else if (op.action === 'equip') {
            const f = findById(op.id);
            if (f) {
                f.item.equipped = true;
                f.item.lastUsedScene = sceneId;
            }
        } else if (op.action === 'unequip') {
            const f = findById(op.id);
            if (f) f.item.equipped = false;
        }
    }

    return next;
}