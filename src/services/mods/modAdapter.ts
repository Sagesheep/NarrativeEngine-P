import type { ContributionModule } from '../payload/contributions/registry';
import type { FinalUserModuleInput } from '../payload/contributions/builtins';
import type { ContributionSpec } from '../payload/contributions/types';
import type { ModContribution, ModFacts, ModWhen, ValidatedMod } from './modTypes';
import { qualifyMacroName, resolveMacro, reportUnresolvedMacroSlot } from './macros/macroRegistry';

/**
 * Project 2 / WO-P2-04 — mod file → `ContributionModule`.
 *
 * This is the adapter that makes decision D2 real: the registry accepts a typed contribution and
 * never learns what produced it. A built-in system, a JSON file on disk, and (later) a code mod
 * all arrive at `assemble.ts` as the same `ContributionSpec[]`.
 *
 * Two invariants this file must never break:
 *
 *   1. NAMESPACING. Every spec id is `mod.<modId>.<contributionId>`. A mod can therefore never
 *      collide with — or impersonate — a built-in id, no matter what its author writes.
 *   2. NEVER THROW, NEVER OMIT. `produce` is pure and total. When a condition does not match,
 *      the spec is still returned with `text: ''`, which the arbiter reads as "inactive this
 *      turn" (and an inactive contribution suppresses nothing). Omitting the spec instead would
 *      work today but would make a mod's presence in the prompt depend on evaluation order.
 */

/** Case folding used by every string comparison here. */
const fold = (value: string): string => value.trim().toLowerCase();

const toList = (value: string | string[] | undefined): string[] => {
    if (value === undefined) return [];
    return Array.isArray(value) ? value : [value];
};

const foldedList = (value: string | string[] | undefined): string[] =>
    toList(value).filter((v): v is string => typeof v === 'string').map(fold).filter((v) => v !== '');

const foldedFacts = (value: unknown): string[] | undefined =>
    Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string').map(fold)
        : undefined;

/**
 * Read `facts` off the module input without depending on its declared shape.
 *
 * `FinalUserModuleInput` gains `facts` in a concurrent work order, and a payload builder that
 * has not been taught to supply it yet is a normal, supported state — mods simply see no facts
 * and every conditional contribution stays inactive.
 */
function readFacts(input: unknown): ModFacts | undefined {
    const facts = (input as { facts?: unknown } | null | undefined)?.facts;
    return typeof facts === 'object' && facts !== null && !Array.isArray(facts)
        ? (facts as ModFacts)
        : undefined;
}

/**
 * Evaluate a mod condition against this turn's facts.
 *
 * AND across keys, OR within a key, case-insensitive for the string keys. A key that references
 * a fact the app did not supply returns `false` — an unknown world is not a matching world.
 * `when` absent (or `undefined`) is always active.
 */
export function evaluateWhen(when: ModWhen | undefined, facts: ModFacts | undefined): boolean {
    if (!when) return true;

    if (when.npcPresent !== undefined) {
        const onStage = foldedFacts(facts?.onStageNpcNames);
        if (!onStage) return false;
        const wanted = foldedList(when.npcPresent);
        if (!wanted.some((name) => onStage.includes(name))) return false;
    }

    if (when.location !== undefined) {
        // An empty/blank location is treated as "unknown", i.e. no match.
        const actual = typeof facts?.location === 'string' ? fold(facts.location) : '';
        if (actual === '') return false;
        if (!foldedList(when.location).includes(actual)) return false;
    }

    if (when.inCombat !== undefined) {
        if (typeof facts?.inCombat !== 'boolean') return false;
        if (facts.inCombat !== when.inCombat) return false;
    }

    if (when.sceneTag !== undefined) {
        const tags = foldedFacts(facts?.sceneTags);
        if (!tags) return false;
        const wanted = foldedList(when.sceneTag);
        if (!wanted.some((tag) => tags.includes(tag))) return false;
    }

    return true;
}

/** The only slots v1 understands. Everything else is left verbatim — see `renderTemplate`. */
const SLOT_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;

/**
 * Substitute `{{location}}` and `{{npcs}}`, plus any mod-registered macros.
 * Nothing else: no expressions, no property paths, no code. An unknown slot
 * is left EXACTLY as written rather than blanked, so an author sees their
 * typo in the prompt instead of silently losing a sentence.
 *
 * Phase 5.1 — macro resolution. A mod registers a name and a resolver
 * through `ctx.macros.register()`; the host qualifies the name to
 * `mod.<modId>.<name>`. `renderTemplate` consults the registry AFTER the
 * built-in slots and BEFORE the verbatim fallback. The built-in slots are
 * checked first so a mod cannot shadow `{{location}}` / `{{npcs}}` even if
 * the registry's shadow-rejection were bypassed (belt-and-braces — the
 * registry already rejects shadows).
 *
 * `modId` is the mod whose contribution is being rendered. A built-in
 * caller (no mod) passes `undefined`; the registry lookup is then a no-op
 * for every slot, which is the pre-5.1 behaviour preserved exactly.
 */
export function renderTemplate(text: string, facts: ModFacts | undefined, modId?: string): string {
    if (typeof text !== 'string' || !text.includes('{{')) return text;

    return text.replace(SLOT_PATTERN, (match, rawKey: string) => {
        switch (rawKey) {
            case 'location':
                return typeof facts?.location === 'string' ? facts.location : '';
            case 'npcs':
                return Array.isArray(facts?.onStageNpcNames)
                    ? facts.onStageNpcNames.filter((n): n is string => typeof n === 'string').join(', ')
                    : '';
            default:
                // Phase 5.1 — mod macros. The registry contains the
                // resolver keyed by the qualified name; the bare name is
                // what the author wrote. `resolveMacro` returns
                // `undefined` for a slot no mod registered, which falls
                // through to the verbatim typo fallback.
                if (modId !== undefined) {
                    const expanded = resolveMacro(qualifyMacroName(modId, rawKey), rawKey);
                    if (expanded !== undefined) return expanded;
                    // Phase 9.2 — the slot is still left verbatim, but it is no
                    // longer silent. See `reportUnresolvedMacroSlot`.
                    reportUnresolvedMacroSlot(modId, rawKey);
                }
                return match;
        }
    });
}

/** Namespaced spec id. The one thing that keeps mods out of the built-in id space. */
export function modSpecId(modId: string, contributionId: string): string {
    return `mod.${modId}.${contributionId}`;
}

function toSpec(mod: ValidatedMod, contribution: ModContribution, facts: ModFacts | undefined): ContributionSpec {
    const id = modSpecId(mod.id, contribution.id);

    let text = '';
    try {
        text = evaluateWhen(contribution.when, facts) ? renderTemplate(contribution.text, facts, mod.id) : '';
    } catch {
        // Total by construction; this is the belt-and-braces for a hostile/odd file shape.
        text = '';
    }

    const spec: ContributionSpec = {
        id,
        slot: 'final-user',
        order: typeof contribution.order === 'number' && Number.isFinite(contribution.order)
            ? contribution.order
            : 0,
        text,
        source: 'mod',
        // Left undefined on purpose when the file declared none: the registry then stamps
        // DEFAULT_MOD_CONTRIBUTION_BUDGET, so an unbounded mod block cannot reach the prompt.
        budget: typeof contribution.budget === 'number' ? contribution.budget : undefined,
        trace: {
            source: mod.name,
            classification: 'world_context',
            reason: `Mod contribution "${contribution.id}" from ${mod.name} v${mod.version}`,
        },
    };

    // Verbatim — a mod legitimately targets built-in ids such as `gm.reminder`. Structural ids
    // were already rejected at load time by `modLoader.js`.
    const suppresses = Array.isArray(contribution.suppresses)
        ? contribution.suppresses.filter((s): s is string => typeof s === 'string' && s !== '')
        : [];
    if (suppresses.length > 0) spec.suppresses = suppresses;

    return spec;
}

/**
 * Wrap a validated mod as a registerable module.
 *
 * `toggleable: true` / `defaultEnabled: true`: a mod the user installed is on until they say
 * otherwise, and is always switchable off (unlike the structural built-ins).
 */
export function modToContributionModule(mod: ValidatedMod): ContributionModule<FinalUserModuleInput> {
    const contributions = Array.isArray(mod.contributions) ? [...mod.contributions] : [];

    return {
        id: `mod.${mod.id}`,
        name: mod.name,
        description: typeof mod.description === 'string' ? mod.description : '',
        source: 'mod',
        defaultEnabled: true,
        toggleable: true,
        produce: (input) => {
            const facts = readFacts(input);
            return contributions.map((contribution) => toSpec(mod, contribution, facts));
        },
    };
}
