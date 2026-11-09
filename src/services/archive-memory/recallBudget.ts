/**
 * How much of the story prompt past scenes may use each turn (the archive recall
 * budget), chosen by the player as a free number. The best scene is recalled in
 * full and the rest as one-line definitions (`fetchRecallScenes`); more room lets
 * the best scene, and sometimes a second one, arrive whole instead of cut.
 *
 * On the Turn Prep probes (578-scene copy, Haiku as Recall Picker) the right scene
 * arrived in full in 4/9 probes at 3,000, 5/9 at 4,000 and 6/9 at 6,000; it reached
 * the writer in 9/9 at every size.
 */
export const DEFAULT_SCENE_RECALL_BUDGET = 3000;
/** Below this not even a median scene (~1,300 tokens) and its brief lines fit. */
export const MIN_SCENE_RECALL_BUDGET = 500;

/** The stored setting: a whole number of at least the minimum, else the default. */
export function normalizeSceneRecallBudget(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= MIN_SCENE_RECALL_BUDGET
        ? Math.round(value)
        : DEFAULT_SCENE_RECALL_BUDGET;
}

/** The space recall actually gets: the setting, never more than the context window. */
export function effectiveSceneRecallBudget(value: unknown, contextLimit: unknown): number {
    const budget = normalizeSceneRecallBudget(value);
    return typeof contextLimit === 'number' && Number.isFinite(contextLimit) && contextLimit > 0
        ? Math.min(budget, Math.floor(contextLimit))
        : budget;
}
