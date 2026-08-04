/**
 * Phase 2.4 â€” reactive reads.
 *
 * The public mod surface is snapshot based, so a subscription must hand out a
 * new snapshot on every notification. This module contains the small amount
 * of lifecycle bookkeeping needed to make that safe: notifications are
 * coalesced into one microtask, equality is value based, and every listener
 * can be revoked by mod id or campaign id.
 */

export type ReactiveStoreLike = {
    getState: () => Record<string, unknown>;
    subscribe: (listener: () => void) => () => void;
};

export type ReactiveReadListener = (value: unknown) => void;

export interface ReactiveReadHub {
    subscribe(key: string, listener: ReactiveReadListener, initialValue: unknown): () => void;
    invalidate(key?: string, value?: unknown): void;
    dispose(): void;
    getListenerCount(key?: string): number;
}

export interface ReactiveReadHubOptions {
    readonly store?: ReactiveStoreLike;
    readonly getValue: (key: string) => unknown;
    readonly getCampaignId: () => string | null;
    readonly onCampaignChange?: (campaignId: string | null) => void;
}

interface Subscription {
    readonly key: string;
    readonly listener: ReactiveReadListener;
    lastValue: unknown;
    active: boolean;
}

const objectTag = (value: unknown): string => Object.prototype.toString.call(value);

/** Structural comparison for JSON-shaped campaign data. */
export function reactiveValuesEqual(left: unknown, right: unknown, seen = new WeakMap<object, object>()): boolean {
    if (Object.is(left, right)) return true;
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
    if (objectTag(left) !== objectTag(right)) return false;

    const leftObject = left as Record<string, unknown>;
    const rightObject = right as Record<string, unknown>;
    const prior = seen.get(leftObject);
    if (prior === rightObject) return true;
    seen.set(leftObject, rightObject);

    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
        return left.every((value, index) => reactiveValuesEqual(value, right[index], seen));
    }

    const leftKeys = Object.keys(leftObject);
    const rightKeys = Object.keys(rightObject);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightObject, key)
        && reactiveValuesEqual(leftObject[key], rightObject[key], seen));
}

export function createReactiveReadHub(options: ReactiveReadHubOptions): ReactiveReadHub {
    const subscriptions = new Set<Subscription>();
    let sourceUnsubscribe: (() => void) | undefined;
    let disposed = false;
    let flushQueued = false;
    let lastCampaignId = options.getCampaignId();
    const pendingValues = new Map<string, unknown>();

    const detachSource = (): void => {
        sourceUnsubscribe?.();
        sourceUnsubscribe = undefined;
    };

    const flush = (): void => {
        flushQueued = false;
        if (disposed) return;

        const campaignId = options.getCampaignId();
        if (campaignId !== lastCampaignId) {
            const previousCampaignId = lastCampaignId;
            // Campaign data is not portable between campaigns. Revoke every
            // lease before a new campaign can deliver a stale value.
            for (const subscription of [...subscriptions]) {
                subscription.active = false;
                subscriptions.delete(subscription);
            }
            pendingValues.clear();
            options.onCampaignChange?.(previousCampaignId);
            lastCampaignId = campaignId;
            detachSource();
            return;
        }
        const keys = new Set([...subscriptions].map((subscription) => subscription.key));
        for (const key of keys) {
            const value = pendingValues.has(key) ? pendingValues.get(key) : options.getValue(key);
            pendingValues.delete(key);
            for (const subscription of [...subscriptions]) {
                if (!subscription.active || subscription.key !== key) continue;
                if (reactiveValuesEqual(subscription.lastValue, value)) continue;
                subscription.lastValue = value;
                // The context wrapper records the mod fault. This outer guard
                // still prevents a raw facade subscriber from breaking a turn.
                try {
                    subscription.listener(value);
                } catch {
                    // Deliberately contained. A mod callback is never allowed
                    // to abort a store write or a turn.
                }
            }
        }

        if (subscriptions.size === 0) detachSource();
    };

    const queueFlush = (): void => {
        if (disposed || flushQueued) return;
        flushQueued = true;
        queueMicrotask(flush);
    };

    const ensureSource = (): void => {
        if (sourceUnsubscribe || !options.store) return;
        sourceUnsubscribe = options.store.subscribe(queueFlush);
    };

    const hub: ReactiveReadHub = {
        subscribe(key, listener, initialValue) {
            if (disposed) return () => undefined;
            const subscription: Subscription = {
                key,
                listener,
                lastValue: initialValue,
                active: true,
            };
            subscriptions.add(subscription);
            ensureSource();
            return () => {
                if (!subscription.active) return;
                subscription.active = false;
                subscriptions.delete(subscription);
                if (subscriptions.size === 0) {
                    pendingValues.clear();
                    detachSource();
                }
            };
        },
        invalidate(key, value) {
            if (disposed) return;
            if (key !== undefined && arguments.length >= 2) pendingValues.set(key, value);
            queueFlush();
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            flushQueued = false;
            pendingValues.clear();
            for (const subscription of subscriptions) subscription.active = false;
            subscriptions.clear();
            detachSource();
        },
        getListenerCount: (key?: string) => key === undefined
            ? subscriptions.size
            : [...subscriptions].filter((subscription) => subscription.key === key).length,
    };

    return hub;
}

type TrackedSubscription = {
    readonly modId: string;
    readonly campaignId: string | null;
    readonly unsubscribe: () => void;
};

const tracked = new Set<TrackedSubscription>();

/** Track a context subscription so teardown is host-enforced. */
export function trackModSubscription(
    modId: string,
    campaignId: string | null,
    unsubscribe: () => void,
): () => void {
    const record: TrackedSubscription = { modId, campaignId, unsubscribe };
    tracked.add(record);
    let active = true;
    return () => {
        if (!active) return;
        active = false;
        tracked.delete(record);
        unsubscribe();
    };
}

export function disposeModSubscriptions(modId: string): number {
    const records = [...tracked].filter((record) => record.modId === modId);
    for (const record of records) {
        tracked.delete(record);
        record.unsubscribe();
    }
    return records.length;
}

export function disposeCampaignSubscriptions(campaignId: string | null): number {
    const records = [...tracked].filter((record) => record.campaignId === campaignId);
    for (const record of records) {
        tracked.delete(record);
        record.unsubscribe();
    }
    return records.length;
}

export function disposeAllModSubscriptions(): number {
    const records = [...tracked];
    for (const record of records) {
        tracked.delete(record);
        record.unsubscribe();
    }
    return records.length;
}

export function getTrackedModSubscriptionCount(modId?: string): number {
    return [...tracked].filter((record) => modId === undefined || record.modId === modId).length;
}
