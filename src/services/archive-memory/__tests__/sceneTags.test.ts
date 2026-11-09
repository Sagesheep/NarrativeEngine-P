import { describe, expect, it } from 'vitest';
import type { ArchiveIndexEntry, SceneHook } from '../../../types';
import {
    SCENE_TAG_GROUPS,
    closeHookPatches,
    computePairIdf,
    computeTagIdf,
    countOpenHooksByPerson,
    deriveActiveTags,
    hooksNamedInText,
    parseSceneHooks,
    parseSceneTags,
    renderSceneTagList,
    scoreOpenHooks,
    scorePersonTagPairs,
    scoreSceneTags,
    tagsCuedByText,
} from '../sceneTags';

const entry = (over: Partial<ArchiveIndexEntry>): ArchiveIndexEntry => ({
    sceneId: '001', timestamp: 1, keywords: [], npcsMentioned: [], witnesses: [], userSnippet: '', ...over,
});
const hook = (over: Partial<SceneHook> = {}): SceneHook => ({
    id: '001:0', type: 'promise', with: ['Therese Soll'], what: 'Findings first.', status: 'open', ...over,
});

describe('tag vocabulary', () => {
    it('never uses one tag in two groups, so a tag has one weight', () => {
        const all = Object.values(SCENE_TAG_GROUPS).flat();
        expect(new Set(all).size).toBe(all.length);
    });

    it('is generic: scene kind and activity, plus a short meaning where a tag is ambiguous', () => {
        const list = renderSceneTagList();
        expect(list).toContain('- kind: combat, danger (a threat with no fight yet)');
        expect(list).toContain('- activity: conversation');
    });
});

describe('parseSceneTags', () => {
    it('keeps defined tags, in flat or grouped form, ignoring capitals', () => {
        expect(parseSceneTags({ Combat: 3, activity: { travel: 2 } })).toEqual({ combat: 3, travel: 2 });
    });

    it('drops invented or content-specific tags and non-numeric levels', () => {
        expect(parseSceneTags({ soll_deal: 3, combat: 'high' })).toEqual({});
    });

    it('clamps levels to 1-3 and rounds', () => {
        expect(parseSceneTags({ combat: 9, horror: 0, mystery: 1.6 })).toEqual({ combat: 3, horror: 1, mystery: 2 });
    });

    it('keeps the three strongest tags in a group', () => {
        expect(parseSceneTags({ combat: 1, danger: 3, horror: 2, mystery: 3 })).toEqual({ danger: 3, mystery: 3, horror: 2 });
    });

    it.each([[null], ['combat'], [['combat']]])('treats %j as no tags', (raw) => {
        expect(parseSceneTags(raw)).toEqual({});
    });
});

describe('parseSceneHooks', () => {
    it('builds open hooks with ids from the scene', () => {
        expect(parseSceneHooks([{ type: 'Debt', with: ['Pell', 3], what: ' Owes three gold. ' }], '014')).toEqual([
            { id: '014:0', type: 'debt', with: ['Pell'], what: 'Owes three gold.', status: 'open' },
        ]);
    });

    it('skips unknown types and empty text, and numbers only what it keeps', () => {
        const hooks = parseSceneHooks([{ type: 'vibes', what: 'x' }, { type: 'secret', what: '' }, { type: 'secret', what: 'Kept.' }], '014');
        expect(hooks.map(h => h.id)).toEqual(['014:0']);
    });

    it('caps a scene at three hooks', () => {
        const raw = Array.from({ length: 5 }, () => ({ type: 'threat', what: 'Danger.' }));
        expect(parseSceneHooks(raw, '014')).toHaveLength(3);
    });
});

describe('current-turn tags', () => {
    it('reads cues from word starts in any capitalisation', () => {
        expect(tagsCuedByText('I Open the LETTER and start reading', 1)).toEqual({ reading_message: 1 });
        expect(tagsCuedByText('We keep fighting', 1)).toEqual({ combat: 1 });
    });

    it('does not cue on a word that merely contains a cue', () => {
        expect(tagsCuedByText('a heated discussion', 1)).toEqual({});
    });

    it('reads the player message, then weakly the last scene', () => {
        const active = deriveActiveTags(
            [entry({ sceneId: '009', tags: { downtime: 3 } }), entry({ sceneId: '010', tags: { travel: 3 } })],
            'I draw my sword and attack',
        );
        expect(active.combat).toBe(1);
        expect(active.travel).toBeCloseTo(0.3);
        expect(active.downtime).toBeUndefined();
    });

    it('falls back to the newest tagged scene when the turn gives no cue', () => {
        expect(deriveActiveTags([entry({ sceneId: '004', tags: { romance: 3 } })], 'Hmm.')).toEqual({ romance: 0.3 });
    });
});

describe('scoreSceneTags', () => {
    it('scores only tags matching now', () => {
        // active 1 × level 3/3 × kind 1 × idf 2 × scale 6 = 12
        expect(scoreSceneTags(entry({ tags: { combat: 3, travel: 3 } }), { combat: 1 }, { combat: 2 })).toBe(12);
    });

    it('a shared tone is worth far less than a shared kind of scene', () => {
        const idf = { tense: 1, combat: 1 };
        const tone = scoreSceneTags(entry({ tags: { tense: 3 } }), { tense: 1 }, idf);
        const kind = scoreSceneTags(entry({ tags: { combat: 3 } }), { combat: 1 }, idf);
        expect(tone).toBeLessThan(kind / 2);
    });

    it('is zero for untagged scenes', () => {
        expect(scoreSceneTags(entry({}), { combat: 1 }, {})).toBe(0);
    });
});

describe('computeTagIdf', () => {
    it('a rare tag counts for more than a common one', () => {
        const index = [
            entry({ tags: { tense: 2, romance: 2 } }), entry({ tags: { tense: 2 } }),
            entry({ tags: { tense: 2 } }), entry({ tags: { tense: 2 } }),
        ];
        const idf = computeTagIdf(index);
        expect(idf.romance).toBeGreaterThan(idf.tense);
    });
});

describe('scorePersonTagPairs', () => {
    const rinRomance = entry({ sceneId: '001', witnesses: ['Rin Holmes'], tags: { romance: 3 } });
    const rinCombat = entry({ sceneId: '002', witnesses: ['Rin Holmes'], tags: { combat: 3 } });

    it('separates the same person in different kinds of scene', () => {
        const index = [rinRomance, rinCombat];
        const pairIdf = computePairIdf(index);
        const named = { 'rin holmes': 1 };
        expect(scorePersonTagPairs(rinRomance, { romance: 1 }, named, pairIdf)).toBeGreaterThan(0);
        expect(scorePersonTagPairs(rinCombat, { romance: 1 }, named, pairIdf)).toBe(0);
    });

    it('needs the person named in the current exchange', () => {
        const pairIdf = computePairIdf([rinRomance]);
        expect(scorePersonTagPairs(rinRomance, { romance: 1 }, { 'rin holmes': 0.3 }, pairIdf)).toBe(0);
        expect(scorePersonTagPairs(rinRomance, { romance: 1 }, {}, pairIdf)).toBe(0);
    });

    it('a pair that appears everywhere counts for less than a rare one', () => {
        const common = Array.from({ length: 8 }, (_, i) => entry({ sceneId: String(i + 10), witnesses: ['Rin Holmes'], tags: { tense: 3, conversation: 3 } }));
        const index = [...common, entry({ sceneId: '050', witnesses: ['Rin Holmes'], tags: { romance: 3, conversation: 3 } })];
        const idf = computePairIdf(index);
        expect(idf['rin holmes|romance']).toBeGreaterThan(idf['rin holmes|conversation']);
    });

    it('reads people from witnesses and named NPCs, ignoring capitals', () => {
        const scene = entry({ npcStrengths: { 'Therese Soll': 0.7 }, tags: { negotiation: 3 } });
        expect(scorePersonTagPairs(scene, { negotiation: 1 }, { 'therese soll': 1 }, computePairIdf([scene]))).toBeGreaterThan(0);
    });
});

describe('scoreOpenHooks', () => {
    it('scores an open hook about someone in the current exchange', () => {
        expect(scoreOpenHooks(entry({ hooks: [hook()] }), { 'therese soll': 1 })).toBe(4);
    });

    it('matches on a single name word', () => {
        expect(scoreOpenHooks(entry({ hooks: [hook()] }), { therese: 0.7 })).toBeCloseTo(2.8);
    });

    it('ignores closed hooks, absent people and names from older messages', () => {
        expect(scoreOpenHooks(entry({ hooks: [hook({ status: 'closed' })] }), { therese: 1 })).toBe(0);
        expect(scoreOpenHooks(entry({ hooks: [hook()] }), { pell: 1 })).toBe(0);
        expect(scoreOpenHooks(entry({ hooks: [hook()] }), { therese: 0.3 })).toBe(0);
    });

    it('is not triggered by title words like "the"', () => {
        expect(scoreOpenHooks(entry({ hooks: [hook({ with: ['The Broker'] })] }), { the: 1 })).toBe(0);
    });

    it('counts a scene once however many hooks match', () => {
        const hooks = [hook(), hook({ id: '001:1' })];
        expect(scoreOpenHooks(entry({ hooks }), { therese: 1 })).toBe(4);
    });

    it('weights down hooks about someone with many open hooks', () => {
        const counts = countOpenHooksByPerson([
            entry({ hooks: Array.from({ length: 12 }, (_, i) => hook({ id: `001:${i}`, with: ['Rin'] })) }),
            entry({ sceneId: '002', hooks: [hook({ id: '002:0', with: ['Pell'] })] }),
        ]);
        expect(counts).toEqual({ rin: 12, pell: 1 });
        // 12 hooks → √(3/12) = 0.5 of the full score
        expect(scoreOpenHooks(entry({ hooks: [hook({ with: ['Rin'] })] }), { rin: 1 }, counts)).toBeCloseTo(2);
        expect(scoreOpenHooks(entry({ hooks: [hook({ with: ['Pell'] })] }), { pell: 1 }, counts)).toBe(4);
    });
});

describe('hooksNamedInText', () => {
    it('keeps hooks about someone the text names', () => {
        const hooks = [hook(), hook({ id: '002:0', with: ['Pell'] })];
        expect(hooksNamedInText(hooks, 'Therese reads the letter.').map(h => h.id)).toEqual(['001:0']);
    });
});

describe('closeHookPatches', () => {
    it('closes only the named hook and keeps the rest of the scene', () => {
        const other = hook({ id: '001:1' });
        const patches = closeHookPatches([entry({ hooks: [hook(), other] })], ['001:0'], '050');
        expect(patches).toEqual([{ sceneId: '001', hooks: [{ ...hook(), status: 'closed', closedBy: '050' }, other] }]);
    });

    it('does nothing for unknown or already closed hooks', () => {
        expect(closeHookPatches([entry({ hooks: [hook({ status: 'closed', closedBy: '040' })] })], ['001:0', '9:9'], '050')).toEqual([]);
    });
});
