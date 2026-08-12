import { useMemo, useState, useSyncExternalStore } from 'react';
import {
    Archive, BookOpen, Brain, ChevronDown, ChevronRight, Database, FileText,
    MapPin, Pin, ScrollText, Sliders, Sparkles, UserCircle, Users, Workflow,
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import type { ContextScreenId } from '../store/slices/uiSlice';
import { RulesTab } from './context-drawer/RulesTab';
import { RulesManagerTab } from './context-drawer/RulesManagerTab';
import { LoreTab } from './context-drawer/LoreTab';
import { EnginesTab } from './context-drawer/EnginesTab';
import { ChapterTab } from './context-drawer/ChapterTab';
import { MemoryTab } from './context-drawer/MemoryTab';
import { ScreenLightbox } from './ScreenLightbox';
import {
    readRegion, subscribeToRegion, isHeaderStatusEntry,
    type RegisteredChromeEntry,
} from '../services/mods/mounts/mountRegistry';
import { resolveModText } from '../services/mods/mounts/chromeRenderers';
import { useTranslation } from '../i18n/useTranslation';

type GroupId = 'story' | 'world' | 'play' | 'mods';
type NavIcon = typeof ScrollText;

interface NavLeaf {
    id: string;
    label: string;
    icon: NavIcon;
    badge?: number;
    onSelect: () => void;
}

const CONTEXT_LEAVES: Record<ContextScreenId, Omit<NavLeaf, 'onSelect'>> = {
    sys: { id: 'sys', label: 'System Context', icon: ScrollText },
    'rules-mgr': { id: 'rules-mgr', label: 'Rules Manager', icon: Sliders },
    world: { id: 'world', label: 'Lore', icon: Database },
    eng: { id: 'eng', label: 'Engine Tuning', icon: Sparkles },
    chpt: { id: 'chpt', label: 'Chapters', icon: BookOpen },
    mem: { id: 'mem', label: 'Memory', icon: Brain },
};

const GROUPS: Array<{ id: GroupId; label: string; icon: NavIcon }> = [
    { id: 'story', label: 'Story', icon: FileText },
    { id: 'world', label: 'World', icon: Database },
    { id: 'play', label: 'Play', icon: Sparkles },
    { id: 'mods', label: 'Mods', icon: Workflow },
];

function useHeaderEntries(): readonly RegisteredChromeEntry[] {
    return useSyncExternalStore(
        (listener) => subscribeToRegion('header.actions', listener),
        () => readRegion('header.actions'),
        () => readRegion('header.actions'),
    );
}

function NavRow({ leaf }: { leaf: NavLeaf }) {
    const Icon = leaf.icon;
    return (
        <button
            type="button"
            onClick={leaf.onSelect}
            className="w-full flex items-center gap-2 px-4 py-2 text-left text-[11px] text-text-dim hover:text-terminal hover:bg-terminal/5 transition-colors"
        >
            <Icon size={14} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{leaf.label}</span>
            {leaf.badge !== undefined && (
                <span className="min-w-[18px] px-1.5 py-0.5 rounded-full bg-terminal/15 text-terminal text-[9px] font-mono text-center">
                    {leaf.badge}
                </span>
            )}
        </button>
    );
}

export function ContextNavigationDrawer() {
    const drawerOpen = useAppStore((s) => s.drawerOpen);
    const toggleDrawer = useAppStore((s) => s.toggleDrawer);
    const contextScreen = useAppStore((s) => s.contextScreen);
    const openContextScreen = useAppStore((s) => s.openContextScreen);
    const closeContextScreen = useAppStore((s) => s.closeContextScreen);
    const chaptersCount = useAppStore((s) => s.chapters.length);
    const npcCount = useAppStore((s) => s.npcLedger.length);
    const placesCount = useAppStore((s) => s.locationLedger.length);
    const pinnedCount = useAppStore((s) => s.pinnedExcerpts.length);
    const headerEntries = useHeaderEntries();
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState<Record<GroupId, boolean>>({
        story: true, world: true, play: true, mods: false,
    });

    const modEntries = useMemo(
        () => headerEntries.filter((entry) => entry.mod !== undefined && !isHeaderStatusEntry(entry)),
        [headerEntries],
    );
    const modCount = useMemo(() => new Set(modEntries.map((entry) => entry.mod?.id)).size, [modEntries]);
    const modT = t as unknown as (key: string, vars?: Record<string, string | number>) => string;

    const legacyLeaves: Record<GroupId, NavLeaf[]> = {
        story: [
            { ...CONTEXT_LEAVES.sys, onSelect: () => openContextScreen('sys') },
            { ...CONTEXT_LEAVES['rules-mgr'], onSelect: () => openContextScreen('rules-mgr') },
            { ...CONTEXT_LEAVES.chpt, badge: chaptersCount, onSelect: () => openContextScreen('chpt') },
            { ...CONTEXT_LEAVES.mem, onSelect: () => openContextScreen('mem') },
        ],
        world: [
            { id: 'npcs', label: 'NPCs', icon: Users, badge: npcCount, onSelect: () => useAppStore.getState().toggleNPCLedger() },
            { id: 'places', label: 'Places', icon: MapPin, badge: placesCount, onSelect: () => useAppStore.getState().toggleLocationLedger() },
            { ...CONTEXT_LEAVES.world, onSelect: () => openContextScreen('world') },
        ],
        play: [
            { id: 'character', label: 'Character', icon: UserCircle, onSelect: () => useAppStore.getState().togglePCPanel() },
            { id: 'pinned', label: 'Pinned', icon: Pin, badge: pinnedCount, onSelect: () => useAppStore.getState().togglePinnedMemories() },
            { ...CONTEXT_LEAVES.eng, onSelect: () => openContextScreen('eng') },
        ],
        mods: modEntries.map((entry) => ({
            id: entry.qualifiedId,
            label: resolveModText(entry.mod!.id, entry.entry.label, modT) ?? entry.mod!.name,
            icon: FileText,
            onSelect: () => { Promise.resolve(entry.entry.onSelect(entry.context)).catch(() => undefined); },
        })),
    };

    const screenContent = contextScreen === 'sys'
        ? <RulesTab onOpenManager={() => openContextScreen('rules-mgr')} />
        : contextScreen === 'rules-mgr'
            ? <RulesManagerTab onBack={() => openContextScreen('sys')} />
            : contextScreen === 'world'
                ? <LoreTab />
                : contextScreen === 'eng'
                    ? <EnginesTab />
                    : contextScreen === 'chpt'
                        ? <ChapterTab />
                        : contextScreen === 'mem'
                            ? <MemoryTab />
                            : null;
    const screenTitle = contextScreen ? CONTEXT_LEAVES[contextScreen].label : '';

    return (
        <>
            {drawerOpen && (
                <aside className="w-72 max-w-[85vw] bg-surface border-r border-border flex flex-col overflow-hidden shrink-0">
                    <div className="px-4 py-3 border-b border-border flex items-center justify-between shrink-0">
                        <h2 className="text-[11px] text-terminal uppercase tracking-[0.25em] font-bold">◆ CONTEXT</h2>
                        <button type="button" onClick={toggleDrawer} className="text-text-dim hover:text-terminal text-xs uppercase tracking-wider" title={t('header.drawer.close')} aria-label={t('header.drawer.close')}>×</button>
                    </div>
                    <nav aria-label="Context navigation" className="flex-1 overflow-y-auto py-2">
                        {GROUPS.map((group) => {
                            const GroupIcon = group.icon;
                            const isExpanded = expanded[group.id];
                            const groupBadge = group.id === 'mods' && modCount > 0 ? modCount : undefined;
                            return (
                                <section key={group.id}>
                                    <button
                                        type="button"
                                        onClick={() => setExpanded((current) => ({ ...current, [group.id]: !current[group.id] }))}
                                        className="w-full flex items-center gap-2 px-3 py-2 text-[10px] text-text-primary uppercase tracking-[0.18em] font-bold hover:text-terminal transition-colors"
                                        aria-expanded={isExpanded}
                                    >
                                        {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                                        <GroupIcon size={13} />
                                        <span className="flex-1 text-left">{group.label}</span>
                                        {groupBadge !== undefined && <span className="text-terminal font-mono">{groupBadge}</span>}
                                    </button>
                                    {isExpanded && <div className="pb-1">{legacyLeaves[group.id].map((leaf) => <NavRow key={leaf.id} leaf={leaf} />)}</div>}
                                </section>
                            );
                        })}
                        <div className="my-2 border-t border-border" />
                        <NavRow leaf={{ id: 'backups', label: 'Backups', icon: Archive, onSelect: () => useAppStore.getState().toggleBackupModal() }} />
                        <NavRow leaf={{ id: 'blocks', label: 'Blocks', icon: Workflow, onSelect: () => useAppStore.getState().toggleBlockView() }} />
                    </nav>
                </aside>
            )}
            {contextScreen && (
                <ScreenLightbox
                    title={screenTitle}
                    onClose={closeContextScreen}
                    width={contextScreen === 'eng' ? 'wide' : 'form'}
                >
                    {screenContent}
                </ScreenLightbox>
            )}
        </>
    );
}
