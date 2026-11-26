import type {
    LootTree,
    LootNode,
    LootNodeId,
    LootPickNode,
    LootDrawNode,
    LootAmountNode,
    LootComposeNode,
    LootPool,
    LootPoolEntry,
} from '../../types';

/**
 * Loot Tree Loader — WO-03 (03_GLM_loot_json_loader.md).
 *
 * Validates a parsed `loot.json` object into a `LootTree`, or returns null on
 * ANY structural problem. Never throws — a campaign simply has no loot table
 * when the input is bad, so the manual trigger no-ops (WO-05).
 *
 * Validation is shallow-but-real: catches the mistakes a hand-author makes
 * (dangling branch id, missing pool, weights not numbers) without pulling in a
 * schema library.
 */

const TAG = '[LootLoader]';

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStr(v: unknown): v is string {
    return typeof v === 'string';
}

function isNum(v: unknown): v is number {
    return typeof v === 'number' && !Number.isNaN(v) && Number.isFinite(v);
}

function isLootPoolEntry(v: unknown): v is LootPoolEntry {
    if (!isObj(v)) return false;
    if (!isStr(v.text)) return false;
    if (v.tier !== undefined && !isNum(v.tier)) return false;
    if (v.budget !== undefined && !isStr(v.budget)) return false;
    return true;
}

function isPool(v: unknown): v is LootPool {
    if (Array.isArray(v)) {
        return v.every(isLootPoolEntry);
    }
    if (isObj(v)) {
        // keyed map of arrays
        return Object.values(v).every(arr => Array.isArray(arr) && arr.every(isLootPoolEntry));
    }
    return false;
}

function isPickNode(v: Record<string, unknown>): v is LootPickNode {
    if (v.kind !== 'pick') return false;
    if (!isStr(v.axis)) return false;
    if (!isObj(v.weights)) return false;
    for (const wv of Object.values(v.weights)) {
        if (!isNum(wv)) return false;
    }
    if (!isObj(v.branches)) return false;
    for (const bv of Object.values(v.branches)) {
        if (!isStr(bv)) return false;
    }
    return true;
}

function isDrawSpec(v: unknown): v is LootDrawNode['draws'][number] {
    if (!isObj(v)) return false;
    if (!isStr(v.pool)) return false;
    if (!isStr(v.as)) return false;
    if (v.filterBy !== undefined && !isStr(v.filterBy)) return false;
    return true;
}

function isDrawNode(v: Record<string, unknown>): v is LootDrawNode {
    if (v.kind !== 'draw') return false;
    if (!Array.isArray(v.draws)) return false;
    if (!v.draws.every(isDrawSpec)) return false;
    if (v.next !== undefined && !isStr(v.next)) return false;
    return true;
}

function isAmountNode(v: Record<string, unknown>): v is LootAmountNode {
    if (v.kind !== 'amount') return false;
    if (!isStr(v.unit)) return false;
    if (!isNum(v.min) || !isNum(v.max)) return false;
    if (v.scaleBySource !== undefined && typeof v.scaleBySource !== 'boolean') return false;
    if (v.next !== undefined && !isStr(v.next)) return false;
    return true;
}

function isComposeNode(v: Record<string, unknown>): v is LootComposeNode {
    if (v.kind !== 'compose') return false;
    if (!isStr(v.template)) return false;
    return true;
}

function isNode(v: unknown): v is LootNode {
    if (!isObj(v)) return false;
    const kind = v.kind;
    if (kind === 'pick') return isPickNode(v);
    if (kind === 'draw') return isDrawNode(v);
    if (kind === 'amount') return isAmountNode(v);
    if (kind === 'compose') return isComposeNode(v);
    return false;
}

/**
 * Validate a parsed `loot.json` object into a `LootTree`. Returns null on any
 * structural problem (after console.warn-ing); never throws.
 */
export function loadLootTree(raw: unknown): LootTree | null {
    if (!isObj(raw)) {
        console.warn(`${TAG} invalid loot.json: root is not an object`);
        return null;
    }
    if (!isStr(raw.root)) {
        console.warn(`${TAG} invalid loot.json: missing/invalid 'root'`);
        return null;
    }
    if (!isObj(raw.nodes)) {
        console.warn(`${TAG} invalid loot.json: missing/invalid 'nodes' map`);
        return null;
    }
    if (!isObj(raw.pools)) {
        console.warn(`${TAG} invalid loot.json: missing/invalid 'pools' map`);
        return null;
    }

    const root: LootNodeId = raw.root;
    const nodesRaw = raw.nodes as Record<string, unknown>;
    const poolsRaw = raw.pools as Record<string, unknown>;

    // Root must exist in nodes.
    if (!(root in nodesRaw)) {
        console.warn(`${TAG} invalid loot.json: root "${root}" not present in nodes`);
        return null;
    }

    // Validate every node.
    const nodes: Record<LootNodeId, LootNode> = {};
    for (const [id, n] of Object.entries(nodesRaw)) {
        if (!isNode(n)) {
            console.warn(`${TAG} invalid loot.json: node "${id}" has invalid shape`);
            return null;
        }
        nodes[id] = n;
    }

    // Validate every pool.
    const pools: Record<string, LootPool> = {};
    for (const [key, p] of Object.entries(poolsRaw)) {
        if (!isPool(p)) {
            console.warn(`${TAG} invalid loot.json: pool "${key}" has invalid shape`);
            return null;
        }
        pools[key] = p;
    }

    // Cross-reference: every branch / next target must exist in nodes.
    for (const [id, n] of Object.entries(nodes)) {
        if (n.kind === 'pick') {
            for (const [opt, target] of Object.entries(n.branches)) {
                if (!(target in nodes)) {
                    console.warn(`${TAG} invalid loot.json: node "${id}" branch "${opt}" → dangling target "${target}"`);
                    return null;
                }
            }
        } else if (n.kind === 'draw') {
            if (n.next !== undefined && !(n.next in nodes)) {
                console.warn(`${TAG} invalid loot.json: node "${id}" next → dangling target "${n.next}"`);
                return null;
            }
            for (const spec of n.draws) {
                if (!(spec.pool in pools)) {
                    console.warn(`${TAG} invalid loot.json: node "${id}" draw.pool "${spec.pool}" not in pools`);
                    return null;
                }
            }
        } else if (n.kind === 'amount') {
            if (n.next !== undefined && !(n.next in nodes)) {
                console.warn(`${TAG} invalid loot.json: node "${id}" next → dangling target "${n.next}"`);
                return null;
            }
        }
    }

    // Optional sources map (reserved; validate if present).
    let sources: LootTree['sources'] | undefined;
    if (raw.sources !== undefined) {
        if (!isObj(raw.sources)) {
            console.warn(`${TAG} invalid loot.json: 'sources' is not an object — ignoring`);
        } else {
            sources = {};
            const sv = raw.sources as Record<string, unknown>;
            for (const [src, cfg] of Object.entries(sv)) {
                if (!isObj(cfg)) {
                    console.warn(`${TAG} invalid loot.json: sources["${src}"] not an object — ignoring`);
                    continue;
                }
                const rolls = cfg.rolls;
                if (rolls !== undefined) {
                    if (!Array.isArray(rolls) || rolls.length !== 2 || !isNum(rolls[0]) || !isNum(rolls[1])) {
                        console.warn(`${TAG} invalid loot.json: sources["${src}"].rolls not [number, number] — ignoring`);
                        continue;
                    }
                }
                (sources as Record<string, { rolls?: [number, number] }>)[src] = {
                    rolls: rolls as [number, number] | undefined,
                };
            }
        }
    }

    return { root, nodes, pools, ...(sources ? { sources } : {}) };
}
