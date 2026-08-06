/**
 * Phase 4.5 — the floating window manager UI layer.
 *
 * `MOUNTS.md` §2.7 / §4.4: a top-level layer in `App.tsx`'s campaign branch,
 * beside the modals at `:175-189`. The host owns the chrome — title bar,
 * drag, resize, z-order, focus, close, minimize, bounds clamping — and the
 * mod owns the interior.
 *
 * **Zero-mod rule (`MOUNTS.md` §2.8).** With no windows declared, this
 * component renders `null` — no wrapper, no hidden layer. The Phase 0.2 gate
 * is therefore unaffected; the zero-mod DOM is byte-identical to pre-4.5.
 *
 * **Escape (4.5 §3).** The app already standardised on Escape-closes for
 * full-bleed modals (`SettingsModal.tsx:43`, `BlockViewModal.tsx:38`,
 * `NPCLedgerModal.tsx:50`, …). The topmost focused floating window closes on
 * Escape, in that same convention — one Escape per press, top window only,
 * never the chat input's own Escape handling. The listener is attached at
 * `document` level only while at least one window is open, and it ignores
 * the event when the chat input or a contenteditable holds focus, so a mod's
 * window cannot trap keyboard focus away from the chat (4.5 §3).
 *
 * **Bounds clamp on app resize (4.5 §3).** A `window.resize` listener
 * re-clamps every open window into the new viewport, so windows cannot be
 * stranded off-canvas when the app window shrinks. Persistence writes the
 * clamped geometry so a reload lands the window on-screen.
 *
 * **Drag and resize.** Pointer events (not mousemove) so a drag or resize
 * keeps tracking when the pointer leaves the window — same primitive
 * `ChatRightRail` uses for its own resizer. The drag and resize handlers
 * capture the start position and the start geometry, then write
 * `setWindowGeometry` on move. The host does not let a mod set its own
 * z-index; clicking anywhere on a window raises it (`focusWindow`).
 */
import {
    type CSSProperties,
    type PointerEvent as ReactPointerEvent,
    useEffect,
    useRef,
    useSyncExternalStore,
} from 'react';
import { Minus, X } from 'lucide-react';
import {
    focusWindow,
    readOpenWindows,
    readWindowState,
    reclampAllWindows,
    setMinimized,
    setWindowGeometry,
    closeWindow,
    subscribeToWindows,
    type DeclaredWindow,
} from '../services/mods/mounts/windowStore';
import { formatMountFaultReason, mountFaultStore } from '../services/mods/mounts/mountFaults';

/** Read the open windows snapshot via `useSyncExternalStore`. */
function useOpenWindows(): readonly DeclaredWindow[] {
    return useSyncExternalStore(
        subscribeToWindows,
        readOpenWindows,
        readOpenWindows,
    );
}

/** Reactive subscription to a single window's runtime, so drag/resize/focus re-render. */
function useRuntime(qualifiedId: string) {
    // `useSyncExternalStore` requires a referentially-stable snapshot. Reading
    // `readWindowRuntime` directly would return a new object on every call
    // (the store's `getRuntime` builds a fresh object via the Map's values
    // iterator); instead, read the whole state once and look the runtime up
    // by id. The state object is referentially stable across mutations that
    // do not touch it (every mutation builds a new state object but only
    // swaps the slice that actually changed).
    const state = useSyncExternalStore(
        subscribeToWindows,
        readWindowState,
        readWindowState,
    );
    return state.open.get(qualifiedId) ?? null;
}

function messageFor(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function reportWindowFault(declared: DeclaredWindow, error: unknown): void {
    mountFaultStore.add({
        modId: declared.modId,
        file: `mod:${declared.modId}`,
        region: 'window.layer',
        kind: 'threw',
        entryId: declared.entryId,
        reason: formatMountFaultReason({
            modName: declared.modName,
            region: 'window.layer',
            kind: 'threw',
            entryId: declared.entryId,
            message: messageFor(error),
        }),
    });
}

/**
 * The mod's interior mount. The host hands the mod a stable DOM node and the
 * mod fills it; the host owns the node, the error boundary (here, in the
 * parent), and the teardown (`windowStore`'s `disableModWindows`). Mirrors
 * `ImperativeRailPanel` in `ChatRightRail.tsx` and `ImperativeSlot` in
 * `MessageBelowSlots.tsx`.
 *
 * The `useEffect` keys on `[declared]` so a mod's `mount` runs once per open
 * (the host does not re-run the mount on every drag/resize — the mod's own
 * `ctx.subscribe` is its update mechanism, per `MOUNTS.md` §7 rule 1).
 */
function WindowInterior({ declared }: { readonly declared: DeclaredWindow }) {
    const nodeRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const node = nodeRef.current;
        if (!node) return;

        let cleanup: (() => void) | undefined;
        try {
            const result = declared.declaration.mount(node, declared.context);
            cleanup = typeof result === 'function' ? result : undefined;
        } catch (error) {
            reportWindowFault(declared, error);
            closeWindow(declared.qualifiedId);
            return;
        }

        return () => {
            try {
                cleanup?.();
            } catch (error) {
                console.warn(`[mods] window.layer cleanup failed for ${declared.qualifiedId}:`, error);
            }
            node.replaceChildren();
        };
    }, [declared]);

    return (
        <div ref={nodeRef} className="min-h-0 flex-1 overflow-auto bg-surface text-text-primary" />
    );
}

interface WindowFrameProps {
    readonly declared: DeclaredWindow;
}

/**
 * One floating window. Renders the host chrome (title bar with title,
 * minimize, close; the resize handles) and the mod's interior. The whole
 * frame is a `position: absolute` box positioned by the runtime geometry;
 * `z-index` comes from the runtime z, which the host is the only thing that
 * sets (4.5 §3 — "Focus and z-order are the host's").
 */
function WindowFrame({ declared }: WindowFrameProps) {
    const runtime = useRuntime(declared.qualifiedId);
    // `runtime` is null only briefly, between a close and the parent's
    // re-render. The parent filters by open state so this branch is
    // defensive; render nothing rather than a window with no geometry.
    if (!runtime) return null;

    const style: CSSProperties = {
        left: runtime.x,
        top: runtime.y,
        width: runtime.width,
        height: runtime.minimized ? 'auto' : runtime.height,
        zIndex: runtime.z,
    };

    const onTitlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        // Don't start a drag when the press is on the close/minimize buttons.
        const target = event.target as HTMLElement;
        if (target.closest('[data-window-control]')) return;
        // Raise the window on click — focus is the host's (4.5 §3).
        focusWindow(declared.qualifiedId);
        event.preventDefault();

        const startX = event.clientX;
        const startY = event.clientY;
        const originX = runtime.x;
        const originY = runtime.y;
        const onMove = (move: PointerEvent) => {
            setWindowGeometry(declared.qualifiedId, {
                x: originX + (move.clientX - startX),
                y: originY + (move.clientY - startY),
            });
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, { once: true });
    };

    const onResizePointerDown = (edge: 'e' | 's' | 'se') => (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        if (!declared.resizable) return;
        focusWindow(declared.qualifiedId);
        event.preventDefault();
        event.stopPropagation();

        const startX = event.clientX;
        const startY = event.clientY;
        const originW = runtime.width;
        const originH = runtime.height;
        const onMove = (move: PointerEvent) => {
            const patch: { width?: number; height?: number } = {};
            if (edge === 'e' || edge === 'se') {
                patch.width = originW + (move.clientX - startX);
            }
            if (edge === 's' || edge === 'se') {
                patch.height = originH + (move.clientY - startY);
            }
            setWindowGeometry(declared.qualifiedId, patch);
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, { once: true });
    };

    const onClose = () => closeWindow(declared.qualifiedId);
    const onMinimize = () => setMinimized(declared.qualifiedId, !runtime.minimized);

    return (
        <div
            data-mod-window={declared.qualifiedId}
            data-mod-window-mod={declared.modId}
            className="absolute flex flex-col overflow-hidden border border-border bg-surface shadow-2xl"
            style={style}
            onPointerDown={() => focusWindow(declared.qualifiedId)}
            role="dialog"
            aria-label={declared.declaration.title}
        >
            <div
                onPointerDown={onTitlePointerDown}
                className="flex shrink-0 cursor-move items-center justify-between border-b border-border bg-void px-2 py-1 select-none"
            >
                <span className="chrome-label truncate text-[10px] font-bold uppercase tracking-[0.2em] text-terminal">
                    {declared.declaration.title}
                </span>
                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        data-window-control="minimize"
                        onClick={onMinimize}
                        className="flex h-5 w-5 items-center justify-center text-text-dim hover:bg-void-lighter hover:text-terminal"
                        aria-label={runtime.minimized ? 'Restore window' : 'Minimize window'}
                        title={runtime.minimized ? 'Restore' : 'Minimize'}
                    >
                        <Minus size={12} />
                    </button>
                    <button
                        type="button"
                        data-window-control="close"
                        onClick={onClose}
                        className="flex h-5 w-5 items-center justify-center text-text-dim hover:bg-danger hover:text-white"
                        aria-label="Close window"
                        title="Close"
                    >
                        <X size={12} />
                    </button>
                </div>
            </div>

            {!runtime.minimized && (
                <>
                    <WindowInterior declared={declared} />
                    {declared.resizable && (
                        <>
                            <div
                                onPointerDown={onResizePointerDown('e')}
                                className="absolute inset-y-0 right-0 w-1 cursor-ew-resize"
                                aria-hidden="true"
                            />
                            <div
                                onPointerDown={onResizePointerDown('s')}
                                className="absolute inset-x-0 bottom-0 h-1 cursor-ns-resize"
                                aria-hidden="true"
                            />
                            <div
                                onPointerDown={onResizePointerDown('se')}
                                className="absolute bottom-0 right-0 h-3 w-3 cursor-nwse-resize"
                                aria-hidden="true"
                            />
                        </>
                    )}
                </>
            )}
        </div>
    );
}

/**
 * The top-level floating window layer. Mount this once in `App.tsx`'s campaign
 * branch. Renders `null` when no window is open — the zero-mod DOM is
 * byte-identical to pre-4.5 (`MOUNTS.md` §2.8).
 *
 * Two document-level listeners while open:
 *
 *   1. **Escape** closes the focused window. Matches `SettingsModal.tsx:43`
 *      and its siblings; never fires while the chat input or a
 *      contenteditable holds focus, so a mod window cannot trap keyboard
 *      focus away from the chat (4.5 §3).
 *   2. **Resize** re-clamps every open window into the new viewport, so a
 *      shrunk app window cannot strand a floating window off-canvas (4.5 §3).
 */
export function WindowManager() {
    const open = useOpenWindows();

    // Escape closes the focused window (4.5 §3 — match the existing convention).
    useEffect(() => {
        if (open.length === 0) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            // Never steal Escape from the chat input or a contenteditable.
            const target = event.target as HTMLElement | null;
            if (target) {
                const tag = target.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
            }
            const focusedId = readWindowState().focusedId;
            if (!focusedId) return;
            event.preventDefault();
            closeWindow(focusedId);
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [open.length]);

    // Re-clamp every open window on app resize (4.5 §3).
    useEffect(() => {
        if (open.length === 0) return;
        const onResize = () => {
            reclampAllWindows({ width: window.innerWidth, height: window.innerHeight });
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, [open.length]);

    if (open.length === 0) return null;

    return (
        <div data-mod-window-layer className="pointer-events-none fixed inset-0 z-[200] overflow-hidden">
            {/* The layer container is `pointer-events-none` so the app below
                stays interactive; each window re-enables pointer events on
                its own box. This is how a floating window can sit over the
                chat without blocking the chat's clicks. */}
            {open.map((declared) => (
                <div key={declared.qualifiedId} className="pointer-events-auto">
                    <WindowFrame declared={declared} />
                </div>
            ))}
        </div>
    );
}
