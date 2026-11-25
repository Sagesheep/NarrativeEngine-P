import { MessageSquarePlus } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { useTranslation } from '../../i18n/useTranslation';
import {
    PLAYER_PROMPT_NOTE_MAX_CHARS,
    PROMPT_ADDENDUM_TARGETS,
    getModPromptAddenda,
    isAddendumEnabled,
    type PromptAddendumTarget,
} from '../../services/turn/promptAddenda';

const TARGET_KEYS = {
    director: {
        label: 'settings.promptNotes.director.label',
        help: 'settings.promptNotes.director.help',
        placeholder: 'settings.promptNotes.director.placeholder',
    },
    recommender: {
        label: 'settings.promptNotes.recommender.label',
        help: 'settings.promptNotes.recommender.help',
        placeholder: 'settings.promptNotes.recommender.placeholder',
    },
} as const;

/**
 * The player's own steering text for the Continuity Director and the Context
 * Recommender. Same slot mods use (`promptAddenda`), added after every mod's
 * text so the player has the last word. Empty adds nothing.
 */
export function PromptNotesSection() {
    const settings = useAppStore((s) => s.settings);
    const updateSettings = useAppStore((s) => s.updateSettings);
    const { t } = useTranslation();
    const modAddenda = getModPromptAddenda();

    const setNote = (target: PromptAddendumTarget, value: string) => {
        updateSettings({
            playerPromptNotes: { ...settings.playerPromptNotes, [target]: value },
        });
    };

    return (
        <div className="bg-void p-4 border border-border rounded space-y-3">
            <div>
                <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1 flex items-center gap-1.5">
                    <MessageSquarePlus size={11} /> {t('settings.promptNotes.title')}
                </label>
                <p className="text-[9px] text-text-dim max-w-[420px] leading-tight">
                    {t('settings.promptNotes.help')}
                </p>
            </div>

            {PROMPT_ADDENDUM_TARGETS.map((target) => {
                const id = `player-prompt-note-${target}`;
                const value = settings.playerPromptNotes?.[target] ?? '';
                const fromMods = modAddenda
                    .filter((entry) => entry.target === target && isAddendumEnabled(entry, settings.moduleEnabled))
                    .map((entry) => entry.modName);
                return (
                    <div key={target} className="space-y-1">
                        <label htmlFor={id} className="block text-[10px] text-text-primary uppercase tracking-wider font-bold">
                            {t(TARGET_KEYS[target].label)}
                        </label>
                        <p className="text-[9px] text-text-dim leading-tight">
                            {t(TARGET_KEYS[target].help)}
                        </p>
                        <textarea
                            id={id}
                            value={value}
                            maxLength={PLAYER_PROMPT_NOTE_MAX_CHARS}
                            rows={3}
                            placeholder={t(TARGET_KEYS[target].placeholder)}
                            onChange={(event) => setNote(target, event.target.value)}
                            className="w-full text-[11px] bg-void border border-border px-2 py-1.5 text-text-primary focus:border-terminal focus:outline-none resize-y"
                        />
                        {/* Text size sits on the spans: beta.css caps any small-text settings div at 56ch. */}
                        <div className="flex justify-between gap-3 text-text-dim/70">
                            <span className="text-[9px]">
                                {fromMods.length > 0
                                    ? t('settings.promptNotes.fromMods', { mods: fromMods.join(', ') })
                                    : t('settings.promptNotes.fromModsNone')}
                            </span>
                            <span className="text-[9px] font-mono">{value.length}/{PLAYER_PROMPT_NOTE_MAX_CHARS}</span>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
