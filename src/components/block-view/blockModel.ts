/**
 * WORKORDER-P5-02 §4 — the unified block model.
 *
 * The block view walks three registries and renders every block they publish, without
 * ever naming a feature by id in this directory (the §4 / §8 hard failure condition). The
 * three sources all expose a `list()` (or `listTierBlocks()`) returning objects that share
 * `id / name / description / defaultEnabled / toggleable`. This file normalises them into
 * one `Block` shape and stamps the two WO-P5-02 §5 display fields onto it:
 *
 *   - `kind`      — ENGINE or MODEL, from each source's `callsModel` metadata.
 *   - `switchable`— false for `toggleable === false`, `trigger === 'manual'`, or
 *                   `trigger === 'unwired'`. A manual block (button-fired) renders
 *                   visible-but-not-switchable (§5); an unwired block (reserved slot,
 *                   no call site) renders present-but-inert. Both are locked, but the
 *                   `lockReason` distinguishes them so the badge tells the user which
 *                   is which. This rule never tests `id`, so a future manual or unwired
 *                   feature is handled the same way without a code change.
 *
 * Enablement is NOT resolved here — the component reads it through `isBlockEnabled` so the
 * view's display always matches what the next turn will actually do (WO-P5-02 §5).
 */
import { listTierBlocks, type TierBlock } from '../../services/turn/aiTier';
import { createFinalUserRegistryWithExtensions } from '../../services/payload/contributions/extensions';
import type { ContributionModule, ContributionRegistry } from '../../services/payload/contributions/registry';
import { postTurnTracks } from '../../services/turn/tracks';
import type { PostTurnTrack } from '../../services/turn/tracks/types';

/** Which kind of compute a block performs — drives the badge colour. */
export type BlockKind = 'engine' | 'model';

/** Which registry a block came from — drives the section grouping in the view. */
export type BlockSource = 'tier' | 'contribution' | 'track';

/**
 * The one shape the BlockView renders. Every field comes from registry metadata; none is
 * hand-set per feature.
 */
export interface Block {
    id: string;
    name: string;
    description: string;
    source: BlockSource;
    kind: BlockKind;
    /** Whether the user may flip the switch. Locked and manual blocks are not switchable. */
    switchable: boolean;
    /** Why the switch is off, when it is. Drives the locked vs manual vs unwired badge text. */
    lockReason?: 'structural' | 'manual' | 'unwired';
    /** Whether this block is on for a user who has never touched the screen. */
    defaultEnabled: boolean;
    /** Provenance for contributions: built-in or installed mod. Shown under the description. */
    meta?: string;
}

/** A contribution module widened to `unknown` input for the unified view. */
type ListableContribution = ContributionModule<unknown>;

const asBlockKind = (callsModel: boolean | undefined): BlockKind =>
    callsModel === true ? 'model' : 'engine';

/** Map a trigger + toggleable pair to the lockReason, in priority order. */
function lockReasonFor(trigger: string | undefined, toggleable: boolean | undefined): Block['lockReason'] {
    const unwired = trigger === 'unwired';
    const manual = trigger === 'manual';
    const structural = toggleable === false;
    // Priority: unwired (most informative — nothing runs) > manual (fires from a button)
    // > structural (locked to preserve data). A block can be both manual and structural
    // (arcSpawn is), but manual is the more informative reason.
    if (unwired) return 'unwired';
    if (manual) return 'manual';
    if (structural) return 'structural';
    return undefined;
}

const tierBlockToBlock = (b: TierBlock): Block => {
    const lockReason = lockReasonFor(b.trigger, b.toggleable);
    return {
        id: b.id,
        name: b.name,
        description: b.description,
        source: 'tier',
        kind: asBlockKind(b.callsModel),
        switchable: lockReason === undefined,
        lockReason,
        defaultEnabled: b.defaultEnabled,
    };
};

const contributionToBlock = (m: ListableContribution, meta?: string): Block => {
    const lockReason = lockReasonFor(m.trigger, m.toggleable);
    return {
        id: m.id,
        name: m.name,
        description: m.description,
        source: 'contribution',
        kind: asBlockKind(m.callsModel),
        switchable: lockReason === undefined,
        lockReason,
        defaultEnabled: m.defaultEnabled,
        meta,
    };
};

const trackToBlock = (tr: PostTurnTrack<unknown>): Block => {
    const lockReason = lockReasonFor(tr.trigger, tr.toggleable);
    return {
        id: tr.id,
        name: tr.name,
        description: tr.description,
        source: 'track',
        kind: asBlockKind(tr.callsModel),
        switchable: lockReason === undefined,
        lockReason,
        defaultEnabled: tr.defaultEnabled,
    };
};

export interface EnumeratedBlocks {
    tier: Block[];
    contributions: Block[];
    tracks: Block[];
}

/**
 * Walk the three registries once and return their blocks grouped by source.
 *
 * The contribution registry is built fresh each call (`createFinalUserRegistryWithExtensions`
 * is a factory, not a singleton — see `extensions.ts`), so installed mods appear here the
 * moment `refreshMods()` has registered them, with no extra wiring. The post-turn track
 * registry is a module-level singleton (`postTurnTracks`); its `list()` reflects whatever
 * is currently registered. The tier features come from the declaration table in `aiTier.ts`.
 *
 * Structural contributions (`toggleable === false`) are intentionally INCLUDED here, unlike
 * the Extensions screen which filters them out. WO-P5-02 §5: "locked, not hidden" — a user
 * seeing the player's own message as a locked block learns something true about the app.
 */
export function enumerateBlocks(): EnumeratedBlocks {
    const tier = listTierBlocks().map(tierBlockToBlock);

    let registry: ContributionRegistry<unknown>;
    try {
        registry = createFinalUserRegistryWithExtensions() as unknown as ContributionRegistry<unknown>;
    } catch {
        // `createFinalUserRegistryWithExtensions` does not throw in production, but the view
        // must never crash the app over a registry build failure — render what we have.
        registry = { list: () => [] } as unknown as ContributionRegistry<unknown>;
    }
    const contributions = registry.list().map((m) => contributionToBlock(m as ListableContribution));

    let tracks: readonly PostTurnTrack<unknown>[];
    try {
        tracks = postTurnTracks.list() as unknown as readonly PostTurnTrack<unknown>[];
    } catch {
        tracks = [];
    }
    const trackBlocks = tracks.map(trackToBlock);

    return { tier, contributions, tracks: trackBlocks };
}