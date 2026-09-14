import { Sparkles } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';

/**
 * The Beta UI flag's control. Lives on the campaign hub only — the hub is the
 * one screen you always pass through, and switching the whole app's skin is
 * not something to do mid-scene.
 *
 * Flipping it writes `settings.betaUi`, which `updateSettings` projects onto
 * `<html data-ui="beta">` (see `applyBetaUi`). Every beta rule in
 * `src/styles/beta.css` is nested under that attribute, so OFF restores the
 * classic UI exactly — nothing re-mounts, no component tree is swapped, and no
 * campaign data is touched either way.
 *
 * Styling is in beta.css under `.beta-toggle` rather than in Tailwind classes
 * here, because the button has to look right in BOTH skins — it is the one
 * control that is always visible from whichever side you are on.
 */
export function BetaUiToggle() {
    const betaUi = useAppStore(s => s.settings?.betaUi ?? false);
    const updateSettings = useAppStore(s => s.updateSettings);

    return (
        <button
            type="button"
            className="beta-toggle"
            aria-pressed={betaUi}
            onClick={() => updateSettings({ betaUi: !betaUi })}
            title={
                betaUi
                    ? 'Beta UI is on — click to return to the classic interface'
                    : 'Try the Beta UI — a new palette, type scale and chat layout. Nothing else changes.'
            }
        >
            <span className="beta-dot" aria-hidden="true" />
            <Sparkles size={13} aria-hidden="true" />
            <span>Beta&nbsp;UI</span>
            <span className="beta-state">{betaUi ? 'On' : 'Off'}</span>
        </button>
    );
}
