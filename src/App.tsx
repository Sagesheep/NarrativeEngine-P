import './index.css';
import { useEffect } from 'react';
import { useAppStore } from './store/useAppStore';
import { CampaignHub } from './components/CampaignHub';
import { Header } from './components/Header';
import { ContextDrawer } from './components/ContextDrawer';
import { ChatArea } from './components/ChatArea';
import { SettingsModal } from './components/SettingsModal';
import { NPCLedgerModal } from './components/NPCLedgerModal';

export default function App() {
  const activeCampaignId = useAppStore((s) => s.activeCampaignId);
  const settingsLoaded = useAppStore((s) => s.settingsLoaded);
  const loadSettings = useAppStore((s) => s.loadSettings);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  if (!settingsLoaded) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-950 text-gray-400">
        <div className="text-lg animate-pulse">Loading…</div>
      </div>
    );
  }

  if (!activeCampaignId) {
    return (
      <>
        <CampaignHub />
        <SettingsModal />
      </>
    );
  }

  return (
    <>
      <Header />
      <div className="flex flex-1 overflow-hidden">
        <ContextDrawer />
        <ChatArea />
      </div>
      <SettingsModal />
      <NPCLedgerModal />
    </>
  );
}
