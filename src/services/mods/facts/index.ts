/**
 * Phase 5.4 — the fact publication surface.
 *
 * Barrel, in the shape `services/mods/events/index.ts` and
 * `services/mods/interceptors/index.ts` established: product code
 * outside this folder imports from here, not from the individual files,
 * so the internals stay re-arrangeable.
 */
export type {
    FactFaultKind,
    FactPublicationResult,
    FactPublisher,
    FactRegistryMod,
    ModFactsApi,
} from './factTypes';
export {
    CLAIMABLE_CORE_FACTS,
    CLAIMABLE_CORE_FACT_SET,
    CORE_FACT_NAMES,
    CORE_FACT_NAME_SET,
} from './factTypes';
export {
    buildModFactsApi,
    clearAllModFacts,
    disableModFacts,
    enableModFacts,
    hasFactClaim,
    hasFactPublishers,
    isModFactsRevoked,
    listModFacts,
    qualifyFactName,
    registerModFact,
    runFactPublishers,
} from './factRegistry';
export type { FactFaultRecord, FactFaultStore } from './factFaults';
export { createFactFaultStore, factFaultStore, formatFactFaultReason } from './factFaults';