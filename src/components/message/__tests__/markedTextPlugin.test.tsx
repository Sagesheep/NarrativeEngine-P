import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageMarkdown } from '../MessageMarkdown';
import { useAppStore } from '../../../store/useAppStore';
import { normalizeStoryTextColors, storyTextColorVars, withStoryTextColor } from '../../chat/readingPrefs';
import type { NPCEntry, StoryTextColors } from '../../../types';

const spans = (container: HTMLElement, cls: string) => [...container.querySelectorAll(`.${cls}`)].map(el => el.textContent);
const dialogue = (c: HTMLElement) => spans(c, 'story-dialogue');
const single = (c: HTMLElement) => spans(c, 'story-single-quote');
const bracket = (c: HTMLElement) => spans(c, 'story-bracket');
const renderMd = (content: string) => render(<MessageMarkdown content={content} />).container;
const setColors = (storyTextColors: StoryTextColors | undefined) =>
    useAppStore.setState({ settings: { ...useAppStore.getState().settings, storyTextColors } });

afterEach(() => {
    cleanup();
    useAppStore.setState({ npcLedger: [] });
    setColors(undefined);
});

describe('dialogue colouring', () => {
    beforeEach(() => {
        useAppStore.setState({ npcLedger: [], locationLedger: [] });
        setColors({ dialogue: '#ff8800' });
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

    it('leaves the markup alone when no quote or bracket colour is set', () => {
        setColors({ bold: '#ffffff' });
        const c = renderMd('"Hello" there, [a note: 3] \'aside\'.');
        expect(c.innerHTML).toBe('<p>"Hello" there, [a note: 3] \'aside\'.</p>');
    });

    it('marks only the kinds that have a colour', () => {
        const c = renderMd('"Hello" [note] \'aside\'');
        expect(dialogue(c)).toEqual(['"Hello"']);
        expect(single(c)).toEqual([]);
        expect(bracket(c)).toEqual([]);
    });
});

describe('single quote colouring', () => {
    beforeEach(() => setColors({ singleQuote: '#88aaff' }));

    it('wraps single-quoted words and phrases', () => {
        const c = renderMd("She thinks 'not again' and ‘fine’. ('maybe')");
        expect(single(c)).toEqual(["'not again'", '‘fine’', "'maybe'"]);
    });

    it('never treats apostrophes as quotes', () => {
        const c = renderMd("Don't touch Mara's sword, the twins' house, rock'n'roll, it’s fine.");
        expect(single(c)).toEqual([]);
    });

    it('ignores an unclosed single quote and restarts at a later opener', () => {
        expect(single(renderMd("'Tis the season."))).toEqual([]);
        cleanup();
        expect(single(renderMd("'Tis late, she whispers 'go' now."))).toEqual(["'go'"]);
    });

    it('keeps apostrophes inside a quote', () => {
        const c = renderMd("He hisses 'don't move' at me.");
        expect(single(c)).toEqual(["'don't move'"]);
    });
});

describe('bracket colouring', () => {
    beforeEach(() => setColors({ bracket: '#44cc88' }));

    it('wraps bracketed notes, brackets included', () => {
        const c = renderMd('You sneak past. [Stealth: 14 vs 12, success] The guard yawns.');
        expect(bracket(c)).toEqual(['[Stealth: 14 vs 12, success]']);
    });

    it('colours [Name] shown as a bold name without its brackets', () => {
        const c = renderMd('[Mara] waves. [**Joren**] nods.');
        expect(c.querySelector('strong .story-bracket')?.textContent).toBe('Mara');
        expect([...c.querySelectorAll('strong')].map(s => s.textContent)).toEqual(['Mara', 'Joren']);
        expect(bracket(c)).toEqual(['Mara', 'Joren']);
        expect(c.textContent).toBe('Mara waves. Joren nods.');
    });

    it('ignores unmatched brackets and leaves links alone', () => {
        const c = renderMd('A stray ] and [ here. [a link](https://e.com)');
        expect(bracket(c)).toEqual([]);
        expect(c.querySelector('a')).toHaveAttribute('href', 'https://e.com');
    });

    it('lets the innermost kind win where kinds overlap', () => {
        setColors({ bracket: '#44cc88', dialogue: '#ff8800' });
        const c = renderMd('"Meet me at [the gate, north side], now."');
        expect(bracket(c)).toEqual(['[the gate, north side]']);
        expect(dialogue(c)).toEqual(['"Meet me at ', ', now."']);
        cleanup();
        // A name-like [note] is shown bold without brackets, still bracket-coloured.
        const named = renderMd('"Meet me at [the north gate], now."');
        expect(bracket(named)).toEqual(['the north gate']);
        expect(dialogue(named)).toEqual(['"Meet me at ', ', now."']);
    });
});

describe('story text colour settings', () => {
    it('keeps only valid #rrggbb colours for known kinds', () => {
        expect(normalizeStoryTextColors({ text: '#ABCDEF', bold: 'red', italic: '#123', dialogue: 7, other: '#000000', bracket: '#00ff00' }))
            .toEqual({ text: '#abcdef', bracket: '#00ff00' });
        expect(normalizeStoryTextColors({ bold: 'nope' })).toBeUndefined();
        expect(normalizeStoryTextColors(null)).toBeUndefined();
    });

    it('sets and clears one colour, collapsing to undefined when empty', () => {
        const one = withStoryTextColor(undefined, 'singleQuote', '#ff8800');
        expect(one).toEqual({ singleQuote: '#ff8800' });
        expect(withStoryTextColor(one, 'singleQuote', null)).toBeUndefined();
    });

    it('emits CSS variables only for chosen colours', () => {
        expect(storyTextColorVars({ bold: '#111111', dialogue: '#222222', bracket: '#333333' })).toEqual({
            '--story-dialogue-color': '#222222',
            '--story-bracket-color': '#333333',
            '--story-bold-color': '#111111',
        });
        expect(storyTextColorVars(undefined)).toEqual({});
    });
});
