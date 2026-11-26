import type { LucideIcon } from 'lucide-react';

/**
 * One shared section header for the nav-drawer surfaces.
 *
 * WO-screen-modernization §2a — every screen hand-rolled the same three things
 * (icon + label + optional count + optional right action) with three different
 * sizes and three different colours. One component, neutral text colour per
 * WO-ui-polish §B4 (colour means *state*, not structure).
 *
 * The label is rendered in `text-text-dim` (neutral). Section-specific accent
 * colour is opt-in via `tone` for the few places where the section is a *state*
 * — e.g. the Always-On group inside Lore is a real semantic distinction. The
 * default `tone="neutral"` is what callers should reach for.
 *
 * Layout: `flex items-center justify-between gap-2` so the right-slot action
 * pins to the trailing edge without callers hand-tuning `ml-auto` chains. The
 * leading marker dot is optional (`marker`) so callers that already have an
 * icon don't get a redundant dot — EnginesTab's four engine blocks each have
 * their own icon+dot styling and keep using it.
 */
export interface ScreenSectionProps {
    /** Leading icon. Sized at 13px to match the existing drawer type scale. */
    icon?: LucideIcon;
    /** Section label. Already uppercased + tracked via the className. */
    label: string;
    /** Optional count badge rendered after the label. */
    count?: number;
    /** Optional right-slot action (button, toggle, etc). */
    rightSlot?: React.ReactNode;
    /** Optional leading marker dot. Default false — most callers have an icon. */
    marker?: boolean;
    /** Border under the header. Default true — pinned for the common case. */
    border?: boolean;
    /** Section tone. `neutral` is structure; `terminal`/`ember`/`amber` are state. */
    tone?: 'neutral' | 'terminal' | 'ember' | 'amber';
    /** Extra classes on the header row. */
    className?: string;
}

const TONE_TEXT: Record<NonNullable<ScreenSectionProps['tone']>, string> = {
    neutral: 'text-text-dim',
    terminal: 'text-terminal',
    ember: 'text-ember',
    amber: 'text-amber-400',
};

const TONE_BORDER: Record<NonNullable<ScreenSectionProps['tone']>, string> = {
    neutral: 'border-border/50',
    terminal: 'border-terminal/20',
    ember: 'border-ember/20',
    amber: 'border-amber-500/20',
};

const TONE_MARKER: Record<NonNullable<ScreenSectionProps['tone']>, string> = {
    neutral: 'bg-text-dim/50',
    terminal: 'bg-terminal',
    ember: 'bg-ember',
    amber: 'bg-amber-400',
};

export function ScreenSection({
    icon: Icon,
    label,
    count,
    rightSlot,
    marker = false,
    border = true,
    tone = 'neutral',
    className = '',
}: ScreenSectionProps) {
    return (
        <div
            className={`flex items-center justify-between gap-2 pb-1 mb-1 text-[12px] uppercase tracking-wider font-bold ${border ? `border-b ${TONE_BORDER[tone]}` : ''} ${TONE_TEXT[tone]} ${className}`}
        >
            <div className="flex items-center gap-2 min-w-0">
                {marker && <span className={`w-1.5 h-1.5 rounded-full ${TONE_MARKER[tone]} shrink-0`} />}
                {Icon && <Icon size={13} className="shrink-0" />}
                <span className="truncate">{label}</span>
                {count !== undefined && (
                    <span className="shrink-0 text-[10px] font-mono opacity-70">({count})</span>
                )}
            </div>
            {rightSlot && <div className="flex items-center gap-2 shrink-0">{rightSlot}</div>}
        </div>
    );
}