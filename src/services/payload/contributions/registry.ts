import type { ContributionSpec } from './types';

/**
 * Project 2 / WO-P2-01 — the contribution registry.
 *
 * Holds the modules that can contribute to a prompt: built-in systems and, later, loaded mods.
 * Deliberately generic over its input type `I`, so this file never imports `AppSettings`,
 * `BuildPayloadOptions`, or anything else feature-shaped. The prompt registry instantiates it
 * as `createContributionRegistry<PromptModuleInput>()`; a post-turn registry can reuse it with
 * a different `I` without touching this code.
 */

/**
 * A registerable unit that the extensions UI lists and the user can toggle.
 *
 * One module produces zero or more `ContributionSpec`s per turn. Built-in systems are modules
 * ("default-as-plugin"): with every built-in enabled and no mods installed, the app is
 * byte-identical to its pre-Project-2 behaviour.
 */
export interface ContributionModule<I> {
    /** Stable unique id, dot-namespaced: `director.brief`, `mod.grimdark-tone`. */
    id: string;
    /** Display name for the extensions screen. */
    name: string;
    /** One-line description for the extensions screen. */
    description: string;
    /** Provenance. `collect` stamps this onto every spec the module produces. */
    source: 'builtin' | 'mod';
    /** Whether the module is on for a user who has never touched the extensions screen. */
    defaultEnabled: boolean;
    /**
     * Whether the user may switch this module off. Defaults to `true`.
     *
     * A few built-ins are structural rather than optional — the player's own message and the
     * assembled world-state block are not features, they are the prompt. Marking them
     * `toggleable: false` keeps them out of the extensions screen AND makes `collect` ignore
     * the enablement predicate for them, so a corrupt or stale settings entry can never
     * silently delete the user's input from the prompt.
     */
    toggleable?: boolean;
    /**
     * WO-P5-02 §5 — whether this block fires automatically from the turn pipeline, only
     * from a manual user action, or is a reserved slot with no call site at all. Defaults
     * to `'automatic'` (a contribution module runs every turn it is enabled for; the
     * registry has no concept of a button-fired module today). The block view renders
     * manual blocks as visible-but-not-switchable, the same visual class as a locked
     * block; `unwired` blocks render as present-but-inert.
     */
    trigger?: 'automatic' | 'manual' | 'unwired';
    /**
     * WO-P5-02 §5 — whether this block calls a language model. Defaults to `false`.
     * Contribution modules themselves only produce synchronous text specs; any model call
     * that feeds them happens upstream and is gated by a tier feature, not by the module.
     * Mods, however, may themselves call a model from inside `produce` — they declare so
     * by setting `callsModel: true`.
     */
    callsModel?: boolean;
    /**
     * Produce this turn's contributions. Return `[]` when the module has nothing to add —
     * that is the normal quiet path, not an error.
     *
     * MUST be pure with respect to app state: read only from `input`. Throwing is contained
     * (see `collect`) but is treated as a module fault.
     */
    produce(input: I): ContributionSpec[];
}

/** A module that threw while producing. Surfaced so the UI can fail it safe with a reason. */
export interface ContributionFault {
    moduleId: string;
    error: Error;
}

export interface CollectOptions {
    /**
     * Enablement predicate. Defaults to "every registered module is enabled". Wiring this to
     * persisted settings is WO-P2-05's job; the registry stays storage-agnostic.
     */
    isEnabled?: (moduleId: string) => boolean;
    /** Called for each module that threw. The module is skipped; the turn continues. */
    onFault?: (fault: ContributionFault) => void;
}

export interface ContributionRegistry<I> {
    /** Register a module. Throws on duplicate id — that is always a programming/packaging bug. */
    register(module: ContributionModule<I>): void;
    /** Remove a module. Returns whether it was present. */
    unregister(moduleId: string): boolean;
    /** All registered modules, in registration order. For the extensions UI. */
    list(): readonly ContributionModule<I>[];
    get(moduleId: string): ContributionModule<I> | undefined;
    /** Run every enabled module and return the flattened specs, ready for the arbiter. */
    collect(input: I, options?: CollectOptions): ContributionSpec[];
    /** Drop all modules. Test/teardown only. */
    clear(): void;
}

/**
 * Default token ceiling applied to any mod-authored contribution that did not declare one.
 *
 * Defence in depth. The loader is supposed to reject a mod contribution with no `budget`, but
 * an unbounded third-party block appended to the final user message is exactly the failure the
 * arbiter exists to prevent, so the registry does not rely on the loader having done its job.
 * Built-ins are never touched by this — they stay unbounded, which is what keeps the migration
 * byte-identical.
 */
export const DEFAULT_MOD_CONTRIBUTION_BUDGET = 512;

export function createContributionRegistry<I>(): ContributionRegistry<I> {
    const modules = new Map<string, ContributionModule<I>>();

    return {
        register(module) {
            if (modules.has(module.id)) {
                throw new Error(`[contributions] duplicate module id: ${module.id}`);
            }
            modules.set(module.id, module);
        },

        unregister(moduleId) {
            return modules.delete(moduleId);
        },

        list() {
            return [...modules.values()];
        },

        get(moduleId) {
            return modules.get(moduleId);
        },

        collect(input, options) {
            const isEnabled = options?.isEnabled ?? (() => true);
            const specs: ContributionSpec[] = [];

            for (const module of modules.values()) {
                // Structural modules bypass the predicate entirely — see `toggleable`.
                if (module.toggleable !== false && !isEnabled(module.id)) continue;

                let produced: ContributionSpec[];
                try {
                    produced = module.produce(input);
                } catch (error) {
                    // Fail safe: one bad module must never take down a turn.
                    options?.onFault?.({
                        moduleId: module.id,
                        error: error instanceof Error ? error : new Error(String(error)),
                    });
                    continue;
                }

                for (const spec of produced) {
                    // The module's declared provenance is authoritative — a mod cannot
                    // claim to be a built-in and thereby escape the budget default below.
                    const source = module.source;
                    const budget = source === 'mod' && spec.budget === undefined
                        ? DEFAULT_MOD_CONTRIBUTION_BUDGET
                        : spec.budget;
                    specs.push(source === spec.source && budget === spec.budget
                        ? spec
                        : { ...spec, source, budget });
                }
            }

            return specs;
        },

        clear() {
            modules.clear();
        },
    };
}
