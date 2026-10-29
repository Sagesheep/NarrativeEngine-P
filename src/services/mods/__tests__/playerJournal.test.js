import { describe, expect, it, vi } from 'vitest';
import {
    parseBlocks, parseInline, toggleTask, openTasks, taskCounts, findMentionQuery,
    rankCandidates, uniqueLabel, continueList, pruneRefs, resolveMentions,
} from '../../../../public/bundled-mods/player-journal/markdown.js';
import {
    buildArmedContributions, buildOocSection, makeResolver,
} from '../../../../public/bundled-mods/player-journal/prompt.js';
import {
    repairEntries, repairMeta, interceptPrompt, onActivate, onDisable,
} from '../../../../public/bundled-mods/player-journal/index.js';
import { mountJournal } from '../../../../public/bundled-mods/player-journal/editor.js';

const world = {
    npcs: new Map([['n1', { id: 'n1', name: 'Kane Rourke', faction: 'Dockers' }]]),
    places: new Map([['p9', { id: 'p9', name: 'Sector 9' }]]),
    pc: { id: 'pc1', name: 'Ash' },
};

const entry = (over = {}) => ({
    id: 'e1',
    title: "Kane's boss",
    body: 'Kane told me to meet @[Kane]\'s boss in @[Sector 9].\n\n- [ ] Find the damn car\n- [x] Get the leg looked at',
    refs: { Kane: { kind: 'npc', id: 'n1' }, 'Sector 9': { kind: 'place', id: 'p9' } },
    private: false,
    createdAt: 1,
    updatedAt: 2,
    stamp: { day: 12, place: 'Sector 4' },
    ...over,
});

describe('journal markdown', () => {
    it('parses headings, lists, tasks, quotes, rules and paragraphs with source lines', () => {
        const blocks = parseBlocks('# Title\npara one\npara two\n\n- a\n  - [ ] b\n3. c\n> q1\n> q2\n---');
        expect(blocks.map((b) => b.type)).toEqual(['heading', 'para', 'item', 'item', 'item', 'quote', 'rule']);
        expect(blocks[1].lines).toEqual(['para one', 'para two']);
        expect(blocks[3]).toMatchObject({ line: 5, indent: 1, task: false, text: 'b' });
        expect(blocks[4]).toMatchObject({ ordered: true, number: '3', task: null });
        expect(blocks[5].lines).toEqual(['q1', 'q2']);
    });

    it('never passes markup through: everything unrecognised is text', () => {
        const spans = parseInline('<img src=x onerror=alert(1)> **bold** and @[Kane]');
        expect(spans[0]).toEqual({ t: 'text', v: '<img src=x onerror=alert(1)> ' });
        expect(spans[1]).toEqual({ t: 'strong', c: [{ t: 'text', v: 'bold' }] });
        expect(spans[3]).toEqual({ t: 'mention', label: 'Kane' });
    });

    it('toggles exactly the task on the given line and nothing else', () => {
        const body = '- [ ] one\n- [x] two\nplain';
        expect(toggleTask(body, 0)).toBe('- [x] one\n- [x] two\nplain');
        expect(toggleTask(body, 1)).toBe('- [ ] one\n- [ ] two\nplain');
        expect(toggleTask(body, 2)).toBe(body);
        expect(toggleTask(body, 9)).toBe(body);
    });

    it('counts and lists open tasks', () => {
        expect(openTasks(entry().body)).toEqual(['Find the damn car']);
        expect(taskCounts(entry().body)).toEqual({ open: 1, done: 1 });
    });

    it('finds an @ query only at a word start and never inside a finished mention', () => {
        expect(findMentionQuery('meet @Ka', 8)).toEqual({ query: 'Ka', start: 5, end: 8 });
        expect(findMentionQuery('meet @Sector 9', 14)).toMatchObject({ query: 'Sector 9' });
        expect(findMentionQuery('mail me@home', 12)).toBeNull();
        expect(findMentionQuery('@[Kane] x', 9)).toBeNull();
        expect(findMentionQuery('@a\nb', 4)).toBeNull();
    });

    it('ranks name prefix over word prefix over interior over alias', () => {
        const c = [
            { kind: 'npc', id: '1', name: 'Old Kane' },
            { kind: 'npc', id: '2', name: 'Kane Rourke' },
            { kind: 'npc', id: '3', name: 'Mckane' },
            { kind: 'npc', id: '4', name: 'The Boss', aliases: 'kane senior' },
            { kind: 'npc', id: '5', name: 'Mira' },
        ];
        expect(rankCandidates(c, 'kane').map((x) => x.id)).toEqual(['2', '1', '3', '4']);
        expect(rankCandidates(c, '', 2).map((x) => x.id)).toEqual(['1', '2']);
    });

    it('gives two records with the same name different labels', () => {
        const refs = { Kane: { kind: 'npc', id: 'n1' } };
        expect(uniqueLabel('Kane', refs, 'npc', 'n1')).toBe('Kane');
        expect(uniqueLabel('Kane', refs, 'npc', 'n2')).toBe('Kane (2)');
    });

    it('continues lists on Enter and ends them on an empty item', () => {
        expect(continueList('- [x] done')).toBe('- [ ] ');
        expect(continueList('  - item')).toBe('  - ');
        expect(continueList('9. nine')).toBe('10. ');
        expect(continueList('- [ ] ')).toBe('');
        expect(continueList('plain')).toBeNull();
    });

    it('drops refs the text no longer mentions and resolves mentions to current names', () => {
        const e = entry();
        expect(Object.keys(pruneRefs('only @[Kane]', e.refs))).toEqual(['Kane']);
        expect(resolveMentions('@[Kane] and @[Ghost]', makeResolver(e.refs, world))).toBe('Kane Rourke and Ghost');
    });
});

describe('journal prompt', () => {
    it('frames Remind as out of character and Show as in the scene, with current names', () => {
        const out = buildArmedContributions(
            [{ entryId: 'e1', mode: 'remind' }, { entryId: 'e2', mode: 'show' }, { entryId: 'gone', mode: 'show' }],
            [entry(), entry({ id: 'e2', title: 'Map' })],
            world,
        );
        expect(out.map((c) => c.id)).toEqual(['journalRemind', 'journalShow']);
        expect(out[0].text).toContain('OUT OF CHARACTER');
        expect(out[0].text).toContain('No one in the story knows');
        expect(out[0].text).toContain("## Kane's boss (Day 12, Sector 4)");
        expect(out[0].text).toContain('meet Kane Rourke\'s boss in Sector 9');
        expect(out[1].text).toContain('SHOWN IN THE SCENE');
        expect(out[1].text).toContain('## Map');
        expect(out[0].order).toBeGreaterThan(600);
        expect(out[1].order).toBeLessThan(700);
    });

    it('returns nothing when nothing is armed', () => {
        expect(buildArmedContributions([], [entry()], world)).toEqual([]);
    });

    const c = (question) => ({
        question,
        excerpt: (s, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s),
        namedIn: (hay, name) => hay.toLowerCase().includes(name.toLowerCase()),
    });

    it('lets Ask GM read open to-dos and the entries a question names', () => {
        const out = buildOocSection(c('what did Kane Rourke want?'), [entry()], world);
        expect(out.lines.join('\n')).toContain('- Find the damn car');
        expect(out.lines.join('\n')).toContain('"Kane\'s boss" (Day 12, Sector 4)');
        expect(out.sources[0]).toMatchObject({ kind: 'journal', id: 'e1' });
    });

    it('never shows Ask GM a private entry', () => {
        expect(buildOocSection(c('Kane Rourke'), [entry({ private: true })], world)).toBeNull();
    });

    it('falls back to recent titles when the question names nothing', () => {
        const out = buildOocSection(c('what now?'), [entry()], world);
        expect(out.lines.join('\n')).toContain('Recent entries: "Kane\'s boss"');
    });
});

describe('journal tables', () => {
    it('repairs hand-edited rows instead of trusting them', () => {
        const rows = repairEntries([
            { id: 'a', title: 5, body: 'x', refs: { K: { kind: 'npc', id: 'n' }, Bad: { kind: 'boss', id: 'z' } }, private: 'yes' },
            { id: 'a', title: 'duplicate' },
            null,
            { title: 'no id' },
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: 'a', title: '', body: 'x', refs: { K: { kind: 'npc', id: 'n' } }, private: false });
        expect(repairMeta({ armed: [{ entryId: 'a', mode: 'show' }, { entryId: 'b', mode: 'shout' }] }).armed).toEqual([{ entryId: 'a', mode: 'show' }]);
        expect(repairMeta(null)).toEqual({ armed: [], lastOpenId: null });
    });
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A ModContext stand-in: just enough host for the lifecycle to run. */
function fakeHost() {
    const tables = new Map([['entries', [entry()]], ['meta', { armed: [], lastOpenId: null }]]);
    const tableSubs = new Map();
    const events = new Map();
    const mounts = {};
    const ctx = {
        data: {
            campaignId: 'c1',
            npcLedger: [{ id: 'n1', name: 'Kane Rourke' }],
            onStageNpcIds: ['n1'],
            playerCharacter: { id: 'pc1', name: 'Ash' },
            location: { currentPlaceId: 'p9', worldDay: 13, ledger: [{ id: 'p9', name: 'Sector 9' }] },
        },
        table: {
            read: vi.fn(async (name) => tables.get(name)),
            write: vi.fn(async (name, value) => {
                tables.set(name, value);
                for (const fn of tableSubs.get(name) ?? []) fn(value);
            }),
            subscribe: vi.fn((name, fn) => {
                const set = tableSubs.get(name) ?? new Set();
                set.add(fn);
                tableSubs.set(name, set);
                return () => set.delete(fn);
            }),
        },
        subscribe: vi.fn(() => () => {}),
        events: { on: vi.fn((name, fn) => { events.set(name, fn); return () => {}; }) },
        mounts: {
            window: vi.fn((decl) => { mounts.window = decl; return { open: vi.fn(), update: vi.fn() }; }),
            header: vi.fn((e) => { mounts.header = e; return { update: vi.fn() }; }),
            composer: vi.fn((e) => { mounts.composer = e; return { update: vi.fn() }; }),
        },
        oocSections: { register: vi.fn((s) => { mounts.ooc = s; }) },
        log: vi.fn(),
    };
    ctx.refresh = async () => ctx;
    return { ctx, tables, events, mounts };
}

describe('journal lifecycle', () => {
    it('sends an armed entry once, then disarms it when the reply is generated', async () => {
        const host = fakeHost();
        onActivate(host.ctx);
        host.events.get('campaign.opened')({ campaignId: 'c1' });
        await settle();

        expect(interceptPrompt({ turnId: 't0', campaignId: 'c1' })).toBeUndefined();

        const root = document.createElement('div');
        const teardown = host.mounts.window.mount(root);
        root.querySelector('.pj-list-item').click();
        [...root.querySelectorAll('.pj-btn')].find((b) => b.textContent === 'Remind GM').click();
        teardown();
        expect(host.tables.get('meta').armed).toEqual([{ entryId: 'e1', mode: 'remind' }]);
        expect(host.mounts.composer.state()).toMatchObject({ label: 'Journal · 1', tone: 'active' });

        const out = interceptPrompt({ turnId: 't1', campaignId: 'c1' });
        expect(out.contributions[0].text).toContain('Kane Rourke');

        // A failed turn keeps it armed; only the matching turn's reply disarms.
        host.events.get('turn.generated')({ turnId: 'other', campaignId: 'c1' });
        expect(host.tables.get('meta').armed).toHaveLength(1);
        host.events.get('turn.generated')({ turnId: 't1', campaignId: 'c1' });
        expect(host.tables.get('meta').armed).toEqual([]);
        expect(interceptPrompt({ turnId: 't2', campaignId: 'c1' })).toBeUndefined();
        onDisable();
    });

    it('never subscribes to its own tables, so a stale echo cannot overwrite what was typed', async () => {
        const host = fakeHost();
        onActivate(host.ctx);
        host.events.get('campaign.opened')({ campaignId: 'c1' });
        await settle();
        expect(host.ctx.table.subscribe).not.toHaveBeenCalled();
        onDisable();
    });

    it('refuses to bind when the first read fails, rather than overwrite the journal on disk', async () => {
        const host = fakeHost();
        host.ctx.table.read = vi.fn(async () => { throw new Error('[facade] no active campaign'); });
        onActivate(host.ctx);
        host.events.get('campaign.opened')({ campaignId: 'c1' });
        await settle();
        const root = document.createElement('div');
        const teardown = host.mounts.window.mount(root);
        expect(root.textContent).toContain('Open a campaign');
        teardown();
        expect(host.ctx.table.write).not.toHaveBeenCalled();
        onDisable();
    });

    it('stamps a new entry with the day and current place, and the window edits it', async () => {
        const host = fakeHost();
        onActivate(host.ctx);
        host.events.get('campaign.opened')({ campaignId: 'c1' });
        await settle();

        const root = document.createElement('div');
        document.body.append(root);
        const teardown = host.mounts.window.mount(root);
        expect(root.textContent).toContain("Kane's boss");

        root.querySelector('.pj-side-head .pj-btn--primary').click();
        const saved = host.tables.get('entries');
        expect(saved).toHaveLength(2);
        expect(saved[0].stamp).toEqual({ day: 13, place: 'Sector 9' });

        const textarea = root.querySelector('.pj-textarea');
        textarea.value = '- [ ] call @';
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        textarea.dispatchEvent(new Event('input'));
        const options = [...root.querySelectorAll('.pj-pop-item')].map((n) => n.textContent);
        expect(options[0]).toContain('Ash');
        expect(options.some((o) => o.includes('Kane Rourke'))).toBe(true);

        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        expect(textarea.value).toBe('- [ ] call @[Kane Rourke] ');

        teardown();
        const written = host.tables.get('entries')[0];
        expect(written.body).toBe('- [ ] call @[Kane Rourke] ');
        expect(written.refs).toEqual({ 'Kane Rourke': { kind: 'npc', id: 'n1' } });
        root.remove();
        onDisable();
    });

    it('shows the window as empty until a campaign is open', () => {
        const root = document.createElement('div');
        const teardown = mountJournal(root, {
            getState: () => ({ campaignId: null, entries: [], meta: { armed: [] } }),
            world: () => world, candidates: () => [], subscribe: () => () => {},
        });
        expect(root.textContent).toContain('Open a campaign');
        teardown();
    });
});
