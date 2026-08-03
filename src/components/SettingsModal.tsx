import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { ProvidersTab } from './settings-modal/ProvidersTab';
import { PresetsTab } from './settings-modal/PresetsTab';
import { GlobalSettingsTab } from './settings-modal/GlobalSettingsTab';
import { ExtensionsTab } from './settings-modal/ExtensionsTab';
import { AdvancedTab } from './settings-modal/AdvancedTab';
import { DebugTab } from './settings-modal/DebugTab';
import { APP_VERSION } from '../version';
import { useTranslation } from '../i18n/useTranslation';
import type { TranslateKey } from '../i18n';

type TabKey = 'providers' | 'presets' | 'global' | 'extensions' | 'advanced' | 'debug';

/** Reading-width cap for the form tabs. Extensions opts out — see the render below. */
const FORM_WIDTH = 'max-w-5xl mx-auto';

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
  useEffect(() => {
    if (!settingsOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') toggleSettings();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [settingsOpen, toggleSettings]);

  if (!settingsOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" role="dialog" aria-modal="true" aria-label={t('settings.dialog.aria')}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-ember/40 backdrop-blur-sm" onClick={toggleSettings} />

      {/* Panel */}
      {/* Full-bleed at every breakpoint. Settings now hosts mod screens, which
          can be whole applications; a 75vw × 75vh box left a node editor in a
          letterbox. The header below is `shrink-0` and outside the scroll
          container, so the X stays on screen no matter how tall the content is. */}
      <div className="relative bg-surface border border-border w-full h-full flex flex-col shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between p-4 sm:p-6 border-b border-border shrink-0 bg-void z-10">
          <h2 className="chrome-label text-terminal text-sm font-bold tracking-[0.2em] uppercase glow-green">
            {t('settings.title')}
          </h2>
          <div className="flex items-center gap-4">
            <span className="text-[10px] font-mono text-text-dim" title={t('settings.version.tooltip')}>
              v{APP_VERSION}
            </span>
            <button onClick={toggleSettings} className="text-text-dim hover:text-danger transition-colors" aria-label={t('settings.close.aria')}>
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border shrink-0 bg-void">
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
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 pb-20 relative">
          {/* WO-12.1 — Constrain content width on wide desktop viewports so the
              mobile-first full-width fields don't stretch across a wide screen.
              The cap is per-tab rather than one shared wrapper: it exists for
              FORMS, and Extensions is not one. It hosts mod screens (a node
              editor, a canvas) that should use whatever width the window has. */}
          <div className={`${FORM_WIDTH} ${activeTab !== 'providers' ? 'hidden' : ''}`}><ProvidersTab /></div>
          <div className={`${FORM_WIDTH} ${activeTab !== 'presets' ? 'hidden' : ''}`}><PresetsTab /></div>
          <div className={`${FORM_WIDTH} ${activeTab !== 'global' ? 'hidden' : ''}`}><GlobalSettingsTab /></div>
          <div className={activeTab !== 'extensions' ? 'hidden' : ''}><ExtensionsTab /></div>
          <div className={`${FORM_WIDTH} ${activeTab !== 'advanced' ? 'hidden' : ''}`}><AdvancedTab /></div>
          <div className={`${FORM_WIDTH} ${activeTab !== 'debug' ? 'hidden' : ''}`}><DebugTab /></div>
        </div>
      </div>
    </div>
  );
}