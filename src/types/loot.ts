export type LootNodeId = string;

/** Store-number/show-word: `text` ships to the LLM; `tier`/`budget` stay engine-only. */
export type LootPoolEntry = {
    text: string;          // the word the GM sees, e.g. "spearman", "Void", "Sword Saint"
    tier?: number;         // engine-only power rank (gear budgets); omit for pure-flavor entries
    budget?: string;       // engine-only effect budget (epic/legendary gear only); free-text for MVP
};

/** A pool is either a flat list OR a map keyed by a filter axis (e.g. domain). */
export type LootPool = LootPoolEntry[] | Record<string, LootPoolEntry[]>;

/** PICK — weighted fork. The chosen option maps to the next node id (recursion = the tree). */
export type LootPickNode = {
    kind: 'pick';
    axis: string;                          // bound for later filter/compose, e.g. 'category','rarityClass','domain'
    weights: Record<string, number>;       // option -> weight; NEED NOT sum to 100 (engine normalizes)
    branches: Record<string, LootNodeId>;  // option -> next node id. The `unique` short-circuit is just
                                           // a branch pointing at a Draw node with no aspect draw.
};

/** DRAW — pull entries from one or more pools, optionally filtered by an earlier pick axis. */
export type LootDrawSpec = {
    pool: string;                          // key into LootTree.pools
    as: string;                            // binding name for compose, e.g. 'job','aspect'
    filterBy?: string;                     // an earlier pick axis whose value keys the pool map (e.g. 'domain')
};

export type LootDrawNode = {
    kind: 'draw';
    draws: LootDrawSpec[];
    next?: LootNodeId;                      // usually a compose node; omit to auto-compose (see WO-01 §3)
};

/** AMOUNT — roll a number in a range (currency). */
export type LootAmountNode = {
    kind: 'amount';
    unit: string;                          // 'creds','ingots'
    min: number;
    max: number;
    scaleBySource?: boolean;               // MVP: may ignore; reserved for per-source multipliers
    next?: LootNodeId;
};

/** COMPOSE — assemble bound values into the final label. */
export type LootComposeNode = {
    kind: 'compose';
    template: string;                      // "{job} of the {aspect}" | "{job}" | "{amount} {unit}"
};

export type LootNode =
    | LootPickNode
    | LootDrawNode
    | LootAmountNode
    | LootComposeNode;

export type LootTree = {
    root: LootNodeId;
    nodes: Record<LootNodeId, LootNode>;
    pools: Record<string, LootPool>;
    /** optional: per-source/roll-count overrides, reserved. */
    sources?: Record<string, { rolls?: [number, number] }>;
};

export type LootProfile = {
    id?: string;
    entryNode?: LootNodeId;
    reweight?: Record<LootNodeId, Record<string, number>>;
};

export type LootItem = {
    label: string;                         // final composed string, e.g. "Spearman of the Void"
    parts: Record<string, string>;         // bound axis/draw values, e.g. {category,rarityClass,domain,job,aspect}
    tierWord?: string;                     // optional banded power word (gear); from entry.tier via a band fn
};

export type LootDropResult = {
    appendToInput: string;                 // "[LOOT DROP: Spearman of the Void]" — SAME shape as rollEngines
    items: LootItem[];
    trace: string[];                        // debug: walked node ids + rolls
};

export type ResolveLootOpts = {
    profile?: LootProfile;
    source?: string;                       // selects sources[source].rolls if present
    rolls?: number;                        // how many items; default 1 (MVP)
    rng?: () => number;                    // injectable for tests (default Math.random)
};

export type ArmedLoot = {
    rolls: number;
    /** Soft override: replace weights at named pick nodes (root pick's options from the modal). */
    reweight?: Record<string, Record<string, number>>;
};

