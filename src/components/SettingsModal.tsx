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

  // The width cap lives on the tab PANELS, never on the shell.
  //
  // It used to be a per-tab `width` prop on the lightbox (`form` everywhere,
  // `wide` on Extensions) — but the lightbox applies that cap to the wrapper
  // that also contains the tab strip, so selecting Extensions snapped the whole
  // nav bar from 64rem to full-window and back again. Chrome must not resize
  // because of a content-level decision. The shell is now always `wide` and
  // each panel declares its own shape.
  //
  // `max-w-[120rem]` is the 1080p baseline width in scaled units — paired with
  // the `zoom` below it means "fill the window, up to one design-width", so a
  // 1920px and a 2560px window both come out edge to edge and only genuinely
  // ultrawide displays get gutters. Extensions opts out entirely: it hosts mod
  // screens (a node editor, a canvas) that want every pixel.
  const paneClass = 'w-full mx-auto max-w-[120rem] pt-5';

  return (
    <ScreenLightbox size="full" width="wide" title={t('settings.title')} onClose={toggleSettings}>
      {/* Backdrop */}
      {null}

      {/* Panel — the lightbox owns the scroll container and the padding; this
          screen owns its own width caps (see above). The tab bar is
          `sticky top-0` so it pins to the top of the lightbox's scroll
          container and stays visible while content scrolls. The tab panels are
          conditionally hidden rather than unmounted so component state survives
          a tab flip.

          Viewport scaling is NOT applied here — ScreenLightbox owns it, on the
          wrapper directly above this one. Setting `zoom` again at this level
          would multiply against the parent's. */}
      <div className="flex flex-col flex-1 min-h-0">

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
        <div className={activeTab !== 'providers' ? 'hidden' : paneClass}><ProvidersTab /></div>
        <div className={activeTab !== 'presets' ? 'hidden' : paneClass}><PresetsTab /></div>
        <div className={activeTab !== 'global' ? 'hidden' : paneClass}><GlobalSettingsTab /></div>
        <div className={activeTab !== 'extensions' ? 'hidden' : 'flex-1 min-h-0 flex flex-col'}><ExtensionsTab /></div>
        <div className={activeTab !== 'advanced' ? 'hidden' : paneClass}><AdvancedTab /></div>
        <div className={activeTab !== 'debug' ? 'hidden' : paneClass}><DebugTab /></div>
      </div>
    </ScreenLightbox>
  );
}
