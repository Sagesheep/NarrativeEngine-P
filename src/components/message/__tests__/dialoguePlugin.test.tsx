import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageMarkdown } from '../MessageMarkdown';
import { useAppStore } from '../../../store/useAppStore';
import { normalizeStoryTextColors, storyTextColorVars, withStoryTextColor } from '../../chat/readingPrefs';
import type { NPCEntry } from '../../../types';

const dialogue = (container: HTMLElement) => [...container.querySelectorAll('.story-dialogue')].map(el => el.textContent);
const renderMd = (content: string) => render(<MessageMarkdown content={content} />).container;

describe('dialogue colouring', () => {
    beforeEach(() => useAppStore.setState({
        npcLedger: [], locationLedger: [],
        settings: { ...useAppStore.getState().settings, storyTextColors: { dialogue: '#ff8800' } },
    }));
    afterEach(() => {
        cleanup();
        useAppStore.setState({ npcLedger: [], settings: { ...useAppStore.getState().settings, storyTextColors: undefined } });
    });

    it('wraps straight and curly quotes, marks included', () => {
        const c = renderMd('She said "go" and “now”. Then «stop».');
        expect(dialogue(c)).toEqual(['"go"', '“now”', '«stop»']);
    });

    it('carries one quote across bold, italic and name links', () => {
        useAppStore.setState({ npcLedger: [{ id: 'm', name: 'Mara' } as NPCEntry] });
        const c = renderMd('"I told **you**, *Mara*!" she said.');
        expect(dialogue(c)).toEqual(['"I told ', 'you', ', ', 'Mara', '!"']);
        expect(c.querySelector('strong .story-dialogue')?.textContent).toBe('you');
        expect(c.querySelector('em .story-dialogue')?.textContent).toBe('Mara');
        expect(c.textContent).toBe('"I told you, Mara!" she said.');
    });

    it('wraps a quote that sits wholly inside bold', () => {
        const c = renderMd('**"text"** plain');
        expect(c.querySelector('strong .story-dialogue')?.textContent).toBe('"text"');
    });

    it('stops an unclosed quote at the end of its paragraph', () => {
        const c = renderMd('"First part of a long speech\n\nNarration after.\n\n"Second" here.');
        expect(dialogue(c)).toEqual(['"First part of a long speech', '"Second"']);
    });

    it('ignores apostrophes, inch marks, code and URLs', () => {
        const c = renderMd('It\'s 6\'2" tall. `say "x"` and [a "link"](https://e.com/"q") ’tis.');
        expect(dialogue(c)).toEqual(['"link"']);
        expect(c.querySelector('code')?.textContent).toBe('say "x"');
        expect(c.querySelector('a')).toHaveAttribute('href', 'https://e.com/%22q%22');
    });

    it('accepts either closer after a German opening mark', () => {
        const c = renderMd('„Ja“, sagte sie. „Nein”.');
        expect(dialogue(c)).toEqual(['„Ja“', '„Nein”']);
    });

    it('leaves the markup alone when no dialogue colour is set', () => {
        useAppStore.setState({ settings: { ...useAppStore.getState().settings, storyTextColors: { bold: '#ffffff' } } });
        const c = renderMd('"Hello" there.');
        expect(c.querySelector('.story-dialogue')).toBeNull();
        expect(c.innerHTML).toBe('<p>"Hello" there.</p>');
    });
});

describe('story text colour settings', () => {
    it('keeps only valid #rrggbb colours for known kinds', () => {
        expect(normalizeStoryTextColors({ text: '#ABCDEF', bold: 'red', italic: '#123', dialogue: 7, other: '#000000' })).toEqual({ text: '#abcdef' });
        expect(normalizeStoryTextColors({ bold: 'nope' })).toBeUndefined();
        expect(normalizeStoryTextColors(null)).toBeUndefined();
    });

    it('sets and clears one colour, collapsing to undefined when empty', () => {
        const one = withStoryTextColor(undefined, 'dialogue', '#ff8800');
        expect(one).toEqual({ dialogue: '#ff8800' });
        expect(withStoryTextColor(one, 'dialogue', null)).toBeUndefined();
    });

    it('emits CSS variables only for chosen colours', () => {
        expect(storyTextColorVars({ bold: '#111111', dialogue: '#222222' })).toEqual({
            '--story-bold-color': '#111111',
            '--story-dialogue-color': '#222222',
        });
        expect(storyTextColorVars(undefined)).toEqual({});
    });
});
