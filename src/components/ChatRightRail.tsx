import {
    Component,
    type CSSProperties,
    type PointerEvent as ReactPointerEvent,
    type ReactNode,
    useEffect,
    useRef,
    useState,
    useSyncExternalStore,
} from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
    readRailPanels,
    subscribeToRegion,
    unregisterRailPanel,
    type RegisteredRailPanel,
} from '../services/mods/mounts/mountRegistry';
import { formatMountFaultReason, mountFaultStore } from '../services/mods/mounts/mountFaults';
import { RailPanelSwitcher } from './rail/RailPanelSwitcher';

const RAIL_STORAGE_KEY = 'nn_chat_rail';
const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 240;
const MAX_WIDTH = 640;

interface RailPreferences {
    readonly width: number;
    readonly collapsed: boolean;
    /** MOUNTS.md ?8.7: a qualified `mod.<modId>.<panelId>` id. */
    readonly activePanelId: string | null;
}

function clampWidth(value: number): number {
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));
}

function readPreferences(): RailPreferences {
    if (typeof window === 'undefined') {
        return { width: DEFAULT_WIDTH, collapsed: false, activePanelId: null };
    }
    try {
        const parsed = JSON.parse(localStorage.getItem(RAIL_STORAGE_KEY) ?? '{}') as Partial<RailPreferences>;
        return {
            width: typeof parsed.width === 'number' && Number.isFinite(parsed.width)
                ? clampWidth(parsed.width)
                : DEFAULT_WIDTH,
            collapsed: parsed.collapsed === true,
            activePanelId: typeof parsed.activePanelId === 'string' ? parsed.activePanelId : null,
        };
    } catch {
        return { width: DEFAULT_WIDTH, collapsed: false, activePanelId: null };
    }
}

function persistPreferences(preferences: RailPreferences): void {
    try {
        localStorage.setItem(RAIL_STORAGE_KEY, JSON.stringify(preferences));
    } catch {
        // Storage can be unavailable in a private or restricted renderer. The
        // current session remains usable; persistence is best-effort.
    }
}

function useRailPanels(): readonly RegisteredRailPanel[] {
    return useSyncExternalStore(
        (listener) => subscribeToRegion('chat.rail', listener),
        readRailPanels,
        readRailPanels,
    );
}

function messageFor(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function reportRailFault(panel: RegisteredRailPanel, error: unknown): void {
    mountFaultStore.add({
        modId: panel.mod.id,
        file: `mod:${panel.mod.id}`,
        region: 'chat.rail',
        kind: 'threw',
        entryId: panel.entryId,
        reason: formatMountFaultReason({
            modName: panel.mod.name,
            region: 'chat.rail',
            kind: 'threw',
            entryId: panel.entryId,
            message: messageFor(error),
        }),
    });
}

interface RailPanelBoundaryProps {
    readonly panel: RegisteredRailPanel;
    readonly children: ReactNode;
}

interface RailPanelBoundaryState {
    readonly failed: boolean;
}

/** Per-panel containment: a faulty native mount cannot take down the chat. */
class RailPanelBoundary extends Component<RailPanelBoundaryProps, RailPanelBoundaryState> {
    state: RailPanelBoundaryState = { failed: false };

    static getDerivedStateFromError(): RailPanelBoundaryState {
        return { failed: true };
    }

    componentDidCatch(error: Error): void {
        reportRailFault(this.props.panel, error);
        unregisterRailPanel(this.props.panel.qualifiedId);
    }

    render(): ReactNode {
        return this.state.failed ? null : this.props.children;
    }
}

function ImperativeRailPanel({ panel, active }: { readonly panel: RegisteredRailPanel; readonly active: boolean }) {
    const nodeRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const node = nodeRef.current;
        if (!node) return;

        let cleanup: (() => void) | undefined;
        try {
            const result = panel.panel.mount(node, panel.context);
            cleanup = typeof result === 'function' ? result : undefined;
        } catch (error) {
            reportRailFault(panel, error);
            unregisterRailPanel(panel.qualifiedId);
            return;
        }

        return () => {
            try {
                cleanup?.();
            } catch (error) {
                // Cleanup is best-effort; the host still discards the node.
                console.warn(`[mods] chat.rail cleanup failed for ${panel.qualifiedId}:`, error);
            }
            node.replaceChildren();
        };
    }, [panel]);

    return (
        <div hidden={!active} aria-hidden={!active} className="h-full min-h-0 overflow-auto">
            <div ref={nodeRef} className="min-h-full" />
        </div>
    );
}

function RailPanelMount({ panel, active }: { readonly panel: RegisteredRailPanel; readonly active: boolean }) {
    return (
        <RailPanelBoundary panel={panel}>
            <ImperativeRailPanel panel={panel} active={active} />
        </RailPanelBoundary>
    );
}

/**
 * Host-owned `chat.rail` dock. It is rendered only while at least one mod has
 * claimed the region, preserving App's zero-mod layout byte-for-byte.
 */
export function ChatRightRail() {
    const panels = useRailPanels();
    const [preferences, setPreferences] = useState<RailPreferences>(readPreferences);

    const updatePreferences = (patch: Partial<RailPreferences>) => {
        setPreferences((current) => {
            const next = { ...current, ...patch };
            persistPreferences(next);
            return next;
        });
    };

    const firstPanel = panels[0];
    const activePanelId = firstPanel && panels.some((panel) => panel.qualifiedId === preferences.activePanelId)
        ? preferences.activePanelId!
        : firstPanel?.qualifiedId ?? null;

    useEffect(() => {
        if (activePanelId && preferences.activePanelId !== activePanelId) {
            persistPreferences({
                width: preferences.width,
                collapsed: preferences.collapsed,
                activePanelId,
            });
        }
    }, [activePanelId, preferences.activePanelId, preferences.collapsed, preferences.width]);

    if (!firstPanel || !activePanelId) return null;

    const activePanel = panels.find((panel) => panel.qualifiedId === activePanelId) ?? firstPanel;

    const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = preferences.width;
        const onMove = (move: PointerEvent) => {
            updatePreferences({ width: clampWidth(startWidth + startX - move.clientX) });
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, { once: true });
    };


    return (
        <aside
            data-chat-rail
            className={preferences.collapsed
                ? 'fixed right-0 top-0 z-40 h-0 w-0 overflow-visible bg-transparent md:static md:flex md:h-auto md:w-8 md:flex-col md:overflow-hidden md:border-l md:border-border md:bg-surface md:shrink-0'
                : 'fixed inset-0 z-50 flex w-full flex-col overflow-hidden border-l border-border bg-surface md:static md:z-auto md:w-[var(--chat-rail-width)] md:shrink-0'}
            style={{ '--chat-rail-width': `${clampWidth(preferences.width)}px` } as CSSProperties}
        >
            {preferences.collapsed && (
                <button
                    type="button"
                    data-chat-rail-toggle
                    onClick={() => updatePreferences({ collapsed: false })}
                    className="fixed right-2 top-14 z-40 flex h-8 w-8 items-center justify-center border border-border bg-surface text-text-dim hover:border-terminal hover:text-terminal md:static md:h-full md:w-full md:items-start md:pt-3 md:hover:bg-void-lighter"
                    aria-label="Open mod rail"
                    title="Open mod rail"
                >
                    <ChevronLeft size={15} />
                </button>
            )}
            <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize mod rail"
                onPointerDown={beginResize}
                className={`absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize ${preferences.collapsed ? 'hidden' : 'hidden md:block'}`}
            />
            <header className={`${preferences.collapsed ? 'hidden' : 'flex'} shrink-0 items-center justify-between border-b border-border px-3 py-2`}>
                <h2 className="chrome-label min-w-0 truncate text-[10px] font-bold uppercase tracking-[0.2em] text-terminal">
                    {panels.length === 1 ? activePanel.panel.title : 'Mod panels'}
                </h2>
                <button
                    type="button"
                    onClick={() => updatePreferences({ collapsed: true })}
                    className="ml-2 flex h-6 w-6 shrink-0 items-center justify-center text-text-dim hover:bg-void-lighter hover:text-terminal"
                    aria-label="Collapse mod rail"
                    title="Collapse mod rail"
                >
                    <ChevronRight size={15} />
                </button>
            </header>

            {!preferences.collapsed && (
                <RailPanelSwitcher
                    panels={panels}
                    activePanelId={activePanelId}
                    onSelect={(qualifiedId) => updatePreferences({ activePanelId: qualifiedId })}
                />
            )}

            <section hidden={preferences.collapsed} className="min-h-0 flex-1">
                {panels.map((panel) => (
                    <RailPanelMount key={panel.qualifiedId} panel={panel} active={panel.qualifiedId === activePanelId} />
                ))}
            </section>
        </aside>
    );
}
