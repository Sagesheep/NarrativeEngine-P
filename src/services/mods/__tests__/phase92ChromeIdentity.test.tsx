/**
 * Phase 9.2 — the two `ChromeEntry` contract changes the freeze could not ship
 * without, both carried over from Checkpoint 3 (`PROGRESS.md`, 6.9.2 List 2
 * #1–#2 and List 3 #1–#2, routed there in so many words: *"a contract change,
 * so it is 9.2's call, not this checkpoint's"*).
 *
 *   1. **`onSelect` receives the mod's `ModContext`.** The shipped `.d.ts` has
 *      declared `onSelect(ctx: ModContext)` since 4.2; the host passed
 *      `undefined as never`. A mod that used the parameter instead of closing
 *      over its activate-time lease crashed on click. Nothing failed, because
 *      every fixture closed over its lease.
 *   2. **`message.actions` is message-scoped.** `onSelect` and `state()` now
 *      receive the `MessageRef` of the row the button was rendered on — the
 *      same `{ id, role, sceneId }` projection `message.below` already gets.
 *      Without it a rail that renders one button per message could only act on
 *      "the latest message", and `state()` was one object for the whole mod,
 *      so any row qualifying lit up every row.
 *
 * Both are asserted through the REAL registry and the REAL renderers, not the
 * types: a type says what the host promised, and the whole point of #1 is that
 * the promise and the behaviour had diverged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import {
    registerModChrome,
    readRegion,
    resetMountRegistryForTests,
    type RegisteredChromeEntry,
} from '../mounts/mountRegistry';
import {
    renderHeaderModEntry,
    renderComposerModEntry,
    renderMessageActionModEntry,
} from '../mounts/chromeRenderers';
import type { ChromeState, MessageRef, MountRegistryMod } from '../mounts/mountTypes';

const MOD: MountRegistryMod = { id: 'probe', name: 'Probe' };
const t = (key: string) => key;
const noDrain = () => Promise.resolve();
const lastGood = () => ({ current: undefined as ChromeState | undefined });

const ROW_A: MessageRef = { id: 'm-a', role: 'assistant', sceneId: 'scene-7' };
const ROW_B: MessageRef = { id: 'm-b', role: 'user', sceneId: 'scene-8' };

/** The single registered entry for a region, as the row component would read it. */
const only = (region: Parameters<typeof readRegion>[0]): RegisteredChromeEntry =>
    readRegion(region).find((e) => e.renderer === 'generic') as RegisteredChromeEntry;

beforeEach(() => {
    resetMountRegistryForTests();
});

afterEach(() => {
    cleanup();
    resetMountRegistryForTests();
});

describe('Phase 9.2 — onSelect receives the mod context', () => {
    it.each([
        ['header.actions', renderHeaderModEntry],
        ['composer.actions', renderComposerModEntry],
    ] as const)('%s hands the registered context to onSelect', (region, renderer) => {
        const seen: unknown[] = [];
        // A sentinel object, not a real ModContext: the assertion is identity —
        // "the thing registration was given is the thing the click delivers".
        const ctx = { sentinel: 'the mod context' };
        registerModChrome(region, MOD, {
            id: 'btn',
            icon: 'Tags',
            label: 'Probe',
            onSelect: (received) => { seen.push(received); },
        }, 0, ctx);

        render(<>{renderer(only(region), t, lastGood())}</>);
        fireEvent.click(screen.getByRole('button'));

        expect(seen).toHaveLength(1);
        expect(seen[0]).toBe(ctx);
    });

    it('message.actions hands the registered context to onSelect', async () => {
        const seen: unknown[] = [];
        const ctx = { sentinel: 'the mod context' };
        registerModChrome('message.actions', MOD, {
            id: 'btn',
            icon: 'Tags',
            label: 'Probe',
            onSelect: (received) => { seen.push(received); },
        }, 0, ctx);

        render(<>{renderMessageActionModEntry(only('message.actions'), t, lastGood(), noDrain, ROW_A)}</>);
        fireEvent.click(screen.getByRole('button'));
        // The click drains a pending commit before dispatching (§8.8), so the
        // dispatch is one microtask behind the event.
        await Promise.resolve();
        await Promise.resolve();

        expect(seen[0]).toBe(ctx);
    });

    it('the two mod-scoped rows receive no MessageRef — they are not message-scoped', () => {
        const seen: Array<MessageRef | undefined> = [];
        registerModChrome('header.actions', MOD, {
            id: 'btn',
            icon: 'Tags',
            label: 'Probe',
            onSelect: (_ctx, message) => { seen.push(message); },
        }, 0, {});

        render(<>{renderHeaderModEntry(only('header.actions'), t, lastGood())}</>);
        fireEvent.click(screen.getByRole('button'));

        expect(seen).toEqual([undefined]);
    });
});

describe('Phase 9.2 — message.actions is message-scoped (6.9.2 List 3 #1–#2)', () => {
    it('onSelect knows which row it was clicked on', async () => {
        const clicked: MessageRef[] = [];
        registerModChrome('message.actions', MOD, {
            id: 'mark',
            icon: 'Bookmark',
            label: 'Mark',
            onSelect: (_ctx, message) => { if (message) clicked.push(message); },
        }, 0, {});

        const entry = only('message.actions');
        // Two rows, the way the rail actually renders: one button per message.
        const { container } = render(
            <>
                <div key="a" data-row="a">{renderMessageActionModEntry(entry, t, lastGood(), noDrain, ROW_A)}</div>
                <div key="b" data-row="b">{renderMessageActionModEntry(entry, t, lastGood(), noDrain, ROW_B)}</div>
            </>,
        );

        const buttons = container.querySelectorAll('button');
        expect(buttons).toHaveLength(2);
        fireEvent.click(buttons[1]);
        await Promise.resolve();
        await Promise.resolve();

        // Before 9.2 this was unknowable: `onSelect` took the mod context only,
        // so a rail button could act on "the latest message" and nothing else.
        expect(clicked).toEqual([ROW_B]);
        expect(clicked[0].sceneId).toBe('scene-8');
    });

    it('state() is per row, so one marked message does not light up every button', () => {
        const marked = new Set(['m-b']);
        registerModChrome('message.actions', MOD, {
            id: 'mark',
            icon: 'Bookmark',
            label: 'Mark',
            onSelect: () => undefined,
            state: (message) => ({ active: message ? marked.has(message.id) : false }),
        }, 0, {});

        const entry = only('message.actions');
        const { container } = render(
            <>
                <span key="a">{renderMessageActionModEntry(entry, t, lastGood(), noDrain, ROW_A)}</span>
                <span key="b">{renderMessageActionModEntry(entry, t, lastGood(), noDrain, ROW_B)}</span>
            </>,
        );

        const buttons = [...container.querySelectorAll('button')];
        // `messageActionClasses`: active is a bare `text-terminal`; inactive is
        // `text-text-dim hover:text-terminal`. Split on whitespace rather than
        // substring-matching, or `hover:text-terminal` reads as active.
        const classes = buttons.map((b) => new Set(b.className.split(/\s+/)));
        expect(classes[0].has('text-terminal')).toBe(false);
        expect(classes[0].has('text-text-dim')).toBe(true);
        expect(classes[1].has('text-terminal')).toBe(true);
        expect(classes[1].has('text-text-dim')).toBe(false);
    });

    it('a state() that throws still renders from last good, with the ref in hand', () => {
        // The §8.6 containment must survive the new argument: a mod that throws
        // on an unexpected `message` shape must not blank the rail.
        registerModChrome('message.actions', MOD, {
            id: 'mark',
            icon: 'Bookmark',
            label: 'Mark',
            onSelect: () => undefined,
            state: () => { throw new Error('boom'); },
        }, 0, {});

        expect(() => render(
            <>{renderMessageActionModEntry(only('message.actions'), t, lastGood(), noDrain, ROW_A)}</>,
        )).not.toThrow();
        expect(screen.getByRole('button')).toBeTruthy();
    });

    it('an entry with no state() is unaffected by the new argument', () => {
        registerModChrome('message.actions', MOD, {
            id: 'mark', icon: 'Bookmark', label: 'Mark', onSelect: () => undefined,
        }, 0, {});
        expect(() => render(
            <>{renderMessageActionModEntry(only('message.actions'), t, lastGood(), noDrain, ROW_A)}</>,
        )).not.toThrow();
    });
});
