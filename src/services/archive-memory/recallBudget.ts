/**
 * How much of the story prompt past scenes may use each turn (the archive recall
 * budget), chosen by the player. The best scene is recalled in full and the rest
 * as one-line definitions (`fetchRecallScenes`); more room lets the best scene, and
 * sometimes a second one, arrive whole instead of cut.
 *
 * On the Turn Prep probes (578-scene copy, Haiku as Recall Picker) the right scene
 * arrived in full in 4/9 probes at 3,000, 5/9 at 4,000 and 6/9 at 6,000; it reached
 * the writer in 9/9 at every size.
 */
export const SCENE_RECALL_BUDGETS = [3000, 4000, 6000] as const;
export type SceneRecallBudget = typeof SCENE_RECALL_BUDGETS[number];
export const DEFAULT_SCENE_RECALL_BUDGET: SceneRecallBudget = 3000;

export function normalizeSceneRecallBudget(value: unknown): SceneRecallBudget {
    return (SCENE_RECALL_BUDGETS as readonly unknown[]).includes(value) ? value as SceneRecallBudget : DEFAULT_SCENE_RECALL_BUDGET;
}
