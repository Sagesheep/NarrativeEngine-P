import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { loadLootTree } from '../lootTreeLoader';

describe('Loot Tree Loader (loadLootTree)', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        // Silence console.warn in tests so negative tests don't spam console output
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    it('should successfully load a valid LootTree', () => {
        const validTree = {
            root: 'rootPick',
            nodes: {
                rootPick: {
                    kind: 'pick',
                    axis: 'category',
                    weights: { a: 50, b: 50 },
                    branches: { a: 'nodeA', b: 'nodeB' }
                },
                nodeA: {
                    kind: 'compose',
                    template: 'Item A'
                },
                nodeB: {
                    kind: 'compose',
                    template: 'Item B'
                }
            },
            pools: {}
        };

        const result = loadLootTree(validTree);
        expect(result).not.toBeNull();
        expect(result?.root).toBe('rootPick');
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should return null when there is a dangling branch target ID', () => {
        const badTree = {
            root: 'rootPick',
            nodes: {
                rootPick: {
                    kind: 'pick',
                    axis: 'category',
                    weights: { a: 50, b: 50 },
                    branches: { a: 'nodeA', b: 'danglingNode' } // danglingNode does not exist
                },
                nodeA: {
                    kind: 'compose',
                    template: 'Item A'
                }
            },
            pools: {}
        };

        const result = loadLootTree(badTree);
        expect(result).toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dangling target "danglingNode"'));
    });

    it('should return null when a draw pool is missing from pools', () => {
        const badTree = {
            root: 'rootPick',
            nodes: {
                rootPick: {
                    kind: 'pick',
                    axis: 'category',
                    weights: { a: 100 },
                    branches: { a: 'drawNode' }
                },
                drawNode: {
                    kind: 'draw',
                    draws: [
                        {
                            pool: 'missingPool', // pool does not exist in pools
                            as: 'item'
                        }
                    ]
                }
            },
            pools: {
                existingPool: [{ text: 'Item' }]
            }
        };

        const result = loadLootTree(badTree);
        expect(result).toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('draw.pool "missingPool" not in pools'));
    });

    it('should return null when weights contain non-number values', () => {
        const badTree = {
            root: 'rootPick',
            nodes: {
                rootPick: {
                    kind: 'pick',
                    axis: 'category',
                    weights: { a: 'fifty' as unknown as number, b: 50 }, // weight is not a number
                    branches: { a: 'nodeA', b: 'nodeB' }
                },
                nodeA: {
                    kind: 'compose',
                    template: 'Item A'
                },
                nodeB: {
                    kind: 'compose',
                    template: 'Item B'
                }
            },
            pools: {}
        };

        const result = loadLootTree(badTree);
        expect(result).toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('has invalid shape'));
    });

    it('should load and validate the real Class Scroll World loot.json database', () => {
        const jsonPath = path.resolve(__dirname, '../../../../Example_Setup/World_compendium/Class Scroll World/loot.json');
        const rawJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

        const result = loadLootTree(rawJson);
        expect(result).not.toBeNull();
        expect(result?.root).toBe('categoryPick');
        expect(result?.nodes['categoryPick']?.kind).toBe('pick');
        expect(warnSpy).not.toHaveBeenCalled();
    });
});
