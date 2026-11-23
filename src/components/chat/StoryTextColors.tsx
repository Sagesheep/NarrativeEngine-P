import { useLayoutEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import type { StoryTextColors as StoryTextColorsValue } from '../../types';
import { MessageMarkdown } from '../message/MessageMarkdown';
import { STORY_TEXT_KINDS, normalizeReadingFont, readingStyleVars, withStoryTextColor } from './readingPrefs';

const PREVIEW = 'The rain eases off. **Mara** checks the door. "Keep moving," she says, "and **don\'t** look back." '
    + "Her brother mutters 'not again' under his breath. *Somewhere, a bell.* [Stealth: 14 vs 12, success]";

/** Which element in the preview shows each kind's current colour. */
const PROBES: Record<keyof StoryTextColorsValue, string> = {
    text: 'p',
    dialogue: '.story-dialogue',
    singleQuote: '.story-single-quote',
    bracket: '.story-bracket',
    bold: 'strong',
    italic: 'em',
    name: '.story-name',
};

function toHex(rgb: string): string | null {
    const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return null;
    return '#' + m.slice(1, 4).map(n => Number(n).toString(16).padStart(2, '0')).join('');
}

/**
 * Per-kind story text colours with a live preview. The preview is rendered
 * inside the same `stage` → `story-journal` wrappers as the real story, so it
 * picks up the story's own font and theme colours, not the settings modal's.
 * Unset kinds show the colour the theme gives them, read from the preview.
 */
export function StoryTextColors() {
    const settings = useAppStore(s => s.settings);
    const updateSettings = useAppStore(s => s.updateSettings);
    const colors = settings.storyTextColors;
    const previewRef = useRef<HTMLDivElement>(null);
    const [themeColors, setThemeColors] = useState<Partial<Record<keyof StoryTextColorsValue, string>>>({});

    useLayoutEffect(() => {
        const root = previewRef.current;
        if (!root || typeof getComputedStyle !== 'function') return;
        const next: Partial<Record<keyof StoryTextColorsValue, string>> = {};
        for (const { key } of STORY_TEXT_KINDS) {
            const el = root.querySelector(PROBES[key]) ?? root.querySelector('p');
            const hex = el ? toHex(getComputedStyle(el).color) : null;
            if (hex) next[key] = hex;
        }
        setThemeColors(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    }, [colors, settings.theme, settings.betaUi]);

    const set = (key: keyof StoryTextColorsValue, color: string | null) =>
        updateSettings({ storyTextColors: withStoryTextColor(colors, key, color) });

    return (
        <div className="space-y-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
                {STORY_TEXT_KINDS.map(({ key, label, marks }) => {
                    const chosen = colors?.[key];
                    const shown = chosen ?? themeColors[key] ?? '#888888';
                    return (
                        <div key={key} className="flex items-center gap-2">
                            <span className="w-28 flex-shrink-0 flex items-baseline gap-1.5">
                                <span className="text-[10px] text-text-dim uppercase tracking-wider">{label}</span>
                                <span className="text-[10px] text-text-dim/70 font-mono">{marks}</span>
                            </span>
                            <input
                                type="color"
                                value={shown}
                                onChange={e => set(key, e.target.value)}
                                aria-label={`${label} colour`}
                                className="w-8 h-6 p-0 border border-border rounded bg-transparent cursor-pointer"
                            />
                            {chosen ? (
                                <button
                                    onClick={() => set(key, null)}
                                    className="px-2 py-0.5 text-[10px] uppercase font-mono border rounded bg-surface border-border text-text-dim hover:text-text-primary hover:border-text-dim focus:outline-none"
                                    title="Go back to the theme's colour"
                                >
                                    Theme
                                </button>
                            ) : (
                                <span className="text-[10px] text-text-dim/70 font-mono">theme</span>
                            )}
                        </div>
                    );
                })}
            </div>
            <div data-ui="stage" className="rounded border border-border overflow-hidden" aria-label="Story text preview">
                <div
                    className="story-journal"
                    data-reading-font={normalizeReadingFont(settings.readingFont)}
                    style={{ ...readingStyleVars(settings), padding: '10px 12px' }}
                >
                    <div ref={previewRef} className="gm-prose journal-prose">
                        <MessageMarkdown content={PREVIEW} />
                        {/* Names only link up for entries in the open campaign, so the
                            sample name is drawn directly, styled like MentionPreview. */}
                        <p><span className="story-name font-bold">Kris</span> watches from the doorway.</p>
                    </div>
                </div>
            </div>
            {colors && (
                <button
                    onClick={() => updateSettings({ storyTextColors: undefined })}
                    className="px-2 py-1 text-[10px] uppercase font-mono border rounded bg-surface border-border text-text-dim hover:text-text-primary hover:border-text-dim focus:outline-none"
                >
                    Reset colours
                </button>
            )}
        </div>
    );
}
