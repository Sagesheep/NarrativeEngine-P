/**
 * Phase 3.2 — the event map, typed against `EVENTS.md` §6.
 *
 * Twenty core events, six families. **The names are permanent** (`EVENTS.md`
 * header): they are the most-referenced part of any extension API, every mod
 * hard-codes them, and Phase 9.2 freezes them. Adding an event is additive;
 * renaming or removing one is not.
 *
 * The payload rule (`EVENTS.md` §3):
 *
 * > A payload carries the identity of what changed, plus any value observable
 * > only at that instant. It never carries a collection the mod can read from
 * > `ctx.data`, never a host-internal type, and never a credential, provider
 * > config, or endpoint.
 *
 * Which is why every payload below is a **shallow record of scalars and scalar
 * arrays** — no `ChatMessage`, no `GatheredContext`, no `AppSettings`. That is
 * what makes containment `Object.freeze` on the record plus its array fields
 * rather than `hostFacade.ts`'s deep `cloneAndFreeze` walk, and it is why
 * `settings.changed` carries **key names only**: `AppSettings.providers` holds
 * `EndpointConfig` records with API keys in them, and a "the new settings"
 * payload would hand every native mod the user's credentials through a channel
 * `CONTRACT.md`'s permanent prohibition closes everywhere else.
 *
 * `SceneStakes` is the one host type on the surface (`EVENTS.md` §6) — a string
 * union with no structure to freeze or refactor behind.
 */

import type { AiTier, SceneStakes } from '../../../types';

/**
 * `EVENTS.md` §6. Field names and types are frozen by 9.2; new **optional**
 * fields are additive, an existing field never changes shape or meaning, and an
 * event never becomes cancellable (§4.1).
 */
export interface ModEvents {
    // §6.1 app
    'app.ready': { readonly modIds: readonly string[]; readonly faultCount: number; readonly replayed?: true };
    'app.modsChanged': { readonly modIds: readonly string[]; readonly faultCount: number };

    // §6.2 campaign
    'campaign.opened': { readonly campaignId: string; readonly replayed?: true };
    'campaign.closing': { readonly campaignId: string; readonly nextCampaignId: string | null };

    // §6.3–6.6 turn
    'turn.start': { readonly turnId: string; readonly campaignId: string | null; readonly playerInput: string; readonly tier: AiTier | undefined };
    'turn.payloadBuilt': { readonly turnId: string; readonly campaignId: string | null; readonly messageCount: number; readonly tokenEstimate: number };
    'turn.generated': { readonly turnId: string; readonly campaignId: string | null; readonly messageId: string; readonly text: string; readonly sceneStakes: SceneStakes };
    'turn.aborted': { readonly turnId: string; readonly campaignId: string | null; readonly messageId: string };
    'turn.failed': { readonly turnId: string; readonly campaignId: string | null; readonly messageId: string; readonly reason: string };
    'turn.committed': { readonly turnId: string | null; readonly campaignId: string; readonly messageId: string; readonly sceneId: string };
    'turn.commitFailed': { readonly turnId: string | null; readonly campaignId: string; readonly messageId: string };

    // §6.7 message
    'message.swiped': { readonly campaignId: string; readonly messageId: string; readonly index: number; readonly total: number; readonly generated: boolean };
    'message.continued': { readonly campaignId: string; readonly messageId: string; readonly addedText: string };
    'message.edited': { readonly campaignId: string; readonly messageId: string; readonly role: 'user' | 'assistant' | 'system' | 'tool'; readonly pending: boolean };
    'message.deleted': { readonly campaignId: string; readonly messageIds: readonly string[] };

    // §6.5 archive
    'archive.sceneAppended': { readonly campaignId: string; readonly sceneId: string; readonly messageId: string | null };
    'archive.chapterSealed': { readonly campaignId: string; readonly chapterId: string; readonly title: string; readonly trigger: 'auto' | 'manual' };

    // §6.8 settings
    'settings.changed': { readonly changedKeys: readonly string[] };
    'settings.tierChanged': { readonly tier: AiTier | undefined; readonly previous: AiTier | undefined };
    'settings.presetChanged': { readonly presetId: string; readonly name: string };
}

export type CoreEventName = keyof ModEvents;

/**
 * A mod's own event, always `mod.<modId>.<name>` (`EVENTS.md` §2). The prefix is
 * stamped by the host from the emitting context's identity, never taken from an
 * argument — which is what makes the impersonation check free of an allow-list:
 *
 * > A core event name never begins with `mod.`. A mod event always does.
 */
export type ModScopedEventName = `mod.${string}`;

export type AnyEventName = CoreEventName | ModScopedEventName;

/** A mod event's payload obeys the same shallow-record rule (§4.5). */
export type ModEventPayload = Readonly<Record<string, unknown>>;

export type PayloadFor<E extends AnyEventName> = E extends CoreEventName ? ModEvents[E] : ModEventPayload;

/**
 * `EVENTS.md` §5.2 — one argument, the frozen payload. No context is passed: a
 * listener that needs current host state uses the `ctx` it closed over. **The
 * return value is ignored**, including a returned promise (§4.1) — the bus is
 * observational, and an emit never waits.
 */
export type ModEventListener<E extends AnyEventName = AnyEventName> = (payload: PayloadFor<E>) => void;

/**
 * The complete core name set, in `EVENTS.md` §6 order. Used by the impersonation
 * check (a mod may not emit a core name) and by 4.9.4's ordering fixture.
 */
export const CORE_EVENT_NAMES: readonly CoreEventName[] = [
    'app.ready',
    'app.modsChanged',
    'campaign.opened',
    'campaign.closing',
    'turn.start',
    'turn.payloadBuilt',
    'turn.generated',
    'turn.aborted',
    'turn.failed',
    'turn.committed',
    'turn.commitFailed',
    'message.swiped',
    'message.continued',
    'message.edited',
    'message.deleted',
    'archive.sceneAppended',
    'archive.chapterSealed',
    'settings.changed',
    'settings.tierChanged',
    'settings.presetChanged',
] as const;

const CORE_EVENT_NAME_SET: ReadonlySet<string> = new Set(CORE_EVENT_NAMES);

export function isCoreEventName(name: string): name is CoreEventName {
    return CORE_EVENT_NAME_SET.has(name);
}

/**
 * `EVENTS.md` §4.4 — the only two sticky events, named explicitly. They describe
 * a *condition that is currently true* rather than a moment that has passed, and
 * the cold-start race is real: `App.tsx` fires `refreshMods()` (which runs every
 * mod's `activate`) and hydrates the restored campaign in **two independent
 * effects with no ordering between them**. Without replay, whether a mod sees
 * the `campaign.opened` for the campaign that was already open when it activated
 * is a coin-flip.
 *
 * Everything else is fire-and-forget: a listener that was not subscribed does
 * not learn what it missed. This is not a general mechanism.
 */
export const STICKY_EVENT_NAMES: readonly CoreEventName[] = ['app.ready', 'campaign.opened'] as const;

const STICKY_EVENT_NAME_SET: ReadonlySet<string> = new Set(STICKY_EVENT_NAMES);

export function isStickyEventName(name: string): boolean {
    return STICKY_EVENT_NAME_SET.has(name);
}
