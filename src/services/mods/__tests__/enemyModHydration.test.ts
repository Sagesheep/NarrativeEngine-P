// Phase 8.5 — the mod sees its migrated data, whatever order things happen in.
//
// ┌─ THE BUG THIS PINS ──────────────────────────────────────────────────────┐
// │ Found by opening a real campaign, not by a test: the compendium window    │
// │ showed an empty roster and a combat config that was NOT the one on disk,  │
// │ while the adopted table sat correctly migrated one layer away.            │
// │                                                                           │
// │ The mod hydrated with a one-shot `ctx.table.read` at activate. It         │
// │ activates before any campaign is open, so that read fails; the retry on   │
// │ `campaign.opened` could still land before the host finished hydrating     │
// │ `modTables`, and the facade then has neither a row to return nor a        │
// │ campaign id to fetch with. The mod kept its defaults and said nothing.    │
// │                                                                           │
// │ A migration whose data the mod cannot see is not a migration. This is the │
// │ half of Phase 8.5's "the data is intact" that lives on the client.        │
// └───────────────────────────────────────────────────────────────────────────┘
//
// The fix is `ctx.table.subscribe` (Phase 2.4) — the mechanism the reference
// mod built from the docs (`anno-mark`) uses for exactly this reason. These
// tests drive the mod's real `onActivate` against a stub context and assert
// the ORDER cannot break it.

import { describe, expect, it, beforeEach } from 'vitest';
import { enemyData, onActivate } from '../../../../public/bundled-mods/enemies/index.js';

type Listener = (rows: unknown) => void;

/**
 * A stub host: tables that start empty and can publish a row later, and a
 * `read` that throws the way the real facade does before a campaign is open.
 */
function makeCtx(options: { readThrows?: boolean } = {}) {
    const listeners = new Map<string, Listener[]>();
    const rows = new Map<string, unknown>();
    const events = new Map<string, Array<(payload: unknown) => void>>();

    return {
        ctx: {
            log: () => {},
            table: {
                read: async (name: string) => {
                    if (options.readThrows) throw new Error('[facade] no active campaign');
                    return rows.get(name);
                },
                write: async (name: string, value: unknown) => { rows.set(name, value); },
                subscribe: (name: string, listener: Listener) => {
                    const list = listeners.get(name) ?? [];
                    list.push(listener);
                    listeners.set(name, list);
                    return () => listeners.set(name, (listeners.get(name) ?? []).filter(l => l !== listener));
                },
            },
            events: {
                on: (name: string, handler: (payload: unknown) => void) => {
                    const list = events.get(name) ?? [];
                    list.push(handler);
                    events.set(name, list);
                    return () => undefined;
                },
            },
            mounts: {
                window: () => ({ open: () => {}, close: () => {}, update: () => {} }),
                header: () => ({ update: () => {}, remove: () => {} }),
            },
            data: { campaignId: null },
        },
        /** The host finishing its hydration and pushing a row to subscribers. */
        publish(name: string, value: unknown) {
            rows.set(name, value);
            for (const listener of listeners.get(name) ?? []) listener(value);
        },
        emit(name: string, payload: unknown) {
            for (const handler of events.get(name) ?? []) handler(payload);
        },
        subscriberCount: (name: string) => (listeners.get(name) ?? []).length,
    };
}

const MONSTERS = [
    { name: 'Goblin', stats: [{ name: 'HP', value: '7' }] },
    { name: 'Owlbear', stats: [{ name: 'HP', value: '59' }] },
];

beforeEach(async () => {
    // The mod holds module-level state; reset it between tests by hydrating
    // from an empty stub host.
    const empty = makeCtx();
    await onActivate(empty.ctx as never);
    empty.publish('compendium', []);
    empty.publish('config', null);
});

describe('the enemy mod picks up its tables however the cold start goes', () => {
    it('subscribes to all five tables, not just the one the header needs', async () => {
        const host = makeCtx();
        await onActivate(host.ctx as never);

        for (const table of ['compendium', 'instances', 'encounters', 'resolutions', 'config']) {
            expect(host.subscriberCount(table), `no subscription for "${table}"`).toBeGreaterThan(0);
        }
    });

    it('fills its state from a row the host publishes AFTER activation', async () => {
        // The failing order: activate with nothing available, host hydrates later.
        const host = makeCtx({ readThrows: true });
        await onActivate(host.ctx as never);
        expect(enemyData.getCompendium()).toEqual([]);

        host.publish('compendium', MONSTERS);

        expect(enemyData.getCompendium()).toHaveLength(2);
        expect(enemyData.getCompendium()[0].name).toBe('Goblin');
    });

    it('shows the migrated combat config rather than the defaults', async () => {
        // The exact divergence the real campaign showed: `promptContextEnabled`
        // is `false` on disk and `true` in DEFAULT_ENEMY_COMBAT_CONFIG, so a mod
        // that missed its table reports the opposite of the user's setting.
        const host = makeCtx({ readThrows: true });
        await onActivate(host.ctx as never);
        expect(enemyData.getCombatConfig().promptContextEnabled).toBe(true); // default

        host.publish('config', { promptContextEnabled: false, enemyDiscoveryEnabled: false, enabled: false });

        expect(enemyData.getCombatConfig().promptContextEnabled).toBe(false);
    });

    it('repairs published rows on the way in, exactly as a read would', async () => {
        const host = makeCtx();
        await onActivate(host.ctx as never);

        // A row shaped like something an old save actually holds: one good
        // record, one that is not an object at all, one missing its name.
        host.publish('compendium', [{ name: 'Ancient Record' }, null, { classification: 'no name' }]);

        const compendium = enemyData.getCompendium();
        // The unusable row is dropped rather than handed to the UI as `null`
        // — the UI reads `item.name` on every row (see `ui.js`), so a null here
        // is a window that will not open.
        expect(compendium.every((e: unknown) => e != null)).toBe(true);
        expect(compendium.every((e: { id: string }) => typeof e.id === 'string' && e.id.length > 0)).toBe(true);
        expect(compendium.every((e: { promptEnabled: boolean }) => e.promptEnabled === true)).toBe(true);
    });

    it('re-hydrates on campaign.opened without a stale campaign-id guard', async () => {
        // The guard used to be `if (campaignId !== ctx.data.campaignId) return`.
        // `ctx.data` is a snapshot from context-build time, when no campaign was
        // open — so the guard rejected the very event it was waiting for.
        const host = makeCtx();
        await onActivate(host.ctx as never);

        host.publish('compendium', MONSTERS);   // the host's hydration lands
        enemyData.getCompendium();

        host.emit('campaign.opened', { campaignId: 'some-other-id' });
        await Promise.resolve();
        await Promise.resolve();

        expect(enemyData.getCompendium()).toHaveLength(2);
    });
});
