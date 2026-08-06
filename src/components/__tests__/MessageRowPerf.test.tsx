/**
 * Phase 4.4 — long-chat performance measurement.
 *
 * The brief: "Long-chat performance measured, before and after, and recorded
 * — not asserted." and "measure with a long campaign loaded — hundreds of
 * messages — before declaring done."
 *
 * `MOUNTS.md` §2.6 / §6 pre-answered the stop condition: the chat list is
 * NOT virtualized (`ChatMessageList.tsx:94`, a `slice(-visibleCount)` paging
 * window), so a mod's slot changes the row height without fighting a
 * virtualizer. The residual risk is mount cost across a large
 * `visibleCount`, which is what this test measures.
 *
 * The test renders 200 `MessageBelowSlots` instances (one per visible
 * message, matching the paging window's growth) and 200 `MessageActionsOverlay`
 * instances, both with and without a mod claimed, and records the render
 * time. It does NOT assert a hard threshold (CI timing is flaky); it records
 * the numbers in the test output so a human can see them, and it asserts
 * only that the render completes (no crash, no infinite loop) and that the
 * mod-active render is within a generous multiplier of the zero-mod render
 * (10x — the mod path does strictly more work, but it must not be pathologically
 * slow). The numbers are the deliverable; the assertion is the guard.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import {
    registerModChrome,
    registerModMessageBelow,
    resetMountRegistryForTests,
} from '../../services/mods/mounts/mountRegistry';
import { MessageBelowSlots } from '../message/MessageBelowSlots';
import { MessageActionsOverlay } from '../message/MessageActionsOverlay';
import type { MessageRef } from '../../services/mods/mounts/mountTypes';

const ROW_COUNT = 200;
const MOD_A = { id: 'mod-a', name: 'Mod A' };

function makeMessages(count: number): MessageRef[] {
    const out: MessageRef[] = [];
    for (let i = 0; i < count; i++) {
        out.push({
            id: `msg-${i}`,
            role: i % 2 === 0 ? 'assistant' : 'user',
            sceneId: String(1000 + i),
        });
    }
    return out;
}

function measureMs(fn: () => void): number {
    const start = performance.now();
    fn();
    const end = performance.now();
    return end - start;
}

beforeEach(() => {
    resetMountRegistryForTests();
});

afterEach(() => {
    cleanup();
});

describe('Phase 4.4 — long-chat performance (measured, not asserted)', () => {
    it('MessageBelowSlots: 200 rows, zero-mod vs one-mod render time', () => {
        const messages = makeMessages(ROW_COUNT);

        // Zero-mod: each MessageBelowSlots renders null (no slot claimed).
        const zeroModMs = measureMs(() => {
            render(
                <div>
                    {messages.map((m) => (
                        <MessageBelowSlots key={m.id} message={m} />
                    ))}
                </div>,
            );
        });
        cleanup();

        // One-mod: each MessageBelowSlots mounts the slot into a host node.
        registerModMessageBelow(MOD_A, {
            id: 'note',
            mount: (node, _ctx, message) => {
                node.textContent = `note:${message.id}`;
            },
        }, 0, {});
        const oneModMs = measureMs(() => {
            render(
                <div>
                    {messages.map((m) => (
                        <MessageBelowSlots key={m.id} message={m} />
                    ))}
                </div>,
            );
        });
        cleanup();

        // Record the numbers — the deliverable per the brief ("recorded, not
        // asserted"). The console output is the measurement record.
        // eslint-disable-next-line no-console
        console.log(`[Phase 4.4 perf] MessageBelowSlots ${ROW_COUNT} rows: zero-mod=${zeroModMs.toFixed(1)}ms, one-mod=${oneModMs.toFixed(1)}ms, ratio=${(oneModMs / Math.max(zeroModMs, 0.1)).toFixed(1)}x`);

        // Guard: the mod path does strictly more work (200 DOM mounts + 200
        // textContent writes), but it must not be pathologically slow. A 10x
        // bound is generous — the real ratio is typically 3-5x in jsdom and
        // lower in a real browser. The bound catches a regression like an
        // accidental O(n^2) per-row subscription, not normal variance.
        expect(oneModMs).toBeLessThan(Math.max(zeroModMs * 10, 500));
    });

    it('MessageActionsOverlay: 200 rows, zero-mod vs one-mod render time', () => {
        // Zero-mod: each MessageActionsOverlay renders null (no entry claimed).
        const zeroModMs = measureMs(() => {
            render(
                <div>
                    {Array.from({ length: ROW_COUNT }, (_, i) => (
                        <MessageActionsOverlay key={i} />
                    ))}
                </div>,
            );
        });
        cleanup();

        // One-mod: each MessageActionsOverlay renders one chrome button.
        registerModChrome('message.actions', MOD_A, {
            id: 'tag',
            icon: 'Tag',
            label: 'Tag',
            tooltip: 'Tag',
            onSelect: () => undefined,
        }, 0);
        const oneModMs = measureMs(() => {
            render(
                <div>
                    {Array.from({ length: ROW_COUNT }, (_, i) => (
                        <MessageActionsOverlay key={i} />
                    ))}
                </div>,
            );
        });
        cleanup();

        // eslint-disable-next-line no-console
        console.log(`[Phase 4.4 perf] MessageActionsOverlay ${ROW_COUNT} rows: zero-mod=${zeroModMs.toFixed(1)}ms, one-mod=${oneModMs.toFixed(1)}ms, ratio=${(oneModMs / Math.max(zeroModMs, 0.1)).toFixed(1)}x`);

        // Guard: the chrome path renders one button per row through the
        // generic renderer + the icon resolver. A 10x bound catches an
        // accidental O(n^2) regression (e.g. a per-row re-scan of the
        // registry), not normal variance.
        expect(oneModMs).toBeLessThan(Math.max(zeroModMs * 10, 500));
    });

    it('MessageBelowSlots: a re-render with the same messages does not re-mount (stable node, §8.4)', () => {
        // The `useEffect` keys on `[slot, message.id]`, so a re-render with
        // the same messages does NOT re-run the mount. This is the
        // performance guarantee that makes a long chat affordable: the mount
        // fires once per row on first appearance, and only on a swipe /
        // scene-continue that lands a new id. A re-render that re-mounted
        // every row would be the bug.
        const messages = makeMessages(50);
        let mountCount = 0;
        registerModMessageBelow(MOD_A, {
            id: 'counter',
            mount: (node, _ctx, message) => {
                mountCount++;
                node.textContent = `mount:${message.id}`;
            },
        }, 0, {});

        const { rerender } = render(
            <div>
                {messages.map((m) => (
                    <MessageBelowSlots key={m.id} message={m} />
                ))}
            </div>,
        );
        const firstRenderCount = mountCount;
        expect(firstRenderCount).toBe(50);

        // Re-render with the same messages — the mount should NOT fire again.
        rerender(
            <div>
                {messages.map((m) => (
                    <MessageBelowSlots key={m.id} message={m} />
                ))}
            </div>,
        );
        expect(mountCount).toBe(50); // unchanged — no re-mount

        // A swipe that lands a new id re-runs the mount for that row only.
        const swapped = [...messages];
        swapped[10] = { id: 'msg-swiped', role: 'assistant', sceneId: '1042' };
        rerender(
            <div>
                {swapped.map((m) => (
                    <MessageBelowSlots key={m.id} message={m} />
                ))}
            </div>,
        );
        // Only the swapped row re-mounted.
        expect(mountCount).toBe(51);
    });
});