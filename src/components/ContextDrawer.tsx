import { useState } from 'react';
import { ScrollText, Database, Sparkles, Save, BookOpen } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { RulesTab } from './context-drawer/RulesTab';
import { LoreTab } from './context-drawer/LoreTab';
import { EnginesTab } from './context-drawer/EnginesTab';
import { BookkeepingTab } from './context-drawer/BookkeepingTab';
import { ChapterTab } from './context-drawer/ChapterTab';

const TABS = [
    { key: 'sys'   as const, Icon: ScrollText, label: 'System Context' },
    { key: 'world' as const, Icon: Database,   label: 'World Info' },
    { key: 'eng'   as const, Icon: Sparkles,   label: 'Engine Tuning' },
    { key: 'chpt'  as const, Icon: BookOpen,   label: 'Chapters' },
    { key: 'book'  as const, Icon: Save,       label: 'Bookkeeping' },
];

type TabKey = typeof TABS[number]['key'];

export function ContextDrawer() {
    const drawerOpen = useAppStore((s) => s.drawerOpen);
    const toggleDrawer = useAppStore((s) => s.toggleDrawer);
    const [activeTab, setActiveTab] = useState<TabKey>('sys');

    if (!drawerOpen) return null;

    return (
        <>
            {/* Mobile backdrop */}
            <div
                className="fixed inset-0 bg-overlay z-40 md:hidden"
                onClick={toggleDrawer}
            />
            <aside className="
                fixed inset-0 z-50 w-full bg-surface flex flex-col overflow-hidden animate-[slide-in-left_0.2s_ease-out]
                md:static md:w-80 md:z-auto md:border-r md:border-border md:shrink-0 md:animate-none
            ">
                {/* Header */}
                <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                    <h2 className="text-[11px] text-terminal uppercase tracking-[0.25em] font-bold glow-green">
                        ◆ CONTEXT BANK
                    </h2>
                    <button
                        onClick={toggleDrawer}
                        className="md:hidden text-text-dim hover:text-terminal text-xs uppercase tracking-wider"
                    >
                        ✕ Close
                    </button>
                </div>

                {/* Tab Bar */}
                <div className="flex border-b border-border shrink-0">
                    {TABS.map(({ key, Icon: TabIcon, label }) => (
                        <button
                            key={key}
                            onClick={() => setActiveTab(key)}
                            className={`flex-1 flex flex-col items-center gap-0.5 py-2 text-[9px] uppercase tracking-wider transition-colors ${
                                activeTab === key
                                    ? 'text-terminal border-b-2 border-terminal -mb-px'
                                    : 'text-text-dim hover:text-text-primary'
                            }`}
                            title={label}
                        >
                            <TabIcon size={13} />
                            {key.toUpperCase()}
                        </button>
                    ))}
                </div>

                {/* Tab Panels */}
                <div className="flex-1 overflow-y-auto">
                    {activeTab === 'sys' && <RulesTab />}
                    {activeTab === 'world' && <LoreTab />}
                    {activeTab === 'eng' && <EnginesTab />}
                    {activeTab === 'chpt' && <ChapterTab />}
                    {activeTab === 'book' && <BookkeepingTab />}
                </div>
            </aside>
        </>
    );
}
