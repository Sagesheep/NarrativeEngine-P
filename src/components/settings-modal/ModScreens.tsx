/**
 * WO-P5-17 / WO-P5-18 — render declared screens inside Extensions.
 *
 * The screen host owns the message boundary. This component supplies only
 * the declaring mod's validated table declarations and namespaced table
 * callbacks; no general app-store accessor crosses into the frame.
 */
import { useCallback, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ValidatedMod } from '../../services/mods/modTypes';
import { ModScreenHost } from './ModScreenHost';

export function ModScreens({ mods }: { mods: readonly ValidatedMod[] }) {
    /**
     * Which screens are currently expanded.
     *
     * A screen is COLLAPSED until asked for. A mod screen can be a whole
     * application — the skill-tree editor asks the host for 660px — and
     * Extensions is a settings page the user came to for checkboxes. Rendering
     * every declared screen at full height on tab open buries the rest of the
     * page behind mod UI, and does it worse with every mod installed.
     */
    const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(() => new Set());

    /**
     * Every screen expanded at least once this mount.
     *
     * A collapsed screen stays MOUNTED-BUT-HIDDEN rather than unmounting. The
     * frame owns edits the host has not seen yet (the skill-tree editor
     * debounces its table write by 400ms), so tearing it down on collapse would
     * drop whatever landed inside that window. Never-opened screens are not
     * mounted at all, so an unopened screen costs nothing.
     */
    const [mountedKeys, setMountedKeys] = useState<ReadonlySet<string>>(() => new Set());

    const toggleScreen = useCallback((key: string) => {
        setOpenKeys((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
        setMountedKeys((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    }, []);

    const entries: Array<{
        modId: string;
        modName: string;
        screen: ValidatedMod['screens'][number];
        source: string;
        mod: ValidatedMod;
    }> = [];
    for (const mod of mods) {
        if (!Array.isArray(mod.screens) || !Array.isArray(mod.screenSources)) continue;
        for (let index = 0; index < mod.screens.length; index += 1) {
            const source = mod.screenSources[index];
            if (typeof source !== 'string' || source.length === 0) continue;
            entries.push({
                modId: mod.id,
                modName: mod.name,
                screen: mod.screens[index],
                source,
                mod,
            });
        }
    }

    if (entries.length === 0) return null;

    return (
        <div className="space-y-4">
            <div>
                <label className="chrome-label block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
                    Mod screens
                </label>
                <p className="text-[9px] text-text-dim leading-tight max-w-[420px]">
                    Screens declared by installed mods. Each screen renders in an isolated frame with no access to the app's DOM, storage, or network. Open one to load it.
                </p>
            </div>
            {entries.map(({ modId, modName, screen, source, mod }) => {
                const key = `${modId}.${screen.id}`;
                const open = openKeys.has(key);
                const mounted = mountedKeys.has(key);
                const bodyId = `mod-screen-body-${key}`;
                return (
                    <div
                        key={key}
                        className="bg-void border border-border rounded overflow-hidden"
                        data-mod-screen={modId}
                    >
                        <button
                            type="button"
                            onClick={() => toggleScreen(key)}
                            aria-expanded={open}
                            aria-controls={bodyId}
                            className="w-full flex items-center gap-2 p-3 text-left hover:bg-void-lighter transition-colors"
                        >
                            <ChevronRight
                                size={12}
                                className={`shrink-0 text-text-dim transition-transform ${open ? 'rotate-90' : ''}`}
                            />
                            <span className="chrome-label text-[10px] text-text-primary uppercase tracking-wider font-bold">
                                {modName}
                            </span>
                            <span className="text-[9px] text-text-dim">·</span>
                            <span className="text-[10px] text-text-dim">{screen.label ?? screen.id}</span>
                            <span className="ml-auto shrink-0 text-[9px] uppercase tracking-widest text-text-dim/70">
                                {open ? 'Collapse' : 'Open'}
                            </span>
                        </button>
                        {/* Mounted on first open and kept mounted thereafter — `hidden`
                          * rather than unmounted, so collapsing never discards an edit the
                          * frame has not yet written back. */}
                        {mounted && (
                            <div id={bodyId} className={open ? 'px-3 pb-3' : 'hidden'}>
                                <ModScreenHost
                                    mod={mod}
                                    screen={screen}
                                    source={source}
                                />
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
