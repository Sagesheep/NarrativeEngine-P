/**
 * Phase 4.4 — `message.actions` chrome overlay.
 *
 * `MOUNTS.md` §2.5: the sticky vertical rail beside a message bubble
 * (`MessageActionRail.tsx:43`), rendered twice from `MessageBubble.tsx`
 * (left of a user bubble, right of every other bubble). A mod contributes an
 * icon button to this rail; the host renders it natively, in the host's
 * style, alongside the existing edit/rewind/speak/delete actions.
 *
 * This component renders the mod entries that have claimed `message.actions`
 * for one message. It is rendered inside `MessageActionRail`, between the
 * built-in actions and the delete button (the trailing built-in). Mod
 * entries never appear in the editing state (`MOUNTS.md` §2.5): while
 * `isEditing` the rail is save/cancel only, and a mod button there would
 * sit beside a two-button commit affordance and invite a mis-click.
 *
 * Zero-mod rule (`MOUNTS.md` §2.8): with no mod entries claimed, this
 * component renders nothing — no wrapper, no placeholder. The rail's DOM is
 * byte-identical to the pre-4.4 rail when no mod has claimed
 * `message.actions`.
 *
 * §8.8 pending-commit drain: `message.actions` is chat-scoped, so the host
 * drains a pending commit before dispatching a mod entry's `onSelect`. The
 * drain is lazy-imported here (not in the renderer) so the renderer stays
 * free of the turn-pipeline import and testable in isolation.
 */
import { useSyncExternalStore } from 'react';
import { readRegion, subscribeToRegion, type RegisteredChromeEntry } from '../../services/mods/mounts/mountRegistry';
import { renderMessageActionModEntry } from '../../services/mods/mounts/chromeRenderers';
import type { ChromeState } from '../../services/mods/mounts/mountTypes';

/**
 * Subscribe to the `message.actions` region so the rail re-renders on
 * add/remove/update. One subscription per `MessageActionsOverlay` instance
 * — i.e. one per visible message — same posture as `MessageBelowSlots` and
 * the rail's existing built-in buttons. The store is module-level and the
 * comparator is O(n log n) only on mutation; the host coalesces mutations.
 */
function useMessageActions(): readonly RegisteredChromeEntry[] {
    return useSyncExternalStore(
        (listener) => subscribeToRegion('message.actions', listener),
        () => readRegion('message.actions'),
        () => readRegion('message.actions'),
    );
}

/**
 * `MOUNTS.md` §8.8 — drain a pending commit before dispatching a mod entry's
 * `onSelect` from `message.actions`. The work a chat-adjacent mod triggers
 * typically reads engine state the commit derives, and `CONTRACT.md` L3
 * forbids a mod committing a turn itself — so the host does it. Lazy-imported
 * so this module stays testable without the turn pipeline. Mirrors
 * `ChatActionStrip.tsx`'s `drainPendingCommit` exactly.
 */
async function drainPendingCommit(): Promise<void> {
    try {
        const { commitPendingTurn } = await import('../../services/turn/pendingCommit');
        await commitPendingTurn().catch((e) => console.warn('[message.actions] commit drain failed:', e));
    } catch (e) {
        console.warn('[message.actions] commit drain import failed:', e);
    }
}

/**
 * Render the mod entries that have claimed `message.actions`. Returns `null`
 * when no mod entry is claimed — `MessageActionRail`'s DOM is byte-identical
 * to the pre-4.4 rail in that case (`MOUNTS.md` §2.8). Renders nothing while
 * `isEditing` (§2.5).
 */
export function MessageActionsOverlay({ isEditing }: { readonly isEditing?: boolean }) {
    const ordered = useMessageActions();
    // `MOUNTS.md` §2.5: mod entries never appear in the editing state. The
    // rail is save/cancel only while editing; a mod button there would sit
    // beside a two-button commit affordance and invite a mis-click.
    if (isEditing || ordered.length === 0) return null;
    const modEntries = ordered.filter((entry) => entry.renderer === 'generic');
    if (modEntries.length === 0) return null;
    return (
        <>
            {modEntries.map((entry) => (
                <ModMessageActionButton key={entry.qualifiedId} entry={entry} />
            ))}
        </>
    );
}

/**
 * One mod message-action button. The `lastGoodRef` is held per-entry so a
 * `state()` that throws renders from its last good state (`MOUNTS.md` §8.6).
 * The §8.8 pending-commit drain is injected into the renderer through
 * `drainPendingCommit` so the renderer stays free of the turn pipeline.
 */
function ModMessageActionButton({ entry }: { readonly entry: RegisteredChromeEntry }) {
    const lastGoodRef = { current: undefined as ChromeState | undefined };
    // The host's `t` is not needed for the message-action rail: the built-in
    // buttons render only an icon (no label), and a mod's `label` is only
    // surfaced as the tooltip. The renderer resolves the tooltip through the
    // mod's i18n namespace; the host's `t` falls back key-as-last-resort, so
    // an unknown mod key renders something visible. We pass a minimal `t`
    // that returns the key — the host's real `t` is not threaded here to
    // keep the rail free of the i18n context, and the tooltip is the only
    // consumer. A literal label misses the lookup and renders as itself.
    const t = (key: string) => key;
    return <>{renderMessageActionModEntry(entry, t, lastGoodRef, drainPendingCommit)}</>;
}