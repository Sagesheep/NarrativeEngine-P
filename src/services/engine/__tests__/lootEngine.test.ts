import { describe, it, expect } from 'vitest';
import { resolveLootDrop } from '../lootEngine';
import type { LootTree } from '../../../types';

// ── Seeded RNG (mulberry32) — deterministic across runs.
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('Loot Engine Walker (resolveLootDrop)', () => {
    // A simple, well-defined LootTree for testing walker behaviors
    const testTree: LootTree = {
        root: 'categoryPick',
        nodes: {
            categoryPick: {
                kind: 'pick',
                axis: 'category',
                weights: {
                    scroll: 80,
                    ingots: 20
                },
                branches: {
                    scroll: 'scrollRecipe',
                    ingots: 'currencyRecipe'
                }
            },
            scrollRecipe: {
                kind: 'pick',
                axis: 'rarityClass',
                weights: {
                    plain: 70,
                    aspect: 25,
                    unique: 5
                },
                branches: {
                    plain: 'scrollPlainDomainPick',
                    aspect: 'scrollAspectDomainPick',
                    unique: 'scrollUniqueDomainPick'
                }
            },
            scrollPlainDomainPick: {
                kind: 'pick',
                axis: 'domain',
                weights: {
                    combat: 50,
                    nonCombat: 50
                },
                branches: {
                    combat: 'scrollPlainDraw',
                    nonCombat: 'scrollPlainDraw'
                }
            },
            scrollPlainDraw: {
                kind: 'draw',
                draws: [
                    {
                        pool: 'jobList',
                        as: 'job',
                        filterBy: 'domain'
                    }
                ],
                next: 'scrollPlainCompose'
            },
            scrollPlainCompose: {
                kind: 'compose',
                template: '{job}'
            },
            scrollAspectDomainPick: {
                kind: 'pick',
                axis: 'domain',
                weights: {
                    combat: 50,
                    nonCombat: 50
                },
                branches: {
                    combat: 'scrollAspectDraw',
                    nonCombat: 'scrollAspectDraw'
                }
            },
            scrollAspectDraw: {
                kind: 'draw',
                draws: [
                    {
                        pool: 'jobList',
                        as: 'job',
                        filterBy: 'domain'
                    },
                    {
                        pool: 'aspectPool',
                        as: 'aspect'
                    }
                ],
                next: 'scrollAspectCompose'
            },
            scrollAspectCompose: {
                kind: 'compose',
                template: '{job} of the {aspect}'
            },
            scrollUniqueDomainPick: {
                kind: 'pick',
                axis: 'domain',
                weights: {
                    combat: 50,
                    nonCombat: 50
                },
                branches: {
                    combat: 'scrollUniqueDraw',
                    nonCombat: 'scrollUniqueDraw'
                }
            },
            scrollUniqueDraw: {
                kind: 'draw',
                draws: [
                    {
                        pool: 'uniqueList',
                        as: 'job',
                        filterBy: 'domain'
                    }
                ],
                next: 'scrollUniqueCompose'
            },
            scrollUniqueCompose: {
                kind: 'compose',
                template: '{job}'
            },
            currencyRecipe: {
                kind: 'amount',
                unit: 'ingots',
                min: 5,
                max: 15,
                next: 'currencyCompose'
            },
            currencyCompose: {
                kind: 'compose',
                template: '{ingots} ingots'
            }
        },
        pools: {
            jobList: {
                combat: [
                    { text: 'Swordsman' },
                    { text: 'Spearman' }
                ],
                nonCombat: [
                    { text: 'Cook' },
                    { text: 'Healer' }
                ]
            },
            aspectPool: [
                { text: 'Void' },
                { text: 'Wind' }
            ],
            uniqueList: {
                combat: [
                    { text: 'Sword Saint' }
                ],
                nonCombat: [
                    { text: 'Grand Alchemist' }
                ]
            }
        }
    };

    it('should be deterministic given the same seed', () => {
        const seed = 42;
        const res1 = resolveLootDrop(testTree, { rng: mulberry32(seed) });
        const res2 = resolveLootDrop(testTree, { rng: mulberry32(seed) });

        expect(res1.items).toHaveLength(1);
        expect(res2.items).toHaveLength(1);
        expect(res1.items[0].label).toBe(res2.items[0].label);
        expect(res1.appendToInput).toBe(res2.appendToInput);
    });

    it('should pick options proportionally under weight normalization', () => {
        // Over N=1000 seeded draws, an 80/20 split on root should land roughly in the loose band [700, 900] for scroll
        const counts = { scroll: 0, ingots: 0 };
        const rng = mulberry32(101);

        for (let i = 0; i < 1000; i++) {
            const res = resolveLootDrop(testTree, { rng });
            const item = res.items[0];
            if (item.label.includes('ingots')) {
                counts.ingots++;
            } else {
                counts.scroll++;
            }
        }

        expect(counts.scroll).toBeGreaterThan(700);
        expect(counts.scroll).toBeLessThan(900);
        expect(counts.ingots).toBeGreaterThan(100);
        expect(counts.ingots).toBeLessThan(300);
    });

    it('should short-circuit unique branch to not include aspects', () => {
        // Force unique branch via reweight override
        const profile = {
            reweight: {
                categoryPick: { scroll: 100, ingots: 0 },
                scrollRecipe: { plain: 0, aspect: 0, unique: 100 }
            }
        };

        const rng = mulberry32(12345);
        const res = resolveLootDrop(testTree, { profile, rng, rolls: 20 });

        for (const item of res.items) {
            expect(item.label).not.toContain(' of the ');
            expect(item.parts.aspect).toBeUndefined();
            expect(['Sword Saint', 'Grand Alchemist']).toContain(item.label);
        }
    });

    it('should scope drawing by filterBy domain axis', () => {
        // Force scroll -> plain -> combat domain
        const profile = {
            reweight: {
                categoryPick: { scroll: 100, ingots: 0 },
                scrollRecipe: { plain: 100, aspect: 0, unique: 0 },
                scrollPlainDomainPick: { combat: 100, nonCombat: 0 }
            }
        };

        const rng = mulberry32(99);
        const res = resolveLootDrop(testTree, { profile, rng, rolls: 20 });

        for (const item of res.items) {
            expect(item.parts.domain).toBe('combat');
            expect(['Swordsman', 'Spearman']).toContain(item.label);
        }
    });

    it('should exclude reweighted options set to 0', () => {
        // Force scroll category to 0
        const profile = {
            reweight: {
                categoryPick: { scroll: 0, ingots: 100 }
            }
        };

        const rng = mulberry32(777);
        const res = resolveLootDrop(testTree, { profile, rng, rolls: 50 });

        for (const item of res.items) {
            expect(item.label).toContain('ingots');
        }
    });

    it('should terminate walk via cycle guard when hitting infinite loop', () => {
        // Build a cyclic tree
        const cyclicTree: LootTree = {
            root: 'loopNode',
            nodes: {
                loopNode: {
                    kind: 'pick',
                    axis: 'dummy',
                    weights: {
                        next: 100
                    },
                    branches: {
                        next: 'loopNode' // Cycles back to itself
                    }
                }
            },
            pools: {}
        };

        const rng = mulberry32(123);
        // Should not throw or infinite loop, should terminate within 32 steps
        const res = resolveLootDrop(cyclicTree, { rng });
        expect(res.trace[res.trace.length - 1]).toContain('MAX_STEPS=32 hit');
        expect(res.items).toHaveLength(1);
    });

    it('should roll amounts within min and max and format label correctly', () => {
        const profile = {
            reweight: {
                categoryPick: { scroll: 0, ingots: 100 }
            }
        };

        const rng = mulberry32(888);
        const res = resolveLootDrop(testTree, { profile, rng, rolls: 50 });

        for (const item of res.items) {
            expect(item.parts.ingots).toBeDefined();
            const val = parseInt(item.parts.ingots, 10);
            expect(val).toBeGreaterThanOrEqual(5);
            expect(val).toBeLessThanOrEqual(15);
            expect(item.label).toBe(`${val} ingots`);
        }
    });

    it('should roll multiple items when rolls > 1', () => {
        const rng = mulberry32(111);
        const res = resolveLootDrop(testTree, { rng, rolls: 3 });

        expect(res.items).toHaveLength(3);
        // Verify trace mentions item 1, 2, and 3
        expect(res.trace.some(t => t.includes('item 1'))).toBe(true);
        expect(res.trace.some(t => t.includes('item 2'))).toBe(true);
        expect(res.trace.some(t => t.includes('item 3'))).toBe(true);

        // Verify appendToInput lists all three items
        const expectedPrefix = '\n[LOOT DROP: ';
        expect(res.appendToInput.startsWith(expectedPrefix)).toBe(true);
        const listText = res.appendToInput.slice(expectedPrefix.length, -1);
        const parts = listText.split(', ');
        expect(parts).toHaveLength(3);
    });

    it('should output bare loot drop tag format with no narration or power level', () => {
        const rng = mulberry32(999);
        const res = resolveLootDrop(testTree, { rng });

        expect(res.appendToInput).toMatch(/^\n\[LOOT DROP: [^\]]+\]$/);
        expect(res.appendToInput).not.toContain('You found');
        expect(res.appendToInput).not.toContain('power');
    });

    // ── Modal reweight regression (WO-05 bug: empty-default shipped all-zero reweight) ──
    // The pre-roll modal arms `reweight` ONLY for options the user explicitly
    // unchecked. A reweight that zeroes every root option must yield 0 items
    // (the walker's "no eligible options — stop" path) — this locks that path
    // so a future modal regression that re-zeroes everything is loud, not silent.
    it('should yield 0 items when the root pick is reweighted to all-zero', () => {
        const profile = { reweight: { categoryPick: { scroll: 0, ingots: 0, 'magic-item': 0 } } };
        const rng = mulberry32(42);
        const res = resolveLootDrop(testTree, { profile, rng, rolls: 5 });

        expect(res.items).toHaveLength(0);
        expect(res.appendToInput).toBe('');
        // Every roll hit the no-eligible-options stop.
        expect(res.trace.filter(t => t.includes('no eligible options')).length).toBe(5);
    });

    // And the inverse: NO reweight (the all-checked default) must produce one
    // item per roll, each independently re-rolling the category pick first.
    it('should produce one item per roll and re-roll the root category each time when no reweight is applied', () => {
        const rng = mulberry32(7);
        const res = resolveLootDrop(testTree, { rng, rolls: 4 });

        expect(res.items).toHaveLength(4);
        expect(res.appendToInput).toMatch(/^\n\[LOOT DROP: .+\]$/);
        // Each of the 4 rolls logs a categoryPick decision.
        expect(res.trace.filter(t => t.startsWith('categoryPick/pick[category]→')).length).toBe(4);
    });
});
