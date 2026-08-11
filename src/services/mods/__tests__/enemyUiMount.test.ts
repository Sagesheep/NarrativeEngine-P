import { afterEach, describe, expect, it } from 'vitest';
import enStrings from '../../../../public/bundled-mods/enemies/i18n/en.json';
import plStrings from '../../../../public/bundled-mods/enemies/i18n/pl.json';
import koStrings from '../../../../public/bundled-mods/enemies/i18n/ko.json';
import { applyLocale, registerModTranslations, t, translateIn } from '../../../i18n';
import { mountEnemyCompendium, repaintEnemyWindows } from '../../../../public/bundled-mods/enemies/ui.js';

const stopSubscriptions = () => () => {};
const repair = value => value;

const makeApi = () => ({
    state: {
        compendium: [],
        instances: [],
        encounters: [],
        resolutions: [],
        config: { enabled: false, enemyDiscoveryEnabled: false, promptContextEnabled: true },
    },
    data: {},
    repairCompendium: repair,
    repairInstances: repair,
    repairEncounters: repair,
    repairResolutions: repair,
    repairConfig: repair,
    getSuggestions: () => [],
    setSuggestions: () => {},
});

afterEach(() => {
    applyLocale('en');
    registerModTranslations([]);
    document.body.replaceChildren();
});

describe('enemy mod UI mount', () => {
    it('renders the mod namespace and switches its PL/KO strings at runtime', () => {
        registerModTranslations([{
            id: 'enemies',
            i18nStrings: { en: enStrings, pl: plStrings, ko: koStrings },
        }]);
        globalThis.__narrativeTranslate = translateIn;
        const root = document.createElement('div');
        document.body.append(root);
        const ctx = {
            table: { subscribe: stopSubscriptions },
            log: () => {},
        };
        const unmount = mountEnemyCompendium(root, ctx, makeApi());

        applyLocale('en');
        expect(t('mod.enemies.modal.tab.templates' as never)).toBe(enStrings['modal.tab.templates']);
        expect(t('mod.enemies.header.open.label.off' as never)).toBe('Enemies: OFF');

        applyLocale('pl');
        expect(t('mod.enemies.modal.tab.templates' as never)).toBe(plStrings['modal.tab.templates']);
        expect(t('mod.enemies.modal.tab.templates' as never)).not.toBe(enStrings['modal.tab.templates']);
        expect(t('mod.enemies.header.open.label.on' as never)).toBe('Przeciwnicy: WŁĄCZONE');

        applyLocale('ko');
        expect(t('mod.enemies.modal.tab.templates' as never)).toBe(koStrings['modal.tab.templates']);
        expect(t('mod.enemies.modal.title' as never)).toBe(koStrings['modal.title']);
        expect(t('mod.enemies.modal.title' as never)).toBe('적 도감');

        unmount();
    });

    // Phase 8.5 — the assertions above pass on a window whose every label reads
    // `[object Object]`, which is what shipped: they prove the STRINGS resolve
    // through the host, not that the MOUNT renders them. The mod called
    // `__narrativeTranslate(key, vars)` while the host's is
    // `translateIn(locale, key, vars)`, so every lookup passed the key as a
    // locale and got `{}` back, and `node()` stringified it into the DOM.
    //
    // So: read the rendered tree, not the translation table.
    it('renders its translated strings into the DOM, not "[object Object]"', () => {
        registerModTranslations([{
            id: 'enemies',
            i18nStrings: { en: enStrings, pl: plStrings, ko: koStrings },
        }]);
        globalThis.__narrativeTranslate = translateIn;
        applyLocale('en');
        const root = document.createElement('div');
        document.body.append(root);
        const unmount = mountEnemyCompendium(root, { table: { subscribe: stopSubscriptions }, log: () => {} }, makeApi());

        expect(root.textContent).not.toContain('[object Object]');
        expect(root.textContent).toContain(enStrings['modal.tab.templates']);

        // And it follows the locale, which is the thing the mod's i18n files
        // exist for. `applyLocale` stamps `data-lang`, which is where the mod
        // reads the current locale from.
        applyLocale('pl');
        const plRoot = document.createElement('div');
        document.body.append(plRoot);
        const unmountPl = mountEnemyCompendium(plRoot, { table: { subscribe: stopSubscriptions }, log: () => {} }, makeApi());

        expect(plRoot.textContent).not.toContain('[object Object]');
        expect(plRoot.textContent).toContain(plStrings['modal.tab.templates']);
        expect(plRoot.textContent).not.toContain(enStrings['modal.tab.templates']);

        unmountPl();
        unmount();
    });

    // Phase 9.9.2 — found by opening a real migrated campaign and looking.
    //
    // The window mounts when the campaign UI renders and paints immediately.
    // `enemyData.hydrate` then fills the shared `state` on `campaign.opened`
    // and used to tell only the header. The window's own `table.subscribe`
    // leases cannot cover the gap: the host revokes every one of them when the
    // campaign id changes (`reactiveReads.ts`), and a fresh lease delivers only
    // on the NEXT store change — a campaign open is not one.
    //
    // So a user whose compendium had just been adopted opened it and saw an
    // empty roster, with their monsters on disk and in memory the whole time.
    // Same mechanism after a campaign switch, one step worse: the window kept
    // the PREVIOUS campaign's records and its editor draft, and saving that
    // draft wrote a foreign monster into the campaign now open. Observed: a
    // 4-record compendium became 5.
    it('repaints a mounted window when hydrate fills the state behind it', () => {
        registerModTranslations([{ id: 'enemies', i18nStrings: { en: enStrings, pl: plStrings, ko: koStrings } }]);
        globalThis.__narrativeTranslate = translateIn;
        applyLocale('en');
        const root = document.createElement('div');
        document.body.append(root);
        const api = makeApi();
        const unmount = mountEnemyCompendium(root, { table: { subscribe: stopSubscriptions }, log: () => {} }, api);

        // Mounted against an empty state — the cold-start case.
        expect(root.querySelectorAll('.enemy-list-row')).toHaveLength(0);

        // What `hydrate` does: assign into the shared state object, no repaint.
        api.state.compendium = [
            { id: 'a', name: 'Ashen Warden', classification: 'Construct', stats: [], actions: [], tags: [] },
            { id: 'b', name: 'Marrow Hound', classification: 'Beast', stats: [], actions: [], tags: [] },
        ];
        expect(root.querySelectorAll('.enemy-list-row')).toHaveLength(0);

        repaintEnemyWindows();

        const rows = [...root.querySelectorAll('.enemy-list-row')].map(row => row.textContent);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toContain('Ashen Warden');
        expect(rows[1]).toContain('Marrow Hound');

        // An unmounted window is not repainted, and a stale painter cannot throw.
        unmount();
        expect(() => repaintEnemyWindows()).not.toThrow();
        expect(root.querySelectorAll('.enemy-list-row')).toHaveLength(0);
    });
});