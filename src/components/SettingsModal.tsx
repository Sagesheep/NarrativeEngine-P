import { useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { ProvidersTab } from './settings-modal/ProvidersTab';
import { PresetsTab } from './settings-modal/PresetsTab';
import { GlobalSettingsTab } from './settings-modal/GlobalSettingsTab';
import { ExtensionsTab } from './settings-modal/ExtensionsTab';
import { AdvancedTab } from './settings-modal/AdvancedTab';
import { DebugTab } from './settings-modal/DebugTab';
import { useTranslation } from '../i18n/useTranslation';
import type { TranslateKey } from '../i18n';
import { ScreenLightbox } from './ScreenLightbox';

type TabKey = 'providers' | 'presets' | 'global' | 'extensions' | 'advanced' | 'debug';

// Label is a translation KEY, resolved at render — a const array evaluated at
// module load would freeze the language at import time and never update.
const TABS: { key: TabKey; labelKey: TranslateKey }[] = [
  { key: 'providers', labelKey: 'settings.tab.providers' },
  { key: 'presets', labelKey: 'settings.tab.presets' },
  { key: 'global', labelKey: 'settings.tab.global' },
  { key: 'extensions', labelKey: 'settings.tab.extensions' },
  { key: 'advanced', labelKey: 'settings.tab.advanced' },
  { key: 'debug', labelKey: 'settings.tab.debug' },
];

export function SettingsModal() {
  const settingsOpen = useAppStore(s => s.settingsOpen);
  const toggleSettings = useAppStore(s => s.toggleSettings);
  const [activeTab, setActiveTab] = useState<TabKey>('providers');
  const { t } = useTranslation();

  // The panel is full-bleed, so the backdrop's click-to-close is unreachable —
  // it is covered edge to edge. Escape is what replaces it. Without this the X
  // button would be the ONLY way out of a screen that occupies the whole app.
  // Matches BlockViewModal's handler.
  if (!settingsOpen) return null;

  // WO-ui-polish §A1 — width cap moved onto ScreenLightbox itself. Settings
  // is full-bleed (size="full"); the lightbox's `width` prop is the form cap.
  // Extensions opts out: it hosts mod screens (a node editor, a canvas) that
  // should use whatever width the window has. One implementation, not two.
  const lightboxWidth = activeTab === 'extensions' ? 'wide' : 'form';

  return (
    <ScreenLightbox size="full" width={lightboxWidth} title={t('settings.title')} onClose={toggleSettings}>
      {/* Backdrop */}
      {null}

      {/* Panel — the lightbox owns the scroll container, the width cap, and the
          padding. The tab bar is `sticky top-0` so it pins to the top of the
          lightbox's scroll container and stays visible while content scrolls.
          The tab panels are conditionally hidden rather than unmounted so
          component state survives a tab flip. */}
      <div className="flex flex-col">

        {/* Tabs */}
        <div className="flex border-b border-border sticky top-0 bg-void z-10">
          {TABS.map(({ key, labelKey }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`chrome-label flex-1 px-3 py-2 text-[11px] uppercase tracking-wider transition-all border-b-2 -mb-px ${
                activeTab === key
                  ? 'text-terminal border-terminal bg-terminal/5 font-bold'
                  : 'text-text-dim border-transparent hover:text-text-primary'
              }`}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>

        {/* Active tab content */}
        <div className={activeTab !== 'providers' ? 'hidden' : ''}><ProvidersTab /></div>
        <div className={activeTab !== 'presets' ? 'hidden' : ''}><PresetsTab /></div>
        <div className={activeTab !== 'global' ? 'hidden' : ''}><GlobalSettingsTab /></div>
        <div className={activeTab !== 'extensions' ? 'hidden' : ''}><ExtensionsTab /></div>
        <div className={activeTab !== 'advanced' ? 'hidden' : ''}><AdvancedTab /></div>
        <div className={activeTab !== 'debug' ? 'hidden' : ''}><DebugTab /></div>
      </div>
    </ScreenLightbox>
  );
}
