import { Settings, PanelLeftOpen, PanelLeftClose, Trash2, LogOut, Users, Cpu } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { TokenGauge } from './TokenGauge';
import { saveCampaignState } from '../store/campaignStore';

export function Header() {
    const {
        toggleSettings,
        toggleDrawer,
        toggleNPCLedger,
        drawerOpen,
        clearChat,
        activeCampaignId,
        setActiveCampaign,
        context,
        messages,
        condenser,
        settings,
        setActivePreset,
    } = useAppStore();

    const handleExit = async () => {
        // Save current state before exiting
        if (activeCampaignId) {
            await saveCampaignState(activeCampaignId, { context, messages, condenser });
        }
        setActiveCampaign(null);
    };

    return (
        <header className="h-12 bg-surface border-b border-border flex items-center px-2 sm:px-4 gap-1 sm:gap-2 shrink-0">
            <button
                onClick={toggleDrawer}
                className="text-text-dim hover:text-terminal transition-colors p-1"
                title={drawerOpen ? 'Close context drawer' : 'Open context drawer'}
            >
                {drawerOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
            </button>

            <h1 className="hidden md:block text-terminal text-sm font-bold tracking-[0.3em] uppercase glow-green shrink-0">
                AI GM COCKPIT
            </h1>

            <div className="hidden md:flex flex-1 items-center gap-4">
                <TokenGauge />
                {/* Preset Switcher */}
                <div className="flex items-center gap-2 text-xs">
                    <Cpu size={14} className="text-text-dim" />
                    <select
                        value={settings.activePresetId}
                        onChange={(e) => setActivePreset(e.target.value)}
                        className="bg-void border border-border text-text-primary px-2 py-1 rounded focus:outline-none focus:border-terminal max-w-[150px] truncate"
                        title="Active AI Preset"
                    >
                        {settings.presets.map(p => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                    </select>
                </div>
            </div>

            <button
                onClick={clearChat}
                className="text-text-dim hover:text-danger transition-colors p-1"
                title="Clear chat history"
            >
                <Trash2 size={16} />
            </button>

            <button
                onClick={toggleNPCLedger}
                className="text-text-dim hover:text-terminal transition-colors p-1"
                title="NPC Ledger"
            >
                <Users size={18} />
            </button>

            <button
                onClick={toggleSettings}
                className="text-text-dim hover:text-terminal transition-colors p-1"
                title="Settings"
            >
                <Settings size={18} />
            </button>

            <button
                onClick={handleExit}
                className="text-text-dim hover:text-ember transition-colors p-1 ml-1"
                title="Exit campaign"
            >
                <LogOut size={16} />
            </button>
        </header>
    );
}

