import { Settings, PanelLeftOpen, PanelLeftClose, Trash2 } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { TokenGauge } from './TokenGauge';

export function Header() {
    const { toggleSettings, toggleDrawer, drawerOpen, clearChat } = useAppStore();

    return (
        <header className="h-12 bg-surface border-b border-border flex items-center px-4 gap-2 shrink-0">
            <button
                onClick={toggleDrawer}
                className="text-text-dim hover:text-terminal transition-colors p-1"
                title={drawerOpen ? 'Close context drawer' : 'Open context drawer'}
            >
                {drawerOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
            </button>

            <h1 className="text-terminal text-sm font-bold tracking-[0.3em] uppercase glow-green shrink-0">
                AI GM COCKPIT
            </h1>

            <TokenGauge />

            <button
                onClick={clearChat}
                className="text-text-dim hover:text-danger transition-colors p-1"
                title="Clear chat history"
            >
                <Trash2 size={16} />
            </button>

            <button
                onClick={toggleSettings}
                className="text-text-dim hover:text-terminal transition-colors p-1"
                title="Settings"
            >
                <Settings size={18} />
            </button>
        </header>
    );
}
