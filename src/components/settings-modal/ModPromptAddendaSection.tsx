import { useTranslation } from '../../i18n/useTranslation';
import type { ValidatedMod } from '../../services/mods/modTypes';
import { isModEnabled } from '../../services/mods/modEnablement';
import {
    addendumToggleKey,
    isAddendumEnabled,
    modPromptAddenda,
} from '../../services/turn/promptAddenda';

const TARGET_LABEL_KEYS = {
    director: 'settings.extensions.mod.addenda.director',
    recommender: 'settings.extensions.mod.addenda.recommender',
} as const;

/**
 * A mod's `promptAddenda`, shown verbatim, with one switch per helper prompt.
 * Renders nothing for a mod that declares none.
 */
export function ModPromptAddendaSection({
    mod,
    moduleEnabled,
    onToggle,
}: {
    mod: ValidatedMod;
    moduleEnabled: Record<string, boolean> | undefined;
    onToggle: (key: string, enabled: boolean) => void;
}) {
    const { t } = useTranslation();
    const entries = modPromptAddenda(mod);
    if (entries.length === 0) return null;
    const modOn = isModEnabled(mod, moduleEnabled);

    return (
        <div className="max-w-[90ch] space-y-3">
            <div>
                <div className="text-[9px] uppercase tracking-widest text-text-dim font-bold">
                    {t('settings.extensions.mod.addenda.title')}
                </div>
                <p className="mt-1 text-[11px] text-text-dim leading-relaxed">
                    {t('settings.extensions.mod.addenda.help')}
                </p>
            </div>
            {entries.map((entry) => {
                const key = addendumToggleKey(entry.modId, entry.target);
                const targetName = t(TARGET_LABEL_KEYS[entry.target]);
                const on = isAddendumEnabled(entry, moduleEnabled);
                return (
                    <div key={entry.target} className="border-t border-border pt-2 space-y-2">
                        <label className="flex items-center gap-2 text-[11px] text-text-primary cursor-pointer">
                            <input
                                type="checkbox"
                                checked={moduleEnabled?.[key] !== false}
                                disabled={!modOn}
                                onChange={(event) => onToggle(key, event.target.checked)}
                                aria-label={t('settings.extensions.mod.addenda.toggle', { target: targetName })}
                                className="accent-terminal"
                            />
                            <span className="font-bold uppercase tracking-wider text-[10px]">{targetName}</span>
                            {!modOn && (
                                <span className="text-[9px] text-text-dim">
                                    {t('settings.extensions.mod.addenda.modOff')}
                                </span>
                            )}
                        </label>
                        <pre
                            className={`overflow-x-auto whitespace-pre-wrap border border-border bg-void px-4 py-3 text-[11px] leading-relaxed font-mono ${on ? 'text-terminal/90' : 'text-text-dim/60 line-through'}`}
                        >
                            {entry.text}
                        </pre>
                    </div>
                );
            })}
        </div>
    );
}
