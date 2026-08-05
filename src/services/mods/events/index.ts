/**
 * Phase 3.2 — the mod event bus, one import for the whole surface.
 *
 * Product code needs exactly one thing from here: `emitCoreEvent`. Phase 3.3
 * adds `ctx.events` on top of `modEventBus`; Phase 4.9.4 uses `getListenerCount`
 * and `disposeModListeners` for its ordering and leak fixtures.
 *
 * Specification: `Upgrade/EPIC Project - Full Modularity/EVENTS.md`.
 */

export type {
    AnyEventName,
    CoreEventName,
    ModEventListener,
    ModEventPayload,
    ModEvents,
    ModScopedEventName,
    PayloadFor,
} from './modEvents';
export {
    CORE_EVENT_NAMES,
    STICKY_EVENT_NAMES,
    isCoreEventName,
    isStickyEventName,
} from './modEvents';

export type { ModEventBus, ModEventOwner } from './eventBus';
export {
    ModEventNameRejected,
    createModEventBus,
    emitCoreEvent,
    emitCoreEventLazy,
    modEventBus,
} from './eventBus';

export type { EventFaultRecord, EventFaultStore } from './eventFaults';
export {
    createEventFaultStore,
    eventFaultStore,
    formatEventFaultReason,
} from './eventFaults';
