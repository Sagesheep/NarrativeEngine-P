import { describe, it, expect } from 'vitest';
import { normalizeLocationTag, normalizeInventoryItem, migrateLegacyContext } from '../../types';
import type { InventoryItem } from '../../types';
import { applyOps } from '../inventoryParser';
import { handleProposeInventoryTool } from '../turn/toolHandlers';
import { buildInventoryIndex, minifySelectedInventory } from '../turn/contextMinifier';
import { buildOocContext } from '../ooc/context';
import { parseStartingInventory } from '../character/commitCharacterDraft';

describe('Inventory Location Tag Subsystem', () => {
    describe('normalizeLocationTag & normalizeInventoryItem', () => {
        it('defaults undefined, null, or non-string values to "inventory"', () => {
            expect(normalizeLocationTag(undefined)).toBe('inventory');
            expect(normalizeLocationTag(null)).toBe('inventory');
            expect(normalizeLocationTag(123)).toBe('inventory');
            expect(normalizeLocationTag('')).toBe('inventory');
            expect(normalizeLocationTag('   ')).toBe('inventory');
        });

        it('trims whitespace, sanitizes control characters and brackets, and caps length at 60', () => {
            expect(normalizeLocationTag('   player base   ')).toBe('player base');
            expect(normalizeLocationTag('mom\'s house,\nin toilet')).toBe('mom\'s house, in toilet');
            expect(normalizeLocationTag('secret [base] location')).toBe('secret base location');
            const longTag = 'a'.repeat(80);
            expect(normalizeLocationTag(longTag)).toBe('a'.repeat(60));
        });

        it('enforces the equipment invariant (equipped items must be at locationTag "inventory")', () => {
            const equippedAtBase: InventoryItem = {
                id: 'inv_1',
                name: 'Greatsword',
                qty: 1,
                category: 'weapon',
                keywords: ['sword'],
                equipped: true,
                lastUsedScene: '001',
                importance: 5,
                notes: '',
                locationTag: 'player base',
            };
            const normalized = normalizeInventoryItem(equippedAtBase);
            expect(normalized.locationTag).toBe('player base');
            expect(normalized.equipped).toBe(false);

            const equippedInInventory: InventoryItem = {
                ...equippedAtBase,
                locationTag: 'inventory',
            };
            expect(normalizeInventoryItem(equippedInInventory).equipped).toBe(true);
        });
    });

    describe('Legacy Hydration Migration', () => {
        it('normalizes legacy inventory items without locationTag on campaign hydration', () => {
            const rawContext = {
                inventoryItems: [
                    {
                        id: 'inv_old_1',
                        name: 'Handphone',
                        qty: 1,
                        category: 'misc' as const,
                        keywords: ['phone'],
                        equipped: false,
                        lastUsedScene: '001',
                        importance: 5,
                        notes: '',
                    },
                    {
                        id: 'inv_old_2',
                        name: 'Sword of Kusanagi',
                        qty: 1,
                        category: 'weapon' as const,
                        keywords: ['sword'],
                        equipped: true,
                        lastUsedScene: '001',
                        importance: 8,
                        notes: '',
                        locationTag: 'player base', // should clear equipped
                    },
                ],
            };
            const migrated = migrateLegacyContext(rawContext);
            expect(migrated.inventoryItems[0].locationTag).toBe('inventory');
            expect(migrated.inventoryItems[1].locationTag).toBe('player base');
            expect(migrated.inventoryItems[1].equipped).toBe(false);
        });
    });

    describe('Stack Identity & Relocation in applyOps', () => {
        it('keeps same-named items in different locations as distinct stacks', () => {
            const items: InventoryItem[] = [
                {
                    id: 'inv_1',
                    name: 'Health Potion',
                    qty: 2,
                    category: 'consumable',
                    keywords: ['potion'],
                    equipped: false,
                    lastUsedScene: '001',
                    importance: 5,
                    notes: '',
                    locationTag: 'inventory',
                },
            ];

            const result = applyOps(items, [
                { action: 'add', name: 'Health Potion', qty: 1, locationTag: 'player base' },
            ]);

            expect(result).toHaveLength(2);
            expect(result[0].qty).toBe(2);
            expect(result[0].locationTag).toBe('inventory');
            expect(result[1].name).toBe('Health Potion');
            expect(result[1].qty).toBe(1);
            expect(result[1].locationTag).toBe('player base');
        });

        it('merges quantities when adding an item with matching name and locationTag', () => {
            const items: InventoryItem[] = [
                {
                    id: 'inv_1',
                    name: 'Health Potion',
                    qty: 2,
                    category: 'consumable',
                    keywords: ['potion'],
                    equipped: false,
                    lastUsedScene: '001',
                    importance: 5,
                    notes: '',
                    locationTag: 'player base',
                },
            ];

            const result = applyOps(items, [
                { action: 'add', name: 'Health Potion', qty: 3, locationTag: 'player base' },
            ]);

            expect(result).toHaveLength(1);
            expect(result[0].qty).toBe(5);
            expect(result[0].locationTag).toBe('player base');
        });

        it('relocates an item to a new destination locationTag by ID', () => {
            const items: InventoryItem[] = [
                {
                    id: 'inv_sword',
                    name: 'Sword of Kusanagi',
                    qty: 1,
                    category: 'weapon',
                    keywords: ['sword'],
                    equipped: true,
                    lastUsedScene: '001',
                    importance: 8,
                    notes: '',
                    locationTag: 'inventory',
                },
            ];

            const result = applyOps(items, [
                { action: 'relocate', id: 'inv_sword', locationTag: 'player base' },
            ]);

            expect(result[0].locationTag).toBe('player base');
            expect(result[0].equipped).toBe(false); // Equipment invariant
        });
    });

    describe('GM Tool & Proposal (propose_inventory_change)', () => {
        it('parses relocate operation with fromLocationTag and locationTag', () => {
            const args = JSON.stringify({
                name: 'Sword of Kusanagi',
                op: 'relocate',
                fromLocationTag: 'inventory',
                locationTag: 'player base',
            });
            const { proposal } = handleProposeInventoryTool(args);
            expect(proposal.name).toBe('Sword of Kusanagi');
            expect(proposal.op).toBe('relocate');
            expect(proposal.fromLocationTag).toBe('inventory');
            expect(proposal.locationTag).toBe('player base');
        });
    });

    describe('Context Minification & OOC Support', () => {
        it('surfaces non-default location tags in minified story inventory blocks', () => {
            const items: InventoryItem[] = [
                {
                    id: '1',
                    name: 'Handphone',
                    qty: 1,
                    category: 'misc',
                    keywords: [],
                    equipped: false,
                    lastUsedScene: '1',
                    importance: 5,
                    notes: '',
                    locationTag: 'inventory',
                },
                {
                    id: '2',
                    name: 'Sword of Kusanagi',
                    qty: 1,
                    category: 'weapon',
                    keywords: [],
                    equipped: false,
                    lastUsedScene: '1',
                    importance: 5,
                    notes: '',
                    locationTag: 'player base',
                },
            ];

            const minifiedIndex = buildInventoryIndex(items);
            expect(minifiedIndex).toContain('Sword of Kusanagi [at: player base]');

            const minifiedSelected = minifySelectedInventory(items, ['weapon', 'misc']);
            expect(minifiedSelected).toContain('Sword of Kusanagi[at:player base]');
        });

        it('surfaces non-default location tags in buildOocContext output', () => {
            const snapshot = {
                context: {
                    inventoryItems: [
                        {
                            id: 'inv_1',
                            name: 'Sandal of Sandalphon',
                            qty: 1,
                            category: 'misc' as const,
                            keywords: [],
                            equipped: false,
                            lastUsedScene: '1',
                            importance: 5,
                            notes: '',
                            locationTag: 'mom\'s house, in toilet',
                        },
                    ],
                },
                messages: [],
                semanticFacts: [],
            } as any;

            const { text } = buildOocContext(snapshot, 'where is the sandal?');
            expect(text).toContain('Sandal of Sandalphon x1 [misc, at: mom\'s house, in toilet]');
        });
    });

    describe('PC Starting Inventory', () => {
        it('assigns locationTag "inventory" to PC starting possessions', () => {
            const items = parseStartingInventory('Dagger, Leather Armor, Health Potion');
            expect(items).toHaveLength(3);
            for (const item of items) {
                expect(item.locationTag).toBe('inventory');
            }
        });
    });
});
