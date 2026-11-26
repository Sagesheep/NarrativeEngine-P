/**
 * Phase 7.5 — the volatile-block segment seam.
 *
 * ## Why this exists
 *
 * `buildPayload` used to compose the volatile block by hand: it imported one
 * subsystem's two block builders, read that subsystem's config flag, picked
 * between the two builders, counted the result's tokens, wrote the trace row
 * with the subsystem's name in it, derived a scene fact from whether the text
 * came out empty, and spliced the string into a literal array.
 *
 * Nineteen lines of one feature's rendering rules inlined in the file whose
 * entire job is to be feature-blind. That is the god-node shape the previous
 * epic removed for the final user message (the contribution registry) and Phase
 * 7.4 removed for budgets. This file is the same cure applied to the last place
 * it was still open-coded.
 *
 * ## What a segment is
 *
 * A segment is a **pre-declared renderer** the caller hands to `buildPayload`,
 * exactly as Phase 5.2's `interception` hands it pre-validated specs. Core
 * never learns what produced one: it sees `{ id, order, render }` and nothing
 * else. The four things the departing block needed from `buildPayload` — its
 * token budget, the recent history, the user's message, and a place in the
 * block — are the whole `VolatileSegmentContext`, and they are generic.
 *
 * A segment is **not** a contribution (`contributions/types.ts`). Contributions
 * land in the `final-user` slot as their own paragraphs, below the cache
 * boundary, and are suppressible by id. A segment lands *inside* the composed
 * volatile block, which is one structural contribution
 * (`volatile.block`, `toggleable: false`). Both seams exist because the two
 * positions are different: a mod adding a block wants the final-user slot; a
 * core subsystem rendering state that belongs beside the world block wants
 * this one. After Phase 8 the extracted mod uses the interceptor instead, and
 * this seam stays empty — which is the point (see "Absence" below).
 *
 * ## Ordering
 *
 * Core's three self-produced parts occupy fixed anchors (100 / 200 / 400) and
 * segments sort among them by their own `order`, ties broken by declaration
 * index (a stable sort, the same tie-break `MOUNTS.md` §3.1 and the
 * contribution arbiter use). Today's one segment declares 300, which is exactly
 * where the hand-written array put its text — so the composed block is
 * byte-identical and the Phase 0.2 gate does not move.
 *
 * ## Absence
 *
 * No segments is the zero-length path: no block, no trace, no fact, no error,
 * and `buildPayload` makes byte-identical calls to its pre-7.5 ones. That is
 * Phase 7.5 §3 — *"a missing role produces no block, no fact, no panel — and no
 * error. The app is smaller, not damaged."* A segment whose `render` throws is
 * contained the same way a contribution module that throws is contained
 * (`contributions/registry.ts:141-150`): it is skipped, the rest of the turn is
 * unaffected, and one bad renderer never takes down a prompt.
 */
import type { ChatMessage } from '../../types';
import { countTokens } from '../infrastructure/tokenizer';
import type { ModFacts } from '../mods/modTypes';
import type { ContributionTraceMeta } from './contributions/types';

/**
 * The three anchors core's own parts occupy in the composed volatile block.
 * Published so a segment author can position against them without guessing.
 *
 *   - `RULES`  — RAG-retrieved rules text (`buildStable`'s `retrievedRulesContent`).
 *   - `WORLD`  — the world context block (`buildWorld`).
 *   - `STATE`  — location / scene note / profile / inventory (`buildVolatile`).
 *
 * The gap between `WORLD` and `STATE` is where subsystem state belongs, which
 * is why today's one segment declares 300.
 */
export const VOLATILE_ANCHOR = Object.freeze({
    RULES: 100,
    WORLD: 200,
    STATE: 400,
});

/**
 * Everything a segment is given. Deliberately four generic values — no
 * `BuildPayloadOptions`, no settings object, no store handle. A segment that
 * needs feature state closes over it at construction time (the factory pattern
 * its own module exposes), which keeps `buildPayload` pure and keeps
 * this type from growing a feature-shaped field the way `BuildPayloadOptions`
 * did.
 */
export interface VolatileSegmentContext {
    /**
     * The segment's token allocation for this turn, resolved as
     * `budgetMap.get(segment.id)` — so **a segment's id is its budget claim id**
     * (Phase 7.4). An unclaimed id yields `0`, and a segment is expected to
     * render nothing at zero. That single line is what makes budget absence and
     * block absence the same event.
     */
    readonly budget: number;
    /** The turn's chat history, for relevance matching. Read-only. */
    readonly history: readonly ChatMessage[];
    /** The player's message for this turn, for relevance matching. */
    readonly userMessage: string;
}

/** What a segment returns. Every field is optional except the text. */
export interface VolatileSegmentOutput {
    /** The rendered text. Empty string means "nothing this turn" — the quiet path, not an error. */
    readonly text: string;
    /**
     * Debug-trace metadata. Reuses `ContributionTraceMeta` rather than inventing
     * a second trace vocabulary: the host derives `tokens`, `preview`,
     * `included` and `position` itself, so a segment states only what it knows.
     * Omit to emit no trace.
     */
    readonly trace?: ContributionTraceMeta;
    /**
     * Facts this segment establishes about the scene. Merged onto the
     * host-computed facts before mod-published facts (Phase 5.4) are applied,
     * so a mod claiming a fact still wins.
     *
     * This is the channel that used to be the line
     * `inCombat: activeEncounterBlock !== ''` in `buildPayload`. Absent segment
     * ⇒ absent key ⇒ the host default stands, which for `inCombat` is `false`.
     * "Absence stays false" is 5.4's rule and it is preserved by construction.
     */
    readonly facts?: Partial<ModFacts>;
}

/**
 * A segment, as handed to `buildPayload`.
 *
 * Constructed per turn by the caller; the host never holds one across turns and
 * there is no module-level registry. That is deliberate: a registry would need a
 * lifecycle, a teardown and a mod lease, and mods already have the interceptor
 * (5.2) for prompt text. This seam exists for core subsystems on their way out,
 * and the caller is the one that knows their state.
 */
export interface VolatileSegment {
    /** Stable id. Doubles as the budget claim id (see `VolatileSegmentContext.budget`). */
    readonly id: string;
    /** Sort key among the anchors in `VOLATILE_ANCHOR`. Ties keep declaration order. */
    readonly order: number;
    /** Render this turn's text. Returning `null`/`undefined`/empty text is the quiet path. */
    render(context: VolatileSegmentContext): VolatileSegmentOutput | null | undefined;
}

/** One rendered segment, with the host-derived token count attached. */
export interface RenderedVolatileSegment {
    readonly id: string;
    readonly order: number;
    readonly text: string;
    readonly tokens: number;
    readonly trace?: ContributionTraceMeta;
    readonly facts?: Partial<ModFacts>;
}

/**
 * Run every segment and return the ones that produced text, in `order`.
 *
 * Total by construction: a segment that throws is skipped with a console
 * warning and the turn continues. Segments that render empty text are dropped
 * before the caller sees them, so `renderedSegments.length === 0` means
 * "nothing to fold in" without a second check.
 *
 * `contextFor` is a callback rather than a plain object so the budget can be
 * resolved per segment id without this module knowing what a budget map is.
 */
export function renderVolatileSegments(
    segments: readonly VolatileSegment[] | undefined,
    contextFor: (segmentId: string) => VolatileSegmentContext,
): RenderedVolatileSegment[] {
    if (!segments || segments.length === 0) return [];

    const rendered: RenderedVolatileSegment[] = [];
    for (const segment of segments) {
        let output: VolatileSegmentOutput | null | undefined;
        try {
            output = segment.render(contextFor(segment.id));
        } catch (error) {
            // Fail safe, the same posture as a throwing contribution module.
            console.warn(`[payload] volatile segment "${segment.id}" threw (skipped):`, error);
            continue;
        }
        if (!output) continue;
        const facts = output.facts;
        if (!output.text) {
            // No text, but a segment may still have an opinion about the scene
            // (today's one segment reports `inCombat: false` when no encounter
            // is running). Keep the facts, drop the empty paragraph.
            if (facts) rendered.push({ id: segment.id, order: segment.order, text: '', tokens: 0, facts });
            continue;
        }
        rendered.push({
            id: segment.id,
            order: segment.order,
            text: output.text,
            tokens: countTokens(output.text),
            trace: output.trace,
            facts,
        });
    }
    return rendered;
}

/** One part of the composed volatile block: core's own anchored text, or a rendered segment. */
interface VolatilePart {
    readonly order: number;
    readonly text: string | undefined;
}

/**
 * Compose the volatile block from core's three anchored parts plus any rendered
 * segments, sorted by `order` with declaration index as the tie-break.
 *
 * With zero segments this is `[rules, world, state].filter(Boolean).join('\n\n')`
 * — byte-identical to the pre-7.5 expression. With one segment at 300 it is
 * `[rules, world, segment, state]`, which is the pre-7.5 expression exactly.
 */
export function composeVolatileBlock(
    anchored: { readonly rules?: string; readonly world?: string; readonly state?: string },
    segments: readonly RenderedVolatileSegment[],
): string {
    const parts: VolatilePart[] = [
        { order: VOLATILE_ANCHOR.RULES, text: anchored.rules },
        { order: VOLATILE_ANCHOR.WORLD, text: anchored.world },
        ...segments.map((segment) => ({ order: segment.order, text: segment.text })),
        { order: VOLATILE_ANCHOR.STATE, text: anchored.state },
    ];
    return parts
        .map((part, index) => ({ part, index }))
        .sort((a, b) => (a.part.order - b.part.order) || (a.index - b.index))
        .map(({ part }) => part.text)
        .filter((text): text is string => !!text)
        .join('\n\n');
}
