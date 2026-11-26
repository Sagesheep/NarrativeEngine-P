import type { PayloadTrace } from '../../../types';
import { countTokens } from '../../infrastructure/tokenizer';
import type { AssembledContributions, ContributionSpec } from './types';

/**
 * Project 2 / WO-P2-01 — the budget arbiter.
 *
 * ┌─ THE NO-FEATURE-NAMES RULE ────────────────────────────────────────────────────────────┐
 * │ This module may know only `(id, order, budget, suppresses, slot)`. It may NEVER branch  │
 * │ on WHICH contribution it is holding. The moment `if (id === 'director.brief')` appears  │
 * │ here, this file has become the god node the project exists to remove — the exact thing  │
 * │ `payloadBuilder`'s feature-named options had turned into.                               │
 * │                                                                                         │
 * │ Enforced, not merely asked for: `assemble.test.ts` runs a corpus twice — once with real │
 * │ ids and once with every id replaced by an opaque string — and asserts the output is     │
 * │ structurally identical.                                                                 │
 * └─────────────────────────────────────────────────────────────────────────────────────────┘
 */

const JOIN = '\n\n';

/**
 * Trim `text` so it costs at most `budget` tokens.
 *
 * Binary-searches the character length rather than tokenising repeatedly from scratch —
 * the tokenizer is the expensive part and this keeps it to O(log n) calls. Returns the
 * longest prefix that fits. Never called for contributions without a declared budget, which
 * is why built-in migration stays byte-identical.
 */
function trimToBudget(text: string, budget: number): string {
    if (budget <= 0) return '';
    if (countTokens(text) <= budget) return text;

    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (countTokens(text.slice(0, mid)) <= budget) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    return text.slice(0, lo).trimEnd();
}

/**
 * Phase 5.2 — host-supplied suppression, computed rather than declared.
 *
 * A contribution states its suppressions on the spec it produces. An
 * interceptor states them for the whole turn, and may want to remove a block
 * WITHOUT contributing one (an empty-text spec suppresses nothing, by
 * design — see step 1 below), so it needs a channel that is not a spec.
 *
 * The entries carry their attributor so `AssembledContributions.suppressed`
 * stays as honest for computed suppression as it is for declared. This
 * arbiter still never learns WHICH id it is holding: an entry is an opaque
 * `(id, by)` pair, and the protected-id rule that decides what may appear
 * here is enforced upstream, in `services/mods/interceptors`. Putting that
 * list in this file would break the no-feature-names rule at the top of it.
 */
export interface AssembleOptions {
    readonly suppress?: readonly { readonly id: string; readonly by: string }[];
}

/**
 * Assemble rendered contributions into one block of text plus debug traces.
 *
 * Pipeline, in order:
 *   1. drop inactive (empty `text`) — an inactive contribution suppresses nothing;
 *   2. resolve suppression in a single pass (see `ContributionSpec.suppresses`),
 *      seeded with any host-supplied suppression (`options.suppress`);
 *   3. trim any survivor that declared a budget and exceeds it;
 *   4. sort by `order` (stable — ties keep declaration order);
 *   5. join with a blank line;
 *   6. emit a trace for each survivor that declared trace metadata.
 *
 * Pure: no store reads, no I/O, no clock. Given the same specs it returns the same result.
 */
export function assembleContributions(
    specs: readonly ContributionSpec[],
    options?: AssembleOptions,
): AssembledContributions {
    // 1 ── active set
    const active = specs.filter((s) => s.text !== '');

    // 2 ── suppression, single pass from the active set (no cascade — see types.ts)
    const suppressedBy = new Map<string, string>();
    // Host-supplied suppression is seeded first so its attribution wins the
    // tie, matching the "first suppressor wins the attribution" rule below;
    // the outcome is identical either way, since suppression is a set.
    for (const entry of options?.suppress ?? []) {
        if (!suppressedBy.has(entry.id)) suppressedBy.set(entry.id, entry.by);
    }
    for (const spec of active) {
        if (!spec.suppresses) continue;
        for (const victimId of spec.suppresses) {
            // First suppressor wins the attribution; the outcome is the same either way.
            if (!suppressedBy.has(victimId)) suppressedBy.set(victimId, spec.id);
        }
    }
    const survivors = active.filter((s) => !suppressedBy.has(s.id));

    // 3 ── budget enforcement (only for contributions that asked for a ceiling)
    const trimmed: AssembledContributions['trimmed'] = [];
    const fitted = survivors.map((spec) => {
        if (spec.budget === undefined) return spec;
        const before = countTokens(spec.text);
        if (before <= spec.budget) return spec;
        const text = trimToBudget(spec.text, spec.budget);
        trimmed.push({ id: spec.id, fromTokens: before, toTokens: countTokens(text) });
        return { ...spec, text };
    }).filter((spec) => spec.text !== ''); // a zero budget can empty a contribution entirely

    // 4 ── order (Array.prototype.sort is stable per spec, so ties keep declaration order)
    const ordered = [...fitted].sort((a, b) => a.order - b.order);

    // 5 ── join
    const text = ordered.map((s) => s.text).join(JOIN);

    // 6 ── traces
    const traces: PayloadTrace[] = [];
    for (const spec of ordered) {
        if (!spec.trace) continue;
        traces.push({
            source: spec.trace.source,
            classification: spec.trace.classification,
            tokens: countTokens(spec.text),
            reason: spec.trace.reason,
            included: true,
            position: 'user',
            preview: spec.text,
        });
    }

    return {
        text,
        traces,
        included: ordered.map((s) => s.id),
        suppressed: [...suppressedBy]
            // Only report suppression of contributions that were actually active.
            .filter(([victimId]) => active.some((s) => s.id === victimId))
            .map(([id, by]) => ({ id, by })),
        trimmed,
    };
}
