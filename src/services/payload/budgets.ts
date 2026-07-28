export function computeBudgets(
    limit: number,
    rulesBudgetPct: number | undefined,
    hasDeepContext: boolean
): { rulesBudget: number; budgetMap: { stable: number; world: number; volatile: number; npc: number; enemy: number } } {
    const rulesBudget = Math.floor(limit * (rulesBudgetPct ?? 0.10));
    const remainingAfterRules = limit - rulesBudget;

    // NPC floor — a guaranteed slice for the [ACTIVE NPC CONTEXT] block, decoupled from the
    // world budget so lore/archive pressure can never starve the scene's actors. Unused
    // remainder flows back to `world` in world.ts's two-phase trim. Fixed 5% — on small
    // contexts (8K) that's ~400 tokens (1-2 NPCs, the right order for a single scene).
    // The floor is taken OUT of the world allocation (NPCs and world lore share the same pool;
    // the floor just guarantees NPCs their slice).
    const npc = Math.floor(remainingAfterRules * 0.05);
    // Enemy context is intentionally small and scales with the provider context.
    // It is separately counted by history fitting, so this allowance can never be
    // appended on top of an already-full prompt. The hard ceiling prevents very
    // large context windows from turning compendium entries into prompt bloat.
    const enemy = Math.min(1024, Math.floor(limit * 0.025));

    const budgetMap = hasDeepContext
        ? {
            stable: Math.floor(remainingAfterRules * 0.15),
            world: Math.floor(remainingAfterRules * 0.60) - npc,
            volatile: Math.floor(remainingAfterRules * 0.10),
            npc,
            enemy,
        }
        : {
            stable: Math.floor(remainingAfterRules * 0.25),
            world: Math.floor(remainingAfterRules * 0.40) - npc,
            volatile: Math.floor(remainingAfterRules * 0.10),
            npc,
            enemy,
        };

    return { rulesBudget, budgetMap };
}
