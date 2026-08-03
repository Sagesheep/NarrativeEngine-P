import { useState, useSyncExternalStore, type ComponentType } from 'react';
import { BookOpen, Puzzle, Sparkles, X } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { getLastModLoad, subscribeModLoad } from '../services/mods/modBootstrap';
import type { ModScreenLaunch, ValidatedMod, ValidatedModScreen } from '../services/mods/modTypes';
import { ModScreenHost } from './settings-modal/ModScreenHost';

export interface HeaderModLaunch {
    key: string;
    mod: ValidatedMod;
    screen: ValidatedModScreen;
    source: string;
    launch: ModScreenLaunch;
}

export function resolveHeaderModLaunches(
    mods: readonly ValidatedMod[],
    moduleEnabled: Readonly<Record<string, boolean>> | undefined,
): HeaderModLaunch[] {
    const launches: HeaderModLaunch[] = [];
    for (const mod of mods) {
        if (moduleEnabled?.[`mod.${mod.id}`] === false) continue;
        for (let index = 0; index < mod.screens.length; index += 1) {
            const screen = mod.screens[index];
            const source = mod.screenSources[index];
            if (screen.launch?.surface !== 'header' || typeof source !== 'string' || !source) continue;
            launches.push({
                key: `${mod.id}.${screen.id}`,
                mod,
                screen,
                source,
                launch: screen.launch,
            });
        }
    }
    return launches;
}

const ICONS: Record<NonNullable<ModScreenLaunch['icon']>, ComponentType<{ size?: number }>> = {
    sparkles: Sparkles,
    'book-open': BookOpen,
    puzzle: Puzzle,
};

/** Generic header shortcuts requested by installed, enabled module screens. */
export function ModHeaderLaunchers() {
    const { mods } = useSyncExternalStore(subscribeModLoad, getLastModLoad, getLastModLoad);
    const moduleEnabled = useAppStore((state) => state.settings.moduleEnabled);
    const launches = resolveHeaderModLaunches(mods, moduleEnabled);
    const [openKey, setOpenKey] = useState<string | null>(null);
    const open = launches.find((entry) => entry.key === openKey);

    return (
        <>
            {launches.map((entry) => {
                const Icon = ICONS[entry.launch.icon ?? 'puzzle'];
                return (
                    <button
                        key={entry.key}
                        type="button"
                        onClick={() => setOpenKey(entry.key)}
                        className="chrome-label flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                        title={entry.launch.label}
                        aria-label={`Open ${entry.launch.label}`}
                        data-mod-launch={entry.key}
                    >
                        <Icon size={13} />
                        <span className="hidden sm:inline">{entry.launch.label}</span>
                    </button>
                );
            })}

            {open && (
                <div
                    className="fixed inset-0 z-[100] bg-black/75 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6"
                    role="dialog"
                    aria-modal="true"
                    aria-label={open.screen.label ?? open.launch.label}
                    data-mod-launch-dialog={open.key}
                >
                    <div className="w-full max-w-7xl max-h-[94vh] overflow-auto bg-surface border border-border rounded shadow-2xl">
                        <div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-3 bg-surface border-b border-border">
                            <Sparkles size={15} className="text-terminal" />
                            <div className="min-w-0">
                                <div className="chrome-label text-[11px] text-text-primary uppercase tracking-wider font-bold truncate">
                                    {open.mod.name}
                                </div>
                                <div className="text-[9px] text-text-dim">Module screen · campaign-owned data</div>
                            </div>
                            <button
                                type="button"
                                onClick={() => setOpenKey(null)}
                                className="ml-auto flex items-center justify-center w-8 h-8 rounded-sm border border-border/40 hover:border-terminal text-text-dim hover:text-terminal"
                                aria-label={`Close ${open.launch.label}`}
                            >
                                <X size={15} />
                            </button>
                        </div>
                        <div className="p-3">
                            <ModScreenHost mod={open.mod} screen={open.screen} source={open.source} />
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
