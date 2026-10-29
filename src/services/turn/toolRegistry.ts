import type { GameContext, DiceSystemConfig, InventoryProposal } from '../../types';
import {
    handleLoreTool,
    handleNotebookTool,
    handleDiceTool,
    handleProposeInventoryTool,
} from './toolHandlers';

/**
 * Phase 4 — Tool Registry
 *
 * Replaces the imperative `if (toolCall.name === '...') {...}` chain in
 * `turnOrchestrator.ts` with a declarative lookup. Each entry adapts a
 * tool-handler from `toolHandlers.ts` to a uniform {@link ToolDispatchResult}
 * shape; the orchestrator performs the common side-effects (push assistant
 * + tool messages to payload, push trace, schedule retry) and applies any
 * tool-specific side-effects signalled by the handler.
 *
 * Behaviour preservation contract:
 *  - `accumulationMode` mirrors the per-tool overwrite/append behaviour that
 *    existed inline in the orchestrator before Phase 4.
 *  - `traceResult` is `true` for every tool that previously called
 *    `pushToolTrace`. `propose_inventory_change`
 *    previously did NOT call `pushToolTrace` — that is preserved.
 *  - Side-effects (`updateContext`, `stageProposal`) are returned as data
 *    and applied by the orchestrator, not executed here, so the handlers
 *    remain pure and the registry stays free of store/callback knowledge.
 */

export type AccumulationMode = 'overwrite' | 'append';

export type ToolDispatchContext = {
    /** Arguments string passed by the LLM (JSON). */
    arguments: string;
    /** Current lore chunks (for lore queries). */
    loreChunks: import('../../types').LoreChunk[];
    /** Current scene notebook (for notebook mutations). */
    notebook: GameContext['notebook'];
    /** Dice system config (for dice rolls). */
    diceSystem: DiceSystemConfig | null | undefined;
};

export type ToolDispatchResult = {
    /** String content returned to the LLM as the tool message. */
    toolResult: string;
    /** Whether to overwrite or append the engine text to accumulated content. */
    accumulation: AccumulationMode;
    /** Whether to push a payload-trace row for this tool call. */
    traceResult: boolean;
    /** Optional context patch to apply after the tool runs. */
    contextPatch?: Partial<GameContext>;
    /** Optional inventory proposal to stage for user confirmation. */
    proposal?: InventoryProposal;
};

export type ToolHandlerFn = (
    ctx: ToolDispatchContext
) => ToolDispatchResult;

const handleLore: ToolHandlerFn = (ctx) => {
    const { toolResult } = handleLoreTool(ctx.arguments, { loreChunks: ctx.loreChunks, notebook: ctx.notebook });
    return {
        toolResult,
        accumulation: 'overwrite',
        traceResult: true,
    };
};

const handleNotebook: ToolHandlerFn = (ctx) => {
    const { toolResult, updatedNotebook } = handleNotebookTool(ctx.arguments, {
        loreChunks: ctx.loreChunks,
        notebook: ctx.notebook,
    });
    return {
        toolResult,
        accumulation: 'overwrite',
        traceResult: true,
        contextPatch: { notebook: updatedNotebook },
    };
};

const handleDice: ToolHandlerFn = (ctx) => {
    const { toolResult } = handleDiceTool(ctx.arguments, { diceSystem: ctx.diceSystem });
    return {
        toolResult,
        accumulation: 'append',
        traceResult: true,
    };
};

const handleProposeInventory: ToolHandlerFn = (ctx) => {
    const { toolResult, proposal } = handleProposeInventoryTool(ctx.arguments);
    return {
        toolResult,
        accumulation: 'append',
        traceResult: false,
        proposal,
    };
};

export const TOOL_REGISTRY: Record<string, ToolHandlerFn> = {
    query_campaign_lore: handleLore,
    update_scene_notebook: handleNotebook,
    roll_dice: handleDice,
    propose_inventory_change: handleProposeInventory,
};

/**
 * Look up a tool handler by name. Returns `null` for unknown tools so the
 * orchestrator can fall through to the final-answer path (mirroring the
 * pre-Phase-4 behaviour where an unmatched `toolCall` simply produced the
 * final response).
 */
export function resolveToolHandler(name: string): ToolHandlerFn | null {
    return TOOL_REGISTRY[name] ?? null;
}

/**
 * Module-load validation: fail fast if any registered handler is missing or
 * duplicated. Catches registry typos at startup instead of at first turn.
 */
export function validateToolRegistry(): void {
    const expected = [
        'query_campaign_lore',
        'update_scene_notebook',
        'roll_dice',
        'propose_inventory_change',
    ];
    for (const name of expected) {
        const handler = TOOL_REGISTRY[name];
        if (typeof handler !== 'function') {
            throw new Error(`[ToolRegistry] Missing handler for tool "${name}"`);
        }
    }
}

validateToolRegistry();