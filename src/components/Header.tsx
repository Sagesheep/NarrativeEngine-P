import { Settings, PanelLeftOpen, PanelLeftClose, Trash2, LogOut, Users, Archive, Save } from 'lucide-react';
import { createBackup } from '../store/campaignStore';
import { flushAllPendingSaves } from '../store/slices/campaignSlice';
import { toast } from './Toast';
import { useAppStore } from '../store/useAppStore';
import { TokenGauge } from './TokenGauge';
import { saveCampaignState } from '../store/campaignStore';
import { API_BASE as API } from '../lib/apiBase';

export function Header() {
    const {
        toggleSettings,
        toggleDrawer,
        toggleNPCLedger,
        toggleBackupModal,
        drawerOpen,
        clearChat,
        activeCampaignId,
        setActiveCampaign,
        context,
        messages,
        condenser,
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
                aria-label={drawerOpen ? 'Close context drawer' : 'Open context drawer'}
            >
                {drawerOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
            </button>

            <h1 className="hidden md:block text-terminal text-sm font-bold tracking-[0.3em] uppercase glow-green shrink-0">
                Narrative Engine
            </h1>

            <div className="hidden md:flex flex-1 items-center gap-4">
                <TokenGauge />
            </div>

            <button
                onClick={async () => {
                    if (!activeCampaignId) return;
                    await flushAllPendingSaves();
                    const result = await createBackup(activeCampaignId, { trigger: 'manual', label: 'Manual backup' });
                    if (result?.skipped) {
                        toast.info('No changes since last backup');
                    } else if (result?.timestamp) {
                        toast.success('Backup created');
                    } else {
                        toast.error('Failed to create backup');
                    }
                }}
                className="text-text-dim hover:text-terminal transition-colors p-1"
                title="Create backup"
                aria-label="Create backup"
            >
                <Save size={16} />
            </button>

            <button
                onClick={toggleBackupModal}
                className="text-text-dim hover:text-terminal transition-colors p-1"
                title="Backup manager"
                aria-label="Open backup manager"
            >
                <Archive size={16} />
            </button>

            <button
                onClick={() => {
                    if (activeCampaignId) {
                        fetch(`${API}/campaigns/${activeCampaignId}/backup`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ trigger: 'pre-clear', isAuto: true }),
                        }).catch(() => {});
                    }
                    clearChat();
                }}
                className="text-text-dim hover:text-danger transition-colors p-1"
                title="Clear chat history"
                aria-label="Clear chat history"
            >
                <Trash2 size={16} />
            </button>

            <button
                onClick={toggleNPCLedger}
                className="text-text-dim hover:text-terminal transition-colors p-1"
                title="NPC Ledger"
                aria-label="Open NPC Ledger"
            >
                <Users size={18} />
            </button>

            <button
                onClick={toggleSettings}
                className="text-text-dim hover:text-terminal transition-colors p-1"
                title="Settings"
                aria-label="Open settings"
            >
                <Settings size={18} />
            </button>

            <button
                onClick={handleExit}
                className="text-text-dim hover:text-ember transition-colors p-1 ml-1"
                title="Exit campaign"
                aria-label="Exit campaign"
            >
                <LogOut size={16} />
            </button>
        </header>
    );
}

