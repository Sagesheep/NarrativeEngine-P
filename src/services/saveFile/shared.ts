import { countTokens } from '../infrastructure/tokenizer';

// ─── Shared Utilities ───

export const CHAPTER_SUMMARY_TOKEN_BUDGET = 8000;

export function truncateScenesToBudget(
    scenes: { sceneId: string; content: string }[],
    budget: number = CHAPTER_SUMMARY_TOKEN_BUDGET
): { sceneId: string; content: string }[] {
    // First pass: cap any single scene that exceeds the entire budget on its own
    const perSceneCap = Math.max(Math.floor(budget / Math.max(scenes.length, 1)), 500);
    let working = scenes.map(s => {
        if (countTokens(s.content) <= perSceneCap) return s;
        // ~4 chars per token approximation for the slice
        return { sceneId: s.sceneId, content: s.content.slice(0, perSceneCap * 4) + '\n[...truncated]' };
    });

    // Second pass: drop middle scenes until total fits the budget
    while (working.length > 1 && working.reduce((sum, s) => sum + countTokens(s.content), 0) > budget) {
        const mid = Math.floor(working.length / 2);
        working = [...working.slice(0, mid), ...working.slice(mid + 1)];
    }

    return working;
}
