/**
 * Phase 4.4 — `message.below` content mount.
 *
 * `MOUNTS.md` §2.6 / §8.3: a mod renders beneath (or above) a message's body.
 * This component renders the stacked `message.below` slots for one message.
 * It is rendered inside `MessageBubble`, below the prose block and the
 * attachment list, **above** the swipe/continue affordance and the debug
 * view (`MessageBubble.tsx:273-295`).
 *
 * The mount is imperative (`MOUNTS.md` §7): the host hands the mod a DOM
 * node and the mod fills it. The host owns the node, the error boundary,
 * and the teardown; the mod owns the interior. Each slot is mounted in its
 * own bounded container with `overflow` so a mod's annotation cannot push
 * the chat's scroll anchor (4.4 §3 — "the most likely user-visible bug").
 *
 * Zero-mod rule (`MOUNTS.md` §2.8): with no slots claimed, this component
 * renders nothing — no wrapper, no placeholder. `MessageBubble`'s DOM is
 * byte-identical to the pre-4.4 bubble when no mod has claimed
 * `message.below`.
 *
 * Performance (`MOUNTS.md` §2.6 / §5 / 4.4 §3): the chat list is NOT
 * virtualized (`ChatMessageList.tsx:94`, a `slice(-visibleCount)` paging
 * window), so a slot changes the row height without fighting a virtualizer.
 * The residual risk is mount cost across a large `visibleCount`, which is
 * why §5's budget is 1 slot per mod — one mount per mod per visible row. A
 * mod that needs the host to look again uses `ctx.subscribe` (Phase 2.4)
 * with ONE subscription for the whole mod, not one per row (4.4 §3 — "if
 * every message row opens its own subscription, a 500-message chat opens
 * 500. Design against that explicitly"). The `MessageRef` passed to `mount`
 * carries the per-message identity (id, role, sceneId) the mod needs to act
 * on that specific message.
 *
 * Mutation survival (4.4 §3 / `MOUNTS.md` §8.4): swipes, edits, deletions,
 * and scene-continue append all mutate messages. A slot is unmounted when
 * its message is deleted, and re-mounted when a swipe or scene-continue
 * replaces the body. The `useEffect` keys on `message.id` so a swipe that
 * lands a new id re-runs the mount; a swipe that mutates `content` in place
 * keeps the node (the mod's subscription drives its own update). A mod's
 * slot must therefore be safe to mount twice for the same `sceneId`.
 */
import {
    Component,
    type ReactNode,
    useEffect,
    useRef,
    useSyncExternalStore,
} from 'react';
import {
    readMessageBelowSlots,
    subscribeToRegion,
    unregisterMessageBelowSlot,
    type RegisteredMessageBelowSlot,
} from '../../services/mods/mounts/mountRegistry';
import { formatMountFaultReason, mountFaultStore } from '../../services/mods/mounts/mountFaults';
import type { MessageRef } from '../../services/mods/mounts/mountTypes';

/**
 * Subscribe to the `message.below` region so the row re-renders on
 * add/remove. `useSyncExternalStore` is the React 18+ primitive for
 * external stores; it re-renders on every `notifyRegion` call.
 *
 * One subscription per `MessageBelowSlots` component instance — i.e. one
 * per visible message. The store itself is module-level and the comparator
 * is O(n log n) only on mutation, so a 500-message chat holds 500 cheap
 * subscriptions to the same store, not 500 stores. The registry notifies
 * every listener on any mutation; the cost is the same as the rail's one
 * listener plus n-1 cheap wakeups, each of which reads the same snapshot.
 * This is the explicit design against the "500 subscriptions" trap: the
 * subscription is to the *region*, not to a per-message source, and the
 * host coalesces mutations.
 */
function useMessageBelowSlots(): readonly RegisteredMessageBelowSlot[] {
    return useSyncExternalStore(
        (listener) => subscribeToRegion('message.below', listener),
        readMessageBelowSlots,
        readMessageBelowSlots,
    );
}

function messageFor(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function reportSlotFault(slot: RegisteredMessageBelowSlot, error: unknown): void {
    mountFaultStore.add({
        modId: slot.mod.id,
        file: `mod:${slot.mod.id}`,
        region: 'message.below',
        kind: 'threw',
        entryId: slot.entryId,
        reason: formatMountFaultReason({
            modName: slot.mod.name,
            region: 'message.below',
            kind: 'threw',
            entryId: slot.entryId,
            message: messageFor(error),
        }),
    });
}

interface SlotBoundaryProps {
    readonly slot: RegisteredMessageBelowSlot;
    readonly children: ReactNode;
}

interface SlotBoundaryState {
    readonly failed: boolean;
}

/** Per-slot containment: a faulty native mount cannot take down the row. */
class SlotBoundary extends Component<SlotBoundaryProps, SlotBoundaryState> {
    state: SlotBoundaryState = { failed: false };

    static getDerivedStateFromError(): SlotBoundaryState {
        return { failed: true };
    }

    componentDidCatch(error: Error): void {
        reportSlotFault(this.props.slot, error);
        unregisterMessageBelowSlot(this.props.slot.qualifiedId);
    }

    render(): ReactNode {
        return this.state.failed ? null : this.props.children;
    }
}

/**
 * Mount one slot into a host-owned node. The node is stable for the life of
 * the mount (keyed on `message.id`); the host does not swap it on re-render.
 * The mod's `mount` receives the `MessageRef` (id, role, sceneId) so it can
 * act on that specific message.
 *
 * The `useEffect` keys on `[slot, message.id]` so a swipe or scene-continue
 * that lands a new message id re-runs the mount (the old node is discarded
 * with the old row). A mod that needs to react to in-place content mutation
 * does so through its own `ctx.subscribe` — the host does not re-run the
 * mount on every keystroke.
 */
function ImperativeSlot({
    slot,
    message,
}: {
    readonly slot: RegisteredMessageBelowSlot;
    readonly message: MessageRef;
}) {
    const nodeRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const node = nodeRef.current;
        if (!node) return;

        let cleanup: (() => void) | undefined;
        try {
            const result = slot.slot.mount(node, slot.context, message);
            cleanup = typeof result === 'function' ? result : undefined;
        } catch (error) {
            reportSlotFault(slot, error);
            unregisterMessageBelowSlot(slot.qualifiedId);
            return;
        }

        return () => {
            try {
                cleanup?.();
            } catch (error) {
                // Cleanup is best-effort; the host still discards the node.
                console.warn(`[mods] message.below cleanup failed for ${slot.qualifiedId}:`, error);
            }
            node.replaceChildren();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [slot, message.id]);

    // `overflow-hidden` bounds the mod's interior so a misbehaving annotation
    // cannot push the chat's scroll anchor (4.4 §3). `text-text-dim` and the
    // `mt-2` match the existing summary block's spacing
    // (`MessageBubble.tsx:240`), so a one-line annotation reads as a natural
    // extension of the bubble rather than a foreign surface.
    return <div ref={nodeRef} className="overflow-hidden text-text-dim" />;
}

function SlotMount({
    slot,
    message,
}: {
    readonly slot: RegisteredMessageBelowSlot;
    readonly message: MessageRef;
}) {
    return (
        <SlotBoundary slot={slot}>
            <ImperativeSlot slot={slot} message={message} />
        </SlotBoundary>
    );
}

/**
 * Render the stacked `message.below` slots for one message. Returns `null`
 * when no mod has claimed the region — `MessageBubble`'s DOM is
 * byte-identical to the pre-4.4 bubble in that case (`MOUNTS.md` §2.8).
 *
 * Stacked in `(loadIndex, withinModIndex)` order (`MOUNTS.md` §4.3 — stack,
 * not tabs: these are annotations, not panels). Each slot is in its own
 * bounded, error-boundaried container.
 */
export function MessageBelowSlots({ message }: { readonly message: MessageRef }) {
    const slots = useMessageBelowSlots();
    if (slots.length === 0) return null;
    return (
        <div className="mt-2 space-y-2">
            {slots.map((slot) => (
                <SlotMount key={slot.qualifiedId} slot={slot} message={message} />
            ))}
        </div>
    );
}