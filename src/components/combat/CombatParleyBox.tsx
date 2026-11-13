import { useState } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Loader2, MessageSquare } from 'lucide-react';
import { useTranslation } from '../../i18n/useTranslation';
import type { CombatSession } from '../../types';
import { canParley, PARLEY_WORDS_MAX, submitParley } from '../../services/combat/combatParley';

export function CombatParleyBox({ session, busy }: { session: CombatSession; busy: boolean }) {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    if (session.parley) {
        return (
            <div data-testid="combat-parley-pending" className="flex items-center gap-2 px-3 py-2 border-t border-border text-[11px] font-mono text-text-dim">
                <Loader2 size={12} className="animate-spin" /> {t('combat.parley.busy')}
            </div>
        );
    }
    if (!canParley(session, busy)) return null;
    const send = () => {
        const words = text.trim();
        if (!words) return;
        setText('');
        void submitParley(words);
    };
    const onSubmit = (e: FormEvent) => {
        e.preventDefault();
        send();
    };
    const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
        }
    };
    return (
        <form data-testid="combat-parley" onSubmit={onSubmit} className="flex items-end gap-2 px-3 py-2 border-t border-border">
            <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKeyDown}
                maxLength={PARLEY_WORDS_MAX}
                rows={2}
                aria-label={t('combat.parley.label')}
                placeholder={t('combat.parley.placeholder')}
                title={t('combat.parley.help')}
                className="flex-1 min-w-0 resize-none bg-void border border-border px-2 py-1 text-[12px] text-text-primary focus:border-terminal outline-none"
            />
            <button
                type="submit"
                disabled={!text.trim()}
                className="flex items-center gap-1 border border-border text-[10px] uppercase tracking-wider px-3 py-1.5 rounded-sm text-text-primary hover:bg-void-lighter disabled:opacity-40 disabled:cursor-not-allowed"
            >
                <MessageSquare size={12} /> {t('combat.parley.send')}
            </button>
        </form>
    );
}
