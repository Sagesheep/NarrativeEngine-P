/**
 * The Arc Engine runs ONE arc at a time.
 *
 * A second arc alongside the first is not a second story — both tick every
 * scene and both push a line into `[WORLD UNDERCURRENT]`, so the GM is handed
 * two unrelated systemic pressures to weave at once. `MAX_ACTIVE_ARCS = 3`
 * lived in `compute.js` and was read by NOTHING: `arcWorldState` never
 * consulted it, and the only description of it as a gate was a comment in the
 * host's `arcSpawn.ts` describing the automatic seam spawn that was deleted
 * when the button became the spawn gate. So every press stacked another arc.
 *
 * The gate is self-clearing: the tick flips a spent arc to `boiled_over` (it
 * finished climbing) or `defused` (crit-failed at rung 0 while opposed), and
 * neither is `active`. Nothing has to remember to release the button.
 *
 * These cases drive the REAL `mods/arc/index.js`. Each resets the module
 * registry first, because the gate's cached count is module state and would
 * otherwise leak between cases.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

interface ChromeStateish {
    readonly label?: string;
    readonly disabled?: boolean;
    readonly tooltip?: string;
}

interface Entry {
    onSelect: (ctx: unknown) => Promise<void>;
    state: () => ChromeStateish;
}

const LADDER = [
    { label: 'rung 0', surface: 'ambient' },
    { label: 'rung 1', surface: 'ambient' },
    { label: 'rung 2', surface: 'rumor' },
    { label: 'rung 3', surface: 'rumor' },
    { label: 'rung 4', surface: 'direct' },
];

const SPAWN_RESPONSE = JSON.stringify({
    title: 'Harbour squeeze',
    type: 'economic',
    seed: 'The harbour levy is being farmed out to a syndicate.',
    ladder: LADDER,
});

function activeArc(id = 'arc-1') {
    return {
        id, status: 'active', type: 'economic', title: 'Grain crisis',
        seed: 'seed', ladder: LADDER, currentRung: 1, tickDC: 35,
        stance: 'unaware', bornScene: '001', lastTickScene: '002',
    };
}

/**
 * Activate the real mod against a controllable arcs table. `rows` is live —
 * a case can change what the table holds between presses, which is how the
 * "enforce against the table, not the cache" assertion is made.
 */
async function activateArcMod(initialRows: unknown[]) {
    vi.resetModules();
    const mod = await import('../../../../mods/arc/index.js') as {
        onActivate: (ctx: unknown) => Promise<void>;
        onDisable: () => void;
    };

    const table = { rows: [...initialRows] };
    let modelCalls = 0;
    const listeners = new Map<string, () => void>();
    let entry: Entry | undefined;

    const liveCtx: Record<string, unknown> = {
        table: {
            read: async () => [...table.rows],
            write: async (_name: string, rows: unknown) => { table.rows = rows as unknown[]; },
        },
        data: {
            chapters: [],
            archiveIndex: [{ sceneId: '012' }],
            npcLedger: [],
            messages: [{ role: 'assistant', content: 'The harbour tolls have doubled again.' }],
        },
        model: {
            call: async () => { modelCalls += 1; return { content: SPAWN_RESPONSE }; },
        },
        log: () => undefined,
    };
    liveCtx.refresh = async () => liveCtx;

    await mod.onActivate({
        mounts: { composer: (e: Entry) => { entry = e; return { update: () => undefined, remove: () => undefined }; } },
        events: { on: (name: string, fn: () => void) => { listeners.set(name, fn); } },
        refresh: async () => liveCtx,
        log: () => undefined,
    });

    // `onActivate` kicks the first table read without awaiting it (the button
    // must register synchronously); let it land before anything is asserted.
    await vi.waitFor(() => expect(entry).toBeDefined());
    await Promise.resolve();
    await Promise.resolve();

    return {
        entry: entry as Entry,
        liveCtx,
        table,
        listeners,
        onDisable: mod.onDisable,
        modelCalls: () => modelCalls,
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('the arc mod runs one arc at a time', () => {
    it('greys the button out and says so while an arc is still climbing', async () => {
        const arc = await activateArcMod([activeArc()]);

        const state = arc.entry.state();
        expect(state.label).toBe('ARC ACTIVE');
        expect(state.disabled).toBe(true);
        // The label is four characters of explanation; the tooltip carries the
        // rest, which is why the composer renderer now honours it.
        expect(state.tooltip).toMatch(/already simmering/i);
    });

    it('refuses the press against the live table, without spending the LLM call', async () => {
        // The gate starts OPEN — the table was empty at activate.
        const arc = await activateArcMod([]);
        expect(arc.entry.state().disabled).toBeFalsy();

        // An arc appears behind the button's back (another window, or a tick
        // that landed between renders). The cached count still says zero.
        arc.table.rows = [activeArc()];

        await arc.entry.onSelect(arc.liveCtx);

        expect(arc.modelCalls()).toBe(0);
        expect(arc.table.rows).toHaveLength(1);
        expect(arc.entry.state().label).toBe('ARC ACTIVE');
    });

    it('closes the gate the moment a spawn lands', async () => {
        vi.useFakeTimers();
        const arc = await activateArcMod([]);

        await arc.entry.onSelect(arc.liveCtx);

        expect(arc.modelCalls()).toBe(1);
        expect(arc.table.rows).toHaveLength(1);

        // INJECTED holds for 1.6s, then the button settles into the gate
        // rather than back into an invitation to press again.
        await vi.advanceTimersByTimeAsync(1700);
        expect(arc.entry.state().label).toBe('ARC ACTIVE');
        expect(arc.entry.state().disabled).toBe(true);

        // A second press while gated spends nothing.
        await arc.entry.onSelect(arc.liveCtx);
        expect(arc.modelCalls()).toBe(1);
        expect(arc.table.rows).toHaveLength(1);
    });

    it('frees itself when the arc plays out — no press, no timer', async () => {
        const arc = await activateArcMod([activeArc()]);
        expect(arc.entry.state().disabled).toBe(true);

        // The tick walked the arc to the top of its ladder and spent it.
        arc.table.rows = [{ ...activeArc(), status: 'boiled_over' }];

        const onCommitted = arc.listeners.get('turn.committed');
        expect(onCommitted).toBeDefined();
        onCommitted!();

        await vi.waitFor(() => expect(arc.entry.state().disabled).toBeFalsy());
        expect(arc.entry.state().label).toBeUndefined();
    });

    it('re-reads the gate when a different campaign is opened', async () => {
        const arc = await activateArcMod([activeArc()]);
        expect(arc.entry.state().disabled).toBe(true);

        // Arcs are per-campaign; the next campaign has none.
        arc.table.rows = [];
        const onOpened = arc.listeners.get('campaign.opened');
        expect(onOpened).toBeDefined();
        onOpened!();

        await vi.waitFor(() => expect(arc.entry.state().disabled).toBeFalsy());
    });

    it('does not carry a stale gate across a disable/enable cycle', async () => {
        const arc = await activateArcMod([activeArc()]);
        expect(arc.entry.state().disabled).toBe(true);

        arc.onDisable();

        // A re-enable re-reads the table; the count must not survive the
        // teardown and grey out a fresh button against nothing.
        expect(arc.entry.state().disabled).toBeFalsy();
    });
});
