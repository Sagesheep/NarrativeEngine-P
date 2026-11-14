import { useAppStore } from '../../store/useAppStore';
import { useTranslation } from '../../i18n/useTranslation';
import { Toggle } from './Toggle';
import {
    COMBAT_DEFEAT_MODES, COMBAT_NARRATION_CADENCES, COMBAT_NARRATION_LENGTHS, COMBAT_PARTY_CONTROLS, normalizeCombatConfig,
} from '../../types';
import type { CombatSettings, GameContext } from '../../types';
import { commitCombatPatch, ensureCombatSheet } from '../../services/combat/combatSheet';
import { getApiFormat } from '../../utils/llmApiHelper';
import { CombatAllocationHint } from '../combat/StartCombatButton';

type CombatSettingsSectionProps = {
    context: GameContext;
    updateContext: (patch: Partial<GameContext>) => void;
};

const selectClass = 'w-full bg-surface border border-border px-3 py-2 text-[13px] font-mono text-text-primary focus:border-terminal outline-none transition-colors';
const labelClass = 'text-[12px] text-text-dim uppercase tracking-wider mb-1 block';

function countsText(counts: Partial<Record<string, number>> | undefined): string {
    const entries = Object.entries(counts ?? {}).filter(([, n]) => typeof n === 'number' && n > 0);
    return entries.length > 0 ? entries.map(([k, n]) => `${k} ${n}`).join(', ') : '–';
}

export function CombatSettingsSection({ context, updateContext }: CombatSettingsSectionProps) {
    const { t } = useTranslation();
    const setCharacterProfileData = useAppStore((s) => s.setCharacterProfileData);
    const storyProvider = useAppStore((s) => s.getActiveStoryEndpoint?.());
    const debugMode = useAppStore((s) => s.settings?.debugMode === true);
    const ollama = !!storyProvider && getApiFormat(storyProvider) === 'ollama';
    const telemetry = context.combatTelemetry;
    const active = context.combatModeActive === true;
    const config = normalizeCombatConfig(context.combatConfig);

    const toggle = () => {
        if (active) {
            updateContext({ combatModeActive: false });
            return;
        }
        const next: GameContext = { ...context, combatModeActive: true };
        commitCombatPatch({ updateContext, setCharacterProfileData }, { combatModeActive: true, ...ensureCombatSheet(next) });
    };

    const setConfig = (patch: Partial<CombatSettings>) => {
        updateContext({ combatConfig: normalizeCombatConfig({ ...config, ...patch }) });
    };

    return (
        <div className="space-y-2" data-testid="combat-settings">
            <div className="text-[12px] text-terminal uppercase tracking-wider font-bold border-b border-terminal/20 pb-1 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-terminal" />
                    {t('combat.settings.title')}
                </div>
                <Toggle active={active} onChange={toggle} ariaLabel={t('combat.settings.toggle.aria')} />
            </div>
            <div className="bg-void border border-border p-3 space-y-3">
                <p className="text-[12px] text-text-dim leading-relaxed">{t('combat.settings.help')}</p>
                {active && <CombatAllocationHint variant="note" />}
                {active && ollama && (
                    <p data-testid="combat-ollama-note" className="text-[12px] text-amber-400 leading-relaxed">{t('combat.settings.ollamaNote')}</p>
                )}
                {active && debugMode && telemetry && (
                    <p data-testid="combat-telemetry" className="text-[11px] text-text-dim font-mono">
                        {t('combat.settings.telemetry', { total: telemetry.dangerousCommits, missed: telemetry.dangerousWithoutProposal })}
                    </p>
                )}
                {active && debugMode && telemetry?.parleyRatings && (
                    <p data-testid="combat-parley-telemetry" className="text-[11px] text-text-dim font-mono">
                        {t('combat.settings.parleyTelemetry', {
                            ratings: countsText(telemetry.parleyRatings),
                            outcomes: countsText(telemetry.parleyOutcomes),
                            sources: countsText(telemetry.parleySources),
                        })}
                    </p>
                )}
                {active && (
                    <div className="space-y-3">
                        <div>
                            <label className={labelClass} htmlFor="combat-party-control">{t('combat.settings.partyControl.label')}</label>
                            <select
                                id="combat-party-control"
                                className={selectClass}
                                value={config.partyControl}
                                onChange={(e) => setConfig({ partyControl: e.target.value as CombatSettings['partyControl'] })}
                            >
                                {COMBAT_PARTY_CONTROLS.map((v) => (
                                    <option key={v} value={v}>{t(`combat.settings.partyControl.${v}`)}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className={labelClass} htmlFor="combat-defeat-mode">{t('combat.settings.defeatMode.label')}</label>
                            <select
                                id="combat-defeat-mode"
                                className={selectClass}
                                value={config.defeatMode}
                                onChange={(e) => setConfig({ defeatMode: e.target.value as CombatSettings['defeatMode'] })}
                            >
                                {COMBAT_DEFEAT_MODES.map((v) => (
                                    <option key={v} value={v}>{t(`combat.settings.defeatMode.${v}`)}</option>
                                ))}
                            </select>
                            {config.defeatMode !== 'knockout' && (
                                <p data-testid="combat-defeat-warning" className="mt-1 text-[11px] text-amber-400 leading-relaxed">
                                    {t(config.defeatMode === 'ironman' ? 'combat.settings.defeatMode.ironmanWarn' : 'combat.settings.defeatMode.hardcoreWarn')}
                                </p>
                            )}
                            <p className="mt-1 text-[11px] text-text-dim leading-relaxed">{t('combat.settings.snapshotNote')}</p>
                        </div>
                        <div>
                            <label className={labelClass} htmlFor="combat-narration-cadence">{t('combat.settings.narrationCadence.label')}</label>
                            <select
                                id="combat-narration-cadence"
                                className={selectClass}
                                value={config.narrationCadence}
                                onChange={(e) => setConfig({ narrationCadence: e.target.value as CombatSettings['narrationCadence'] })}
                            >
                                {COMBAT_NARRATION_CADENCES.map((v) => (
                                    <option key={v} value={v}>{t(`combat.settings.narrationCadence.${v}`)}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className={labelClass} htmlFor="combat-narration-length">{t('combat.settings.narrationLength.label')}</label>
                            <select
                                id="combat-narration-length"
                                className={selectClass}
                                value={config.narrationLength}
                                onChange={(e) => setConfig({ narrationLength: e.target.value as CombatSettings['narrationLength'] })}
                            >
                                {COMBAT_NARRATION_LENGTHS.map((v) => (
                                    <option key={v} value={v}>{t(`combat.settings.narrationLength.${v}`)}</option>
                                ))}
                            </select>
                        </div>
                        <label className="flex items-center gap-2 text-[12px] text-text-dim">
                            <input
                                type="checkbox"
                                checked={config.confirmStart}
                                onChange={(e) => setConfig({ confirmStart: e.target.checked })}
                            />
                            {t('combat.settings.confirmStart')}
                        </label>
                        <label className="flex items-center gap-2 text-[12px] text-text-dim">
                            <input
                                type="checkbox"
                                checked={config.offerOnDangerous}
                                onChange={(e) => setConfig({ offerOnDangerous: e.target.checked })}
                            />
                            {t('combat.settings.offerOnDangerous')}
                        </label>
                    </div>
                )}
            </div>
        </div>
    );
}
