/**
 * Phase 5.2 — the pre-prompt / generation interceptor.
 *
 * Barrel, in the shape `services/mods/events/index.ts` established: product
 * code outside this folder imports from here, not from the individual files,
 * so the internals stay re-arrangeable.
 */
export type {
    InterceptorFaultKind,
    InterceptorRegistryMod,
    PromptContribution,
    PromptInterception,
    PromptInterceptionResult,
    PromptInterceptor,
    PromptInterceptorInput,
    PromptInterceptorResult,
} from './interceptorTypes';
export { INTERCEPTOR_DEADLINE_MS, PROMPT_INTERCEPTOR_HOOK_NAME } from './interceptorTypes';
export {
    clearAllModInterceptors,
    disableModInterceptors,
    enableModInterceptors,
    hasPromptInterceptors,
    interceptorSpecId,
    isModInterceptorsRevoked,
    listPromptInterceptors,
    registerModInterceptor,
    runPromptInterceptors,
} from './interceptorRegistry';
export type { InterceptorFaultRecord, InterceptorFaultStore } from './interceptorFaults';
export { createInterceptorFaultStore, formatInterceptorFaultReason, interceptorFaultStore } from './interceptorFaults';
