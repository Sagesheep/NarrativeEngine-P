import { Settings, PanelLeftOpen, PanelLeftClose, LogOut, Users, Archive, Save, Pin, Cpu, MapPin, UserCircle, Swords } from 'lucide-react';
import { createBackup } from '../store/campaignStore';
import { flushAllPendingSaves } from '../store/slices/campaignSlice';
import { toast } from './Toast';
import { useAppStore } from '../store/useAppStore';
import { TokenGauge } from './TokenGauge';
import { BackgroundControl } from './BackgroundControl';
import { saveCampaignState } from '../store/campaignStore';
import type { AiTier } from '../types/llm';
import { APP_VERSION } from '../version';
import { useTranslation } from '../i18n/useTranslation';

const TIER_CYCLE: Record<AiTier, AiTier> = { lite: 'pro', pro: 'max', max: 'lite' };

export function Header() {
    const {
        toggleSettings,
        toggleDrawer,
        toggleNPCLedger,
        toggleEnemyCompendium,
        togglePCPanel,
        toggleLocationLedger,
        toggleBackupModal,
        togglePinnedMemories,
        drawerOpen,
        activeCampaignId,
        setActiveCampaign,
        context,
        messages,
        condenser,
        divergenceRegister,
        settings,
        updateSettings,
    } = useAppStore();

    const pinnedExcerpts = useAppStore(s => s.pinnedExcerpts);
    const aiTier = (settings?.aiTier ?? 'pro') as AiTier;
    const { t } = useTranslation();

    const handleExit = async () => {
        if (activeCampaignId) {
            await saveCampaignState(activeCampaignId, { context, messages, condenser, pinnedExcerpts });
            if (divergenceRegister && (divergenceRegister.entries.length > 0 || (divergenceRegister.prunedLog ?? []).length > 0)) {
                try {
                    const { saveDivergenceRegister } = await import('../store/campaignStore');
                    await saveDivergenceRegister(activeCampaignId, divergenceRegister);
                } catch (e) { console.warn('[Header] saveDivergenceRegister failed:', e); }
            }
        }
        setActiveCampaign(null);
    };

    return (
        <header className="h-12 bg-surface border-b border-border flex items-center px-2 sm:px-4 gap-1 sm:gap-2 shrink-0">
            <button
                onClick={toggleDrawer}
                className="flex items-center justify-center w-8 h-8 rounded-sm border border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal transition-colors shrink-0 cursor-pointer"
                title={drawerOpen ? t('header.drawer.close') : t('header.drawer.open')}
                aria-label={drawerOpen ? t('header.drawer.close') : t('header.drawer.open')}
            >
                {drawerOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
            </button>

            <h1 className="chrome-label hidden md:block text-terminal text-sm font-bold tracking-[0.3em] uppercase glow-green shrink-0">
                {t('header.title')}
            </h1>
            <span className="hidden md:inline text-[9px] font-mono text-text-dim shrink-0" title={t('header.version.tooltip', { version: APP_VERSION })}>
                v{APP_VERSION}
            </span>

            <div className="hidden md:flex flex-1 items-center gap-4">
                <TokenGauge />
            </div>

            <div className="flex items-center gap-1.5 ml-auto overflow-x-auto no-scrollbar py-1 shrink-0">
                <BackgroundControl />

                <button
                    onClick={async () => {
                        if (!activeCampaignId) return;
                        await flushAllPendingSaves();
                        const result = await createBackup(activeCampaignId, { trigger: 'manual', label: 'Manual backup' });
                        if (result?.skipped) {
                            toast.info(t('header.backup.toast.noChanges'));
                        } else if (result?.timestamp) {
                            toast.success(t('header.backup.toast.created'));
                        } else {
                            toast.error(t('header.backup.toast.failed'));
                        }
                    }}
                    className="chrome-label flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                    title={t('header.backup.tooltip')}
                    aria-label={t('header.backup.aria')}
                >
                    <Save size={13} />
                    <span className="hidden sm:inline">{t('header.backup.label')}</span>
                </button>

                <button
                    onClick={toggleBackupModal}
                    className="chrome-label flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                    title={t('header.backups.tooltip')}
                    aria-label={t('header.backups.aria')}
                >
                    <Archive size={13} />
                    <span className="hidden sm:inline">{t('header.backups.label')}</span>
                </button>

                <button
                    onClick={togglePCPanel}
                    className="chrome-label flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                    title={t('header.character.tooltip')}
                    aria-label={t('header.character.aria')}
                >
                    <UserCircle size={13} />
                    <span>{t('header.character.label')}</span>
                </button>

                <button
                    onClick={toggleNPCLedger}
                    className="chrome-label flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                    title={t('header.npcLedger.tooltip')}
                    aria-label={t('header.npcLedger.aria')}
                >
                    <Users size={13} />
                    <span>{t('header.npcLedger.label')}</span>
                </button>

                <button
                    onClick={toggleEnemyCompendium}
                    className="chrome-label flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                    title={t('header.enemyCompendium.tooltip')}
                    aria-label={t('header.enemyCompendium.aria')}
                >
                    <Swords size={13} />
                    <span className="hidden sm:inline">{t('header.enemyCompendium.label')}</span>
                </button>

                <button
                    onClick={toggleLocationLedger}
                    className="chrome-label flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                    title={t('header.places.tooltip')}
                    aria-label={t('header.places.aria')}
                >
                    <MapPin size={13} />
                    <span className="hidden sm:inline">{t('header.places.label')}</span>
                </button>

                <button
                    onClick={() => updateSettings({ aiTier: TIER_CYCLE[aiTier] })}
                    className="chrome-label flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                    title={t('header.aiTier.tooltip', { tier: aiTier.toUpperCase() })}
                    aria-label={t('header.aiTier.aria', { tier: aiTier })}
                >
                    <Cpu size={13} />
                    <span className="hidden sm:inline">{aiTier}</span>
                </button>

                <button
                    onClick={togglePinnedMemories}
                    className={`chrome-label relative flex items-center gap-1.5 h-8 px-2.5 rounded-sm border transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono ${pinnedExcerpts.length > 0 ? 'border-terminal text-terminal bg-terminal/5' : 'border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal'}`}
                    title={t('header.pinned.tooltip')}
                    aria-label={t('header.pinned.aria')}
                >
                    <Pin size={13} />
                    <span className="hidden sm:inline">{t('header.pinned.label')}</span>
                    {pinnedExcerpts.length > 0 && (
                        <span className="min-w-[14px] h-3.5 bg-terminal text-void text-[8px] font-bold rounded-full flex items-center justify-center px-0.5">
                            {pinnedExcerpts.length}
                        </span>
                    )}
                </button>

                <button
                    onClick={toggleSettings}
                    className="chrome-label flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                    title={t('header.settings.tooltip')}
                    aria-label={t('header.settings.aria')}
                >
                    <Settings size={13} />
                    <span className="hidden sm:inline">{t('header.settings.label')}</span>
                </button>

                <button
                    onClick={handleExit}
                    className="chrome-label flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-border/40 hover:border-ember bg-void-lighter hover:bg-ember/5 text-text-dim hover:text-ember transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                    title={t('header.exit.tooltip')}
                    aria-label={t('header.exit.aria')}
                >
                    <LogOut size={13} />
                    <span className="hidden sm:inline">{t('header.exit.label')}</span>
                </button>
            </div>
        </header>
    );
}
