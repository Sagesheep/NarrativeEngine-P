/**
 * Phase 3.2 — the mod event bus.
 *
 * `EVENTS.md` (3.1) is the specification; this file is the whole of it that is
 * not an emit site. The bus is:
 *
 *   - **observational** (§4.1) — a listener's return value is ignored. There is
 *     no `preventDefault`, no `false` to stop propagation, no mutable payload,
 *     no way to reorder or suppress a later listener. The moment one event is
 *     cancellable, every emit site becomes a control-flow branch core must be
 *     correct about; interception is Phase 5.2's named hook, not this.
 *   - **synchronous and cheap** (§5.2) — no awaiting a listener inside the turn
 *     path. A returned promise is ignored like any other return value.
 *   - **native-tier** (§5.1) — a sandboxed compute mod neither subscribes nor
 *     emits. A one-shot Worker cannot hold a listener across turns and every
 *     call would be an RPC round-trip. A compute mod publishes to its own table
 *     and the native half reads it with `ctx.table.subscribe` (shipped in 2.4).
 *   - **additive to a running app** — with zero mods there are zero listeners,
 *     and an emit with zero listeners returns before it does any work. That is
 *     what keeps the Phase 0.2 base-app gate honest (§9.2): **emitting an event
 *     must not change what the app does.**
 *
 * Ordering (§4.2) is registration order — one ordered listener list per event,
 * invoked in insertion order. For every mod that subscribes in `activate` (what
 * the docs tell authors to do), registration order **is** the loader's resolved
 * load order, because `lifecycleHost` iterates mods in exactly that order. A mod
 * that subscribes late appends rather than re-sorting: with no cancellation and
 * frozen payloads, listener order is unobservable to a correct mod, so what is
 * published is **determinism**, not priority.
 *
 * Teardown (§5.4) is host-owned. Every subscription is attributed to the mod
 * whose context created it and the host removes them on disable — the mod is
 * never trusted to call `off`. Phase 4.9.4 will try deliberately to leak one.
 */

import type {
    AnyEventName,
    CoreEventName,
    ModEventListener,
    ModEventPayload,
    ModEvents,
    ModScopedEventName,
    PayloadFor,
} from './modEvents';
import { isCoreEventName, isStickyEventName } from './modEvents';
import type { EventFaultStore } from './eventFaults';
import { eventFaultStore, formatEventFaultReason } from './eventFaults';

/**
 * Who registered a listener, so teardown can find it and a fault can name it.
 * `file` is the mod's manifest filename — the key the Extensions fault list
 * dedups on (`ExtensionsTab.tsx`), which is why it travels with the owner
 * rather than being looked up at fault time.
 */
export interface ModEventOwner {
    readonly modId: string;
    readonly modName: string;
    readonly file: string;
}

interface Registration {
    readonly event: string;
    readonly listener: ModEventListener<never>;
    readonly originalListener?: ModEventListener<never>;
    readonly owner?: ModEventOwner;
    active: boolean;
}

export interface ModEventBus {
    /** Subscribe to a core event. Returns the unsubscribe handle. */
    on<E extends CoreEventName>(event: E, listener: (payload: ModEvents[E]) => void, owner?: ModEventOwner): () => void;
    /** Subscribe to a mod event by fully-qualified name (`mod.<id>.<name>`). */
    on(event: ModScopedEventName, listener: (payload: ModEventPayload) => void, owner?: ModEventOwner): () => void;
    /** Subscribe to a core event for a single invocation. */
    once<E extends CoreEventName>(event: E, listener: (payload: ModEvents[E]) => void, owner?: ModEventOwner): () => void;
    /** Subscribe to a mod event by fully-qualified name for a single invocation. */
    once(event: ModScopedEventName, listener: (payload: ModEventPayload) => void, owner?: ModEventOwner): () => void;
    /** Remove a listener by identity. The host-owned teardown path is `disposeModListeners`. */
    off(event: AnyEventName, listener: (payload: never) => void): void;
    /** Emit a core event. Never throws. */
    emit<E extends CoreEventName>(event: E, payload: ModEvents[E]): void;
    /**
     * Emit on a mod's behalf. The `mod.<id>.` prefix is stamped from `owner`,
     * never taken from the argument (§4.5) — which is the impersonation check,
     * with no allow-list to maintain.
     */
    emitFromMod(owner: ModEventOwner, name: string, payload: ModEventPayload): void;
    /** §5.4 — host-owned teardown. Returns how many listeners were removed. */
    disposeModListeners(modId: string): number;
    /** Drop every listener and every retained sticky payload. Test/reset seam. */
    reset(): void;
    /** 4.9.4's leak probe. Omit `event` for the total across all events. */
    getListenerCount(event?: AnyEventName): number;
    /** The retained sticky payload for `app.ready` / `campaign.opened`, if one has been emitted. */
    getRetained<E extends CoreEventName>(event: E): ModEvents[E] | undefined;
}

export interface ModEventBusOptions {
    readonly faultStore?: EventFaultStore;
}

/**
 * §3 consequence 2 — **`emit` freezes; it does not clone.** Because the payload
 * rule guarantees no nested mutable structure, containment is `Object.freeze` on
 * the record plus `Object.freeze` on any array-valued field: a bounded
 * operation, not `cloneAndFreeze`'s deep walk. A listener still cannot write to
 * host state through a payload, which is the invariant `hostFacade.ts:176`
 * established and this preserves.
 */
function freezePayload<T extends object>(payload: T): Readonly<T> {
    if (Object.isFrozen(payload)) return payload;
    for (const value of Object.values(payload)) {
        if (Array.isArray(value)) Object.freeze(value);
    }
    return Object.freeze(payload);
}

/** A mod tried to emit a name that is not its own. Names the mod and the name (§4.5). */
export class ModEventNameRejected extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = 'ModEventNameRejected';
    }
}

export function createModEventBus(options: ModEventBusOptions = {}): ModEventBus {
    const faults = options.faultStore ?? eventFaultStore;
    // One ordered list per event; insertion order is invocation order (§4.2).
    const registrations = new Map<string, Registration[]>();
    // §4.4 — retained payloads for the two sticky events only.
    const retained = new Map<string, object>();

    const invoke = (registration: Registration, payload: unknown): void => {
        try {
            // §4.1 — the return value is ignored, including a returned promise.
            (registration.listener as (value: unknown) => void)(payload);
        } catch (error) {
            // §5.3 — caught, recorded as a fault naming the mod and the event,
            // and the emit continues to the next listener. Per-listener
            // containment is what makes §4.3's two commit-path emits safe: no
            // listener can propagate an exception into `runArchiveTrack`'s
            // `try` and turn a successful append into `archived: false`.
            const message = error instanceof Error ? error.message : String(error);
            const owner = registration.owner;
            if (owner) {
                faults.add({
                    modId: owner.modId,
                    file: owner.file,
                    event: registration.event,
                    kind: 'threw',
                    reason: formatEventFaultReason({
                        modName: owner.modName,
                        event: registration.event,
                        message,
                    }),
                });
            } else {
                // A host-registered listener (a fixture, a test) has no mod to
                // name. Contained all the same — an emit never throws.
                console.warn(`[events] listener for "${registration.event}" threw:`, error);
            }
        }
    };

    const deliver = (event: string, payload: object): void => {
        const list = registrations.get(event);
        if (!list || list.length === 0) return;
        // Snapshot: a listener that subscribes or unsubscribes during delivery
        // must not change who receives THIS emit. Determinism (§4.2) is the
        // published guarantee and it has to survive re-entrancy.
        for (const registration of [...list]) {
            if (!registration.active) continue;
            invoke(registration, payload);
        }
    };

    const bus: ModEventBus = {
        on(event: AnyEventName, listener: (payload: never) => void, owner?: ModEventOwner): () => void {
            const registration: Registration = {
                event,
                listener: listener as ModEventListener<never>,
                owner,
                active: true,
            };
            const list = registrations.get(event);
            if (list) list.push(registration);
            else registrations.set(event, [registration]);

            // §4.4 — a late subscriber to a sticky event is invoked immediately
            // with the retained payload and `replayed: true`. This is what makes
            // "seed on first campaign" writable in one way that always works,
            // whether hydration won the cold-start race or lost it.
            const sticky = retained.get(event);
            if (sticky) {
                invoke(registration, freezePayload({ ...sticky, replayed: true as const }));
            }

            return () => {
                if (!registration.active) return;
                registration.active = false;
                const current = registrations.get(event);
                if (!current) return;
                const index = current.indexOf(registration);
                if (index !== -1) current.splice(index, 1);
                if (current.length === 0) registrations.delete(event);
            };
        },

        off(event: AnyEventName, listener: (payload: never) => void): void {
            const list = registrations.get(event);
            if (!list) return;
            const index = list.findIndex(
                (registration) => registration.listener === listener || registration.originalListener === listener,
            );
            if (index === -1) return;
            list[index].active = false;
            list.splice(index, 1);
            if (list.length === 0) registrations.delete(event);
        },

        once(event: AnyEventName, listener: (payload: never) => void, owner?: ModEventOwner): () => void {
            let unsub: () => void = () => {};
            const wrapper = (payload: never) => {
                unsub();
                (listener as (value: unknown) => void)(payload);
            };
            const registration: Registration = {
                event,
                listener: wrapper as ModEventListener<never>,
                originalListener: listener as ModEventListener<never>,
                owner,
                active: true,
            };
            const list = registrations.get(event);
            if (list) list.push(registration);
            else registrations.set(event, [registration]);

            const sticky = retained.get(event);
            if (sticky) {
                invoke(registration, freezePayload({ ...sticky, replayed: true as const }));
            }

            unsub = () => {
                if (!registration.active) return;
                registration.active = false;
                const current = registrations.get(event);
                if (!current) return;
                const index = current.indexOf(registration);
                if (index !== -1) current.splice(index, 1);
                if (current.length === 0) registrations.delete(event);
            };

            return unsub;
        },

        emit<E extends CoreEventName>(event: E, payload: ModEvents[E]): void {
            const sticky = isStickyEventName(event);
            const list = registrations.get(event);
            // §3 consequence 3 — **zero listeners costs nothing.** Return before
            // freezing when the event has no subscribers. This is what keeps the
            // turn path free and the Phase 0.2 gate honest.
            //
            // The two sticky events are the deliberate exception: retention IS
            // their behaviour, so they freeze and retain even with no listeners.
            // Both are two-field records emitted at most a handful of times per
            // session — the cost the early return exists to avoid is the
            // per-turn one, and neither of these is on the turn path.
            if (!sticky && (!list || list.length === 0)) return;
            const frozen = freezePayload({ ...payload } as object);
            if (sticky) retained.set(event, frozen);
            deliver(event, frozen);
        },

        emitFromMod(owner: ModEventOwner, name: string, payload: ModEventPayload): void {
            // §4.5 — the prefix comes from the context's identity, never from an
            // argument. A mod emits by bare name; the fully-qualified own name is
            // accepted as an alias. Anything else is rejected with a reason
            // naming the mod and the name.
            const ownPrefix = `mod.${owner.modId}.`;
            let qualified: string;
            if (name.startsWith(ownPrefix) && name.length > ownPrefix.length) {
                qualified = name;
            } else if (isCoreEventName(name)) {
                throw new ModEventNameRejected(
                    `${owner.modName}: cannot emit "${name}" — a core event name may only be emitted by the host`,
                );
            } else if (name.startsWith('mod.')) {
                throw new ModEventNameRejected(
                    `${owner.modName}: cannot emit "${name}" — a mod may only emit under its own "${ownPrefix}" prefix`,
                );
            } else if (name.trim() === '' || name.includes('.')) {
                throw new ModEventNameRejected(
                    `${owner.modName}: cannot emit "${name}" — a mod event name is a single camelCase segment`,
                );
            } else {
                qualified = `${ownPrefix}${name}`;
            }

            const list = registrations.get(qualified);
            if (!list || list.length === 0) return;
            // §4.5 — the payload rule applies to mod events too: same freeze,
            // same shallow-record discipline. A mod that hands another mod a live
            // object has created exactly the coupling the rule prevents.
            deliver(qualified, freezePayload({ ...payload }));
        },

        disposeModListeners(modId: string): number {
            let removed = 0;
            for (const [event, list] of [...registrations]) {
                const kept = list.filter((registration) => {
                    if (registration.owner?.modId !== modId) return true;
                    registration.active = false;
                    removed += 1;
                    return false;
                });
                if (kept.length === 0) registrations.delete(event);
                else if (kept.length !== list.length) registrations.set(event, kept);
            }
            return removed;
        },

        reset(): void {
            for (const list of registrations.values()) {
                for (const registration of list) registration.active = false;
            }
            registrations.clear();
            retained.clear();
        },

        getListenerCount(event?: AnyEventName): number {
            if (event !== undefined) return registrations.get(event)?.length ?? 0;
            let total = 0;
            for (const list of registrations.values()) total += list.length;
            return total;
        },

        getRetained<E extends CoreEventName>(event: E): ModEvents[E] | undefined {
            return retained.get(event) as ModEvents[E] | undefined;
        },
    };

    return bus;
}

/**
 * The bus the app uses. Module-level singleton, like `reactiveFaultStore` and
 * the lifecycle host's stores — a mod that subscribes in `activate` and the
 * emit site in `turnStages.ts` have to be talking about the same object.
 */
export const modEventBus: ModEventBus = createModEventBus();

/**
 * The emit seam for product code. One import, one call, and **it can never
 * throw into the caller** — an emit site sits in the middle of a turn stage, a
 * Zustand action or the durable commit path, and the prime directive for this
 * phase is that emitting an event must not change what the app does.
 *
 * Per-listener faults are already contained inside the bus; this guard covers
 * the residue (a payload that somehow resists freezing, a corrupted listener
 * list) so a defect in the bus itself still cannot cost a turn.
 */
export function emitCoreEvent<E extends CoreEventName>(event: E, payload: ModEvents[E]): void {
    try {
        modEventBus.emit(event, payload);
    } catch (error) {
        console.warn(`[events] emit of "${event}" failed:`, error);
    }
}

/**
 * `emitCoreEvent` for a site where BUILDING the payload is not free.
 *
 * `emit` already returns before freezing when nobody is listening (§3
 * consequence 3), but a call's arguments are evaluated before the call — so at a
 * site that has to walk the payload trace or sum a length, "zero listeners costs
 * nothing" needs the construction deferred too. One site uses this today
 * (`turn.payloadBuilt`); the other twenty-four build a record of values already
 * in hand and use `emitCoreEvent`.
 */
export function emitCoreEventLazy<E extends CoreEventName>(event: E, build: () => ModEvents[E]): void {
    try {
        if (modEventBus.getListenerCount(event) === 0) return;
        modEventBus.emit(event, build());
    } catch (error) {
        console.warn(`[events] emit of "${event}" failed:`, error);
    }
}

export type { PayloadFor };
