/**
 * Phase 9.2 — THE FROZEN SURFACE, enumerated and pinned.
 *
 * This file is the machine-readable half of the compatibility promise in
 * `docs/MODDING.md` §"Compatibility and the frozen surface" and `COMPAT.md`.
 * The promise is:
 *
 *   • Inside a generation (`MOD_API_VERSION`) the public surface is **additive
 *     only**. Nothing enumerated below is removed, renamed, or re-signatured.
 *   • A breaking change bumps the generation. The bump is the announcement.
 *   • Nothing NOT enumerated below is promised at all.
 *
 * **Why a test rather than a document.** A policy nobody can violate by
 * accident is worth more than one everybody agrees with. Every list here is
 * exact — an addition fails just as loudly as a removal — so widening the
 * public surface is a deliberate edit to this file, made by someone who has
 * read the sentence above it, rather than a field that quietly appeared and
 * that a third party then depended on. That is the whole mechanism:
 * *anything reachable will be reached*, so reachability must be a decision.
 *
 * **What to do when this test fails.**
 *   • You ADDED something and it belongs on the surface → add it to the list
 *     here, to `docs/MODDING.md`, and to `docs/narrative-mod-api.d.ts`. Three
 *     places, on purpose: the surface is not "whatever the code exposes".
 *   • You ADDED something internal that leaked → do not add it here. Take it
 *     back off the surface.
 *   • You REMOVED or RENAMED something → that is a breaking change. It needs a
 *     `MOD_API_VERSION` bump, and the bump needs a release. There is no
 *     third option, and "no third party has shipped a mod using it yet" is not
 *     one either — the freeze is what makes the first one possible.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { MOD_API_VERSION, DEFAULT_MOD_API_VERSION } from '@narrative/engine/mods/apiVersion';
import { MOUNT_BUDGET } from '../mounts/mountTypes';

const DTS_PATH = path.join(process.cwd(), 'docs', 'narrative-mod-api.d.ts');
const MODDING_PATH = path.join(process.cwd(), 'docs', 'MODDING.md');
const dts = fs.readFileSync(DTS_PATH, 'utf-8');

/** Every `export interface X` / `export type X` name in the shipped `.d.ts`. */
function exportedTypeNames(): string[] {
    return [...dts.matchAll(/^export (?:interface|type) ([A-Za-z0-9_]+)/gm)].map((m) => m[1]);
}

/**
 * The member names of one exported interface. Deliberately crude — it reads
 * the block between the interface's opening brace and the first column-0 `}`,
 * and takes the leading identifier of every member line. A doc comment, a
 * blank line and a nested object literal all fall out; that is enough to catch
 * a rename or a removal, which is what this pin is for.
 */
function membersOf(name: string): string[] {
    const start = dts.search(new RegExp(`^export interface ${name}\\b[^{]*\\{`, 'm'));
    if (start === -1) throw new Error(`interface ${name} not found in the shipped .d.ts`);
    const body = dts.slice(start).split(/^\}/m)[0];
    const members = new Set<string>();
    for (const line of body.split('\n')) {
        const m = /^ {4}(?:readonly )?([A-Za-z_][A-Za-z0-9_]*)\s*[?(:<]/.exec(line);
        if (m) members.add(m[1]);
    }
    return [...members].sort();
}

describe('Phase 9.2 — the generation number', () => {
    it('is a positive integer, and an undeclared manifest defaults to 1', () => {
        expect(Number.isInteger(MOD_API_VERSION)).toBe(true);
        expect(MOD_API_VERSION).toBeGreaterThanOrEqual(1);
        // Never `MOD_API_VERSION`: promoting an undeclared manifest to the
        // current generation erases the signal the mismatch check reads.
        expect(DEFAULT_MOD_API_VERSION).toBe(1);
    });

    it('is generation 1 — the generation this freeze ratifies', () => {
        // When this fails, the bump was deliberate and every list below was
        // re-read. That is the intended workflow, not an obstacle to it.
        expect(MOD_API_VERSION).toBe(1);
    });
});

describe('Phase 9.2 — the frozen surface: the shipped .d.ts', () => {
    it('exports exactly the frozen type set', () => {
        expect(exportedTypeNames().sort()).toEqual([
            // Host value types a mod reads
            'AiTier', 'ArchiveIndexEntry', 'ChatMessage', 'CharacterProfile',
            'DivergenceEntry', 'DivergenceRegister', 'GameContextPatch',
            'InventoryItem', 'LocationEntry', 'LocationSuggestion', 'LoreChunk',
            'ModChapter', 'ModNpcEntry', 'ModNpcPatch', 'NPCEntry',
            'PlayerCharacter', 'SceneStakes', 'TimelineEvent',
            // WO 6.2 — travel state, read-only by the map mod to draw the party
            'TravelHop', 'TravelMode', 'TravelState',
            // The model broker
            'ModelRequest', 'ModelResponse', 'ModelRole',
            // The context and its sub-APIs
            'ModApi', 'ModBudgetsApi', 'ModConfig', 'ModContext', 'ModData',
            'ModEventsApi', 'ModFactsApi', 'ModIdentity', 'ModLocation',
            'ModMacrosApi', 'ModModel', 'ModMountsApi', 'ModOocSectionsApi',
            'ModTables', 'ModTokensApi', 'ModWrites',
            // Events
            'AnyEventName', 'CoreEventName', 'ModEventPayload', 'ModEvents',
            'ModScopedEventName', 'PayloadFor',
            // Mounts
            'ChromeEntry', 'ChromeState', 'ChromeTone', 'MessageContentSlot',
            'MessageRef', 'MountHandle', 'RailPanel', 'WindowDeclaration',
            'WindowHandle',
            // Macros, interception, facts, budgets, Ask-GM sections
            'BudgetAllocationContext', 'BudgetAllocator', 'FactPublisher',
            'MacroResolver', 'OocSection', 'OocSectionContext', 'OocSectionOutput',
            'PromptContribution', 'PromptInterception', 'PromptInterceptor',
            'PromptInterceptorInput',
            // Service roles (added to the .d.ts by 9.2 — see the ModRolesApi note)
            'MemoryRecallAnswer', 'MemoryRecallInput', 'ModRolesApi', 'ServiceRoleId',
            // Hook signatures
            'ModComputeHook', 'NativeHook',
        ].sort());
    });

    it('pins ModContext — the one object a mod is handed', () => {
        expect(membersOf('ModContext')).toEqual([
            'api', 'budgets', 'config', 'data', 'events', 'facts', 'log',
            'macros', 'mod', 'model', 'mounts', 'oocSections', 'refresh',
            'roles', 'signal', 'subscribe', 'table', 'tokens', 'write',
        ].sort());
    });

    it('pins the sub-API method sets', () => {
        expect(membersOf('ModApi')).toEqual(['apiVersion', 'commitPoint', 'suppressibleIds', 'version']);
        expect(membersOf('ModIdentity')).toEqual(['id', 'name', 'version']);
        expect(membersOf('ModTables')).toEqual(['read', 'subscribe', 'write']);
        expect(membersOf('ModEventsApi')).toEqual(['emit', 'off', 'on', 'once']);
        expect(membersOf('ModRolesApi')).toEqual(['provide']);
        expect(membersOf('ModMountsApi')).toEqual(
            ['composer', 'header', 'messageAction', 'messageBelow', 'rail', 'window'],
        );
        expect(membersOf('ModMacrosApi')).toEqual(['register']);
        expect(membersOf('ModFactsApi')).toEqual(['register']);
        expect(membersOf('ModBudgetsApi')).toEqual(['claim']);
        expect(membersOf('ModTokensApi')).toEqual(['count']);
        expect(membersOf('ModOocSectionsApi')).toEqual(['register']);
        expect(membersOf('MountHandle')).toEqual(['remove', 'update']);
        expect(membersOf('MessageRef')).toEqual(['id', 'role', 'sceneId']);
    });

    it('pins ModData — every host read a mod may perform', () => {
        expect(membersOf('ModData')).toEqual([
            'archiveIndex', 'campaignId', 'chapters', 'characterSheet',
            'divergenceRegister', 'inventory', 'location', 'loreChunks',
            'messages', 'npcLedger', 'onStageNpcIds', 'playerCharacter',
            'playerInput', 'timeline',
        ].sort());
    });

    it('pins ModWrites — every host write a mod may perform', () => {
        expect(membersOf('ModWrites')).toEqual([
            'addLocationSuggestions', 'addMessage', 'addNpcSuggestions',
            'archiveNPC', 'requestBackup', 'restoreNPC', 'setCharacterSheet',
            'setDivergenceRegister', 'setInventory', 'setLocationLedger',
            'updateContext', 'updateNPC', 'updatePlayerCharacter',
        ].sort());
    });

    it('pins the core event names', () => {
        const block = dts.slice(dts.indexOf('export interface ModEvents')).split(/^\}/m)[0];
        const names = [...block.matchAll(/^ {4}'([a-zA-Z.]+)':/gm)].map((m) => m[1]).sort();
        expect(names).toEqual([
            'app.modsChanged', 'app.ready',
            'archive.chapterSealed', 'archive.sceneAppended',
            'campaign.closing', 'campaign.opened',
            'message.continued', 'message.deleted', 'message.edited', 'message.swiped',
            'settings.changed', 'settings.presetChanged', 'settings.tierChanged',
            'turn.aborted', 'turn.commitFailed', 'turn.committed', 'turn.failed',
            'turn.generated', 'turn.payloadBuilt', 'turn.start',
        ].sort());
        // EVENTS.md §1: twenty core events, and the count is part of the
        // promise — a twenty-first is an addition, a nineteenth is a break.
        expect(names).toHaveLength(20);
    });
});

describe('Phase 9.2 — the frozen surface: the runtime constants', () => {
    it('pins the six mount regions and their per-mod budgets', () => {
        // A region id is a public string a third party writes into their code.
        // MOUNTS.md §2.1 already called renaming one a breaking change; this is
        // that sentence with teeth.
        expect(MOUNT_BUDGET).toEqual({
            'header.actions': 2,
            'composer.actions': 2,
            'message.actions': 3,
            'chat.rail': 1,
            'message.below': 1,
            'window.layer': 3,
        });
    });
});

describe('Phase 9.2 — the freeze is published where an author will see it', () => {
    it('MODDING.md carries the compatibility section, not the old "not frozen yet" warning', () => {
        const modding = fs.readFileSync(MODDING_PATH, 'utf-8');
        expect(modding).toContain('## Compatibility and the frozen surface');
        // The pre-9.2 warning promised a freeze "when Phase 9.2 ratifies it".
        // Leaving it beside the ratification would be the worst of both.
        expect(modding).not.toContain('This format is not frozen yet');
        expect(modding).not.toContain('not promising a stable contract');
    });

    it('MODDING.md and the .d.ts agree on the generation number', () => {
        const modding = fs.readFileSync(MODDING_PATH, 'utf-8');
        expect(modding).toContain(`mod API generation **${MOD_API_VERSION}**`);
        expect(dts).toContain(`generation ${MOD_API_VERSION}`);
    });

    it('states loudly that everything under src/ is not promised', () => {
        const modding = fs.readFileSync(MODDING_PATH, 'utf-8');
        // The one rule only holds if the consequence of breaking it is stated
        // in advance (9.2 §2.4).
        expect(modding).toContain('never imports from `src/`');
        expect(modding).toMatch(/## What is NOT frozen/);
    });
});
