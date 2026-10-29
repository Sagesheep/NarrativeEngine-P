/**
 * archiveMemory.ts — barrel
 *
 * T4 Memory — index-based hybrid retrieval over lossless .archive.md content.
 * Split into archive-memory/ submodules (idf, scoring, dynamicMax, recall);
 * this barrel preserves the original public surface so every existing
 * `import { ... } from './archiveMemory'` resolves unchanged.
 */

export { computeArchiveIdf, clearArchiveIdfCache } from './archive-memory/idf';
export {
    scoreEntry,
    extractContextActivations,
    expandActivationsWithFacts,
    applyEventBoost,
    type ScoreResult,
} from './archive-memory/scoring';
export { computeDynamicMax, PLANNER_RELEVANCE_BOOST, type RecallDepth } from './archive-memory/dynamicMax';
export { retrieveArchiveMemory, fetchArchiveScenes, recallArchiveScenes } from './archive-memory/recall';
