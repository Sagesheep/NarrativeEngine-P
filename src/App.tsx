import './index.css';
import { useEffect, useState } from 'react';
import { useAppStore } from './store/useAppStore';
import { CampaignHub } from './components/CampaignHub';
import { Header } from './components/Header';
import { ContextDrawer } from './components/ContextDrawer';
import { ChatArea } from './components/ChatArea';
import { SettingsModal } from './components/SettingsModal';
import { NPCLedgerModal } from './components/NPCLedgerModal';
import { BackupModal } from './components/BackupModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastContainer } from './components/Toast';
import { VaultUnlockModal } from './components/VaultUnlockModal';
import { hydrateCampaign } from './store/campaignHydrator';

export default function App() {
  const activeCampaignId = useAppStore((s) => s.activeCampaignId);
  const settingsLoaded = useAppStore((s) => s.settingsLoaded);
  const loadSettings = useAppStore((s) => s.loadSettings);
  const vaultStatus = useAppStore((s) => s.vaultStatus);
  const checkVaultStatus = useAppStore((s) => s.checkVaultStatus);
  const unlockVaultWithRemembered = useAppStore((s) => s.unlockVaultWithRemembered);
  const unlockVault = useAppStore((s) => s.unlockVault);

  // True once campaign state has been hydrated into Zustand (or there's no campaign to hydrate)
  const [campaignLoaded, setCampaignLoaded] = useState(false);
  const [isCheckingVault, setIsCheckingVault] = useState(false);

  // Initial load: check vault status after settings load
  useEffect(() => {
    if (!settingsLoaded) return;
    
    const checkVault = async () => {
      setIsCheckingVault(true);
      await checkVaultStatus();
      setIsCheckingVault(false);
    };
    
    checkVault();
  }, [settingsLoaded, checkVaultStatus]);

  // Try to unlock with remembered key if vault exists and has remembered key
  useEffect(() => {
    if (vaultStatus?.exists && vaultStatus?.hasRemember && !vaultStatus?.unlocked && !isCheckingVault) {
      unlockVaultWithRemembered();
    }
  }, [vaultStatus, unlockVaultWithRemembered, isCheckingVault]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // After settings load, if we already have an activeCampaignId (restored from a previous
  // session), we MUST load the campaign's data before rendering ChatArea.
  // Without this guard, the empty Zustand defaults would race against any auto-save
  // and silently overwrite the real saved data into the DB.
  useEffect(() => {
    if (!settingsLoaded) return;

    if (!activeCampaignId) {
      // No campaign active — hub will be shown, nothing to hydrate
      setCampaignLoaded(true);
      return;
    }

    let cancelled = false;
    setCampaignLoaded(false);

    (async () => {
      await hydrateCampaign(activeCampaignId);
      if (cancelled) return;
      setCampaignLoaded(true);
    })();

    return () => { cancelled = true; };
    // Only re-run when the session first loads (settingsLoaded flips to true).
    // We don't re-run on activeCampaignId changes because CampaignHub.handleSelectCampaign
    // already handles hydration when the user picks a campaign manually.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoaded]);

  // Show loading while checking vault or settings
  if (!settingsLoaded || isCheckingVault) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-950 text-gray-400">
        <div className="text-lg animate-pulse">Loading…</div>
      </div>
    );
  }

  // Show vault unlock if vault exists but is locked and no remembered key
  if (vaultStatus && vaultStatus.exists && !vaultStatus.unlocked && !vaultStatus.hasRemember) {
    return (
      <div className="min-h-screen bg-void">
        <VaultUnlockModal
          onUnlock={async (password, remember) => {
            return await unlockVault(password, remember);
          }}
          onUseMachineKey={async () => {
            // Machine key mode - unlock with null password
            return await unlockVault('', false);
          }}
          hasRememberedKey={false}
        />
      </div>
    );
  }

  // If campaign is still loading (but vault is ready), show loading
  if (!campaignLoaded && activeCampaignId) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-950 text-gray-400">
        <div className="text-lg animate-pulse">Loading campaign…</div>
      </div>
    );
  }

  if (!activeCampaignId) {
    return (
      <ErrorBoundary>
        <CampaignHub />
        <SettingsModal />
        <BackupModal />
        <ToastContainer />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <Header />
      <div className="flex flex-1 overflow-hidden">
        <ContextDrawer />
        <ChatArea />
      </div>
      <SettingsModal />
      <NPCLedgerModal />
      <BackupModal />
      <ToastContainer />
    </ErrorBoundary>
  );
}
