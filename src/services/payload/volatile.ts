import type { GameContext, InventoryItemCategory, ChatMessage, NPCEntry, SceneEventType, LocationEntry, PlayerCharacter } from '../../types';
import { CORE_FLOOR_TRAITS } from '../../types';
import { countTokens } from '../infrastructure/tokenizer';
import { minifyBookkeepingStub, minifySelectedInventory, minifySelectedProfile } from '../turn/contextMinifier';
import { queryTraits, formatTraitsForContext } from '../retrieval/semanticMemory';
import type { TraceCollector } from './traceCollector';
import { connectionBand } from '../locationParser';
import { formatDayRange } from '../location/distance';

export function buildVolatile(opts: {
    context: GameContext;
    inventoryCategories?: (InventoryItemCategory | 'equipped')[];
    profileFields?: string[];
    budgetVolatile: number;
    collector: TraceCollector;
    plannerEventTypes?: SceneEventType[];
    userMessage?: string;
    history?: ChatMessage[];
    npcLedger?: NPCEntry[];
    locationLedger?: LocationEntry[];
    directorWorldFacts?: string[];
    directorBrief?: string;
}): { volatileContent: string; volatileTokens: number } {
    const { context, inventoryCategories, profileFields, budgetVolatile, collector, plannerEventTypes, userMessage, history, npcLedger, locationLedger, directorWorldFacts, directorBrief } = opts;

    // --- 5. Volatile State (Profile, Inventory) — Smart Injection ---
    // WO-I: capture each module's text so we can emit per-module trace rows with previews
    // (was one lumped 'Profile/Inventory' row). volatileContent/volatileTokens stay byte-identical.
    const volatileParts: string[] = [];
    let characterBlock = '';
    let inventoryBlock = '';
    let profileBlock = '';
    let notebookBlock = '';
    let locationBlock = '';
    let travelBlockStr = '';

    const hasSmart = context.smartBookkeepingActive;
    const hasStructured = (context.inventoryItems?.length ?? 0) > 0 || context.characterProfileData?.name;

    if (hasSmart && hasStructured) {
        // Stub is always injected (cheap, prevents total amnesia)
        const stub = minifyBookkeepingStub(context.characterProfileData!, context.inventoryItems || []);
        if (stub) {
            // WO-A §5: the PC signature kit is an anti-drift floor — the PC-side
            // analogue of `buildCoreDirective` for NPCs — so it must ride the
            // always-injected stub here too, not only the `[CHARACTER PROFILE]`
            // branch below. Before this, a campaign with smart bookkeeping on never
            // saw the PC kit at all. The two branches are mutually exclusive, so the
            // line is never emitted twice.
            const kitLine = buildPcKitLine(context.playerCharacter);
            characterBlock = kitLine
                ? `[CHARACTER]\n${stub}\n${kitLine}`
                : `[CHARACTER]\n${stub}`;
            volatileParts.push(characterBlock);
        }

        // Recommender-selected categories / fields
        const anyInventory = context.inventoryItems && context.inventoryItems.length > 0;
        const anyProfile = context.characterProfileData && context.characterProfileData.name;

        if (anyInventory && inventoryCategories && inventoryCategories.length > 0) {
            const invBlock = minifySelectedInventory(context.inventoryItems, inventoryCategories);
            if (invBlock) {
                inventoryBlock = `[INVENTORY]\n${invBlock}`;
                volatileParts.push(inventoryBlock);
            }
        }
        if (anyProfile && profileFields && profileFields.length > 0) {
            const profBlock = minifySelectedProfile(context.characterProfileData, profileFields);
            if (profBlock) {
                profileBlock = `[PROFILE]\n${profBlock}`;
                volatileParts.push(profileBlock);
            }
        }
    } else if (context.characterProfileActive && context.characterProfile) {
        // WO-G: structured PC profile — scene-aware trait retrieval via queryTraits.
        // Core floor (CORE_FLOOR_TRAITS=5) always injects; extended tier filtered by
        // planner eventTypes + entity match + 400-token budget. legacyNotes is storage-only.
        const profile = context.characterProfile;
        if (profile.activeTraits?.length || profile.identity?.name || profile.stats) {
            const selected = queryTraits(
                profile.activeTraits ?? [],
                userMessage ?? '',
                history ?? [],
                npcLedger ?? [],
                plannerEventTypes,
                400,
                CORE_FLOOR_TRAITS,
            );
            let profileText = formatTraitsForContext(profile, selected);
            const kitLine = buildPcKitLine(context.playerCharacter);
            if (kitLine) {
                profileText = profileText.replace(
                    /\[END CHARACTER PROFILE\]$/,
                    `${kitLine}\n[END CHARACTER PROFILE]`,
                );
            }
            if (profileText) {
                const profileSceneTag = context.characterProfileLastScene && context.characterProfileLastScene !== 'Never'
                    ? `Last Updated: Scene #${context.characterProfileLastScene}`
                    : '';
                profileBlock = profileSceneTag ? `${profileSceneTag}\n${profileText}` : profileText;
                volatileParts.push(profileBlock);
            }
        }
    }
    if (!hasSmart && context.inventoryActive && context.inventory) {
        // Legacy fallback
        const inventorySceneTag = context.inventoryLastScene && context.inventoryLastScene !== 'Never'
            ? `Last Updated: Scene #${context.inventoryLastScene}`
            : 'NEVER AUTO-UPDATED — may be stale';
        inventoryBlock = `[PLAYER INVENTORY — ${inventorySceneTag}]\n${context.inventory}`;
        volatileParts.push(inventoryBlock);
    }
    // ── [LOCATION] block (WO-Location) — the place-analogue of [INVENTORY].
    // Emits the resolved current place + description + nearby connections + known
    // features. Hard-capped at ~400 chars (truncate features first, then Nearby).
    // Zero-regression: emits nothing when there is no resolved current place, so
    // campaigns that never use the location ledger see no change.
    {
        const locBlock = buildLocationBlock(context, locationLedger ?? []);
        if (locBlock) {
            locationBlock = locBlock;
            volatileParts.push(locationBlock);
        }
    }
    // ── [TRAVEL] block (WO3 §8) — sibling of [LOCATION], emitted only when the
    // party is mid-journey. Hard cap 200 chars. The stop instruction is the entire
    // point of this work order: a leg advances whether or not the scene is about
    // travel, so the GM is told where to end the scene.
    {
        const travelBlock = buildTravelBlock(context, locationLedger ?? []);
        if (travelBlock) {
            travelBlockStr = travelBlock;
            volatileParts.push(travelBlockStr);
        }
    }
    if (context.mapWorldSetting) {
        const settingBlock = `[MAP WORLD SETTING]\n${String(context.mapWorldSetting.label).slice(0, 80)}: ${String(context.mapWorldSetting.guidance).slice(0, 700)}\nApply this setting to new scene details, encounters and characters. Preserve established campaign facts and history.`;
        volatileParts.push(settingBlock);
        collector.addTrace({ source: 'Map world setting', classification: 'volatile_state', tokens: countTokens(settingBlock), reason: 'Player-selected world setting', included: true, position: 'system_dynamic', preview: settingBlock });
    }
    const encounterBlock = buildMapEncounterBlock(context);
    if (encounterBlock) {
        volatileParts.push(encounterBlock);
        collector.addTrace({ source: 'Checkpoint encounter', classification: 'volatile_state', tokens: countTokens(encounterBlock), reason: 'Saved current-checkpoint situation', included: true, position: 'system_dynamic', preview: encounterBlock });
    }
    const discoveriesBlock = buildMapDiscoveriesBlock(context);
    if (discoveriesBlock) {
        volatileParts.push(discoveriesBlock);
        collector.addTrace({ source: 'Map discoveries', classification: 'volatile_state', tokens: countTokens(discoveriesBlock), reason: 'Sites observed at the current checkpoint', included: true, position: 'system_dynamic', preview: discoveriesBlock });
    }
    if (context.notebookActive && context.notebook && context.notebook.length > 0) {
        // Notebook is the only unbounded volatile source. Reserve whatever budget remains after the
        // higher-priority character/inventory/profile parts and admit newest-first entries until full,
        // so a large notebook can't silently overrun the context window.
        const usedTokens = countTokens(volatileParts.join('\n\n'));
        const notebookBudget = budgetVolatile > 0 ? Math.max(0, budgetVolatile - usedTokens) : Infinity;
        const sorted = context.notebook
            .slice()
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, 50);
        const wrap = (lines: string[]) => `[SCENE NOTEBOOK — Volatile Working Memory]\n${lines.join('\n')}\n[END NOTEBOOK]`;
        const acceptedLines: string[] = [];
        let droppedNotes = 0;
        for (const n of sorted) {
            const candidate = [...acceptedLines, `▸ ${n.text}`];
            if (notebookBudget === Infinity || countTokens(wrap(candidate)) <= notebookBudget) {
                acceptedLines.push(`▸ ${n.text}`);
            } else {
                droppedNotes = sorted.length - acceptedLines.length;
                break;
            }
        }
        if (acceptedLines.length > 0) {
            notebookBlock = wrap(acceptedLines);
            volatileParts.push(notebookBlock);
        }
        if (droppedNotes > 0) {
            collector.addTrace({ source: 'Scene Notebook', classification: 'volatile_state', tokens: 0, reason: `Trimmed ${droppedNotes} notebook entr${droppedNotes === 1 ? 'y' : 'ies'} to fit volatile budget (${budgetVolatile} t)`, included: false, position: 'system_dynamic' });
        }
    }

    const volatileContent = volatileParts.join('\n\n');
    const volatileTokens = countTokens(volatileContent);
    // WO-I: per-module trace rows with previews (was one lumped row).
    if (characterBlock) collector.addTrace({ source: 'Character Stub', classification: 'volatile_state', tokens: countTokens(characterBlock), reason: 'Smart bookkeeping character stub', included: true, position: 'system_dynamic', preview: characterBlock });
    if (inventoryBlock) collector.addTrace({ source: 'Inventory', classification: 'volatile_state', tokens: countTokens(inventoryBlock), reason: 'Player inventory', included: true, position: 'system_dynamic', preview: inventoryBlock });
    if (profileBlock) collector.addTrace({ source: 'Player Profile', classification: 'volatile_state', tokens: countTokens(profileBlock), reason: hasSmart ? 'Recommender-selected profile fields' : 'Scene-selected PC traits', included: true, position: 'system_dynamic', preview: profileBlock });
    if (notebookBlock) collector.addTrace({ source: 'Scene Notebook', classification: 'volatile_state', tokens: countTokens(notebookBlock), reason: 'Volatile working memory notebook', included: true, position: 'system_dynamic', preview: notebookBlock });
    if (locationBlock) collector.addTrace({ source: 'Location', classification: 'volatile_state', tokens: countTokens(locationBlock), reason: 'Current place + nearby connections + known features', included: true, position: 'system_dynamic', preview: locationBlock });
    if (travelBlockStr) collector.addTrace({ source: 'Travel', classification: 'volatile_state', tokens: countTokens(travelBlockStr), reason: 'Active journey leg + stop instruction', included: true, position: 'system_dynamic', preview: travelBlockStr });
    if (directorWorldFacts && directorWorldFacts.length > 0) {
        const worldFactsText = directorWorldFacts.join('\n');
        const currentPlace = context.currentPlaceId ? locationLedger?.find(place => place.id === context.currentPlaceId) : undefined;
        const travelTrace = `[travel-spike] day=${context.worldDay} at=${currentPlace?.name ?? '?'} facts=${directorWorldFacts.length} directorBrief=${directorBrief ? 'yes' : 'no'}`;
        collector.addTrace({ source: travelTrace, classification: 'world_context', tokens: countTokens(worldFactsText), reason: 'Travel facts supplied to the Continuity Director', included: true, position: 'director_brief', preview: `<world_facts>\n${worldFactsText}\n</world_facts>` });
        collector.addSection({ label: 'Director world_facts', role: 'utility', tokens: countTokens(worldFactsText), content: `<world_facts>\n${worldFactsText}\n</world_facts>`, classification: 'world_context' });
    }
    collector.addSection({ label: 'Profile/Inventory', role: 'system', tokens: volatileTokens, content: volatileContent, classification: 'volatile_state' });

    return { volatileContent, volatileTokens };
}

// ── [LOCATION] block builder (WO-Location + WO2-Clock) ─────────────────
// Format (verbatim from workorder §5.2 + WO2 §2):
//   [LOCATION]
//   Day: <worldDay>           ← first body line, only when worldDay is set
//   At: <name> (<broadLocation>)<currentFeature ? ` — <feature>` : ''><status ? ` — <status>` : ''>
//   <description>
//   Nearby: <connection names, band in parens when not local, comma-separated>
//   Known rooms/features: <features, comma-separated>
//
// Hard cap ~400 chars. Truncate `features` first (drop entries from the end), then `Nearby`.
// The `Day:` line is exempt from the trim order (~8 chars, the most load-bearing fact in
// the block); it sits first and survives every trim step including the hard slice.
// Zero-regression: when `worldDay` is unset the `Day:` line is absent and the block is
// byte-identical to the pre-clock output. Returns '' only when there is NEITHER a resolved
// place NOR a `worldDay` (a day with no place still emits `[LOCATION]\nDay: N`).
const LOCATION_BLOCK_CHAR_CAP = 400;

export function buildLocationBlock(context: GameContext, ledger: LocationEntry[]): string {
    const hasDay = context.worldDay !== undefined && Number.isFinite(context.worldDay);
    const dayLine = hasDay ? `Day: ${context.worldDay}` : '';

    const placeId = context.currentPlaceId;
    const place = placeId ? ledger.find(l => l.id === placeId) : undefined;

    // Day with no place: emit the date and nothing else. Neither day nor place: ''.
    if (!place) return dayLine ? `[LOCATION]\n${dayLine}` : '';

    const featureSuffix = context.currentFeature ? ` — ${context.currentFeature}` : '';
    const statusSuffix = place.status ? ` — ${place.status}` : '';
    const header = `At: ${place.name} (${place.broadLocation || '?'})${featureSuffix}${statusSuffix}`;

    // Nearby: local remains bare; every other band teaches the scale and its
    // baseline day range. Legacy short values normalize to local above.
    // Transit nodes (WO3 §3) are excluded — they are roads, not destinations.
    const nearbyParts: string[] = [];
    for (const conn of place.connections) {
        const other = ledger.find(l => l.id === conn.toId);
        if (!other) continue;
        if (other.kind === 'transit') continue;
        const band = connectionBand(conn);
        nearbyParts.push(band === 'local'
            ? other.name
            : band === 'adjacent'
                ? `${other.name} (${band})`
                : `${other.name} (${band}, ${formatDayRange(band).replace(' days', 'd').replace(' day', 'd')})`);
    }
    const nearbyLine = nearbyParts.length > 0 ? `Nearby: ${nearbyParts.join(', ')}` : '';

    // Known rooms/features
    const featuresLine = place.features.length > 0 ? `Known rooms/features: ${place.features.join(', ')}` : '';

    // Assemble. `dayLine` leads the body when present; `.filter(Boolean)` drops it
    // when empty so the no-worldDay path is byte-identical to the pre-clock block.
    const assemble = (featLine: string, nearLine: string) => {
        const lines = [dayLine, header, place.description || '', nearLine, featLine].filter(Boolean);
        return `[LOCATION]\n${lines.join('\n')}`;
    };

    let block = assemble(featuresLine, nearbyLine);
    if (block.length <= LOCATION_BLOCK_CHAR_CAP) return block;

    // Trim features one entry at a time
    const features = [...place.features];
    while (block.length > LOCATION_BLOCK_CHAR_CAP && features.length > 0) {
        features.pop();
        const featLine = features.length > 0 ? `Known rooms/features: ${features.join(', ')}` : '';
        block = assemble(featLine, nearbyLine);
    }
    if (block.length <= LOCATION_BLOCK_CHAR_CAP) return block;

    // Then drop Nearby entirely
    block = assemble(features.length > 0 ? `Known rooms/features: ${features.join(', ')}` : '', '');
    if (block.length <= LOCATION_BLOCK_CHAR_CAP) return block;

    // Last resort: hard truncate. `Day:` is first and ~8 chars, so it survives.
    return block.slice(0, LOCATION_BLOCK_CHAR_CAP);
}

// ── [TRAVEL] block builder (WO3 §8) ─────────────────────────────────────
// Sibling of [LOCATION], emitted immediately after it, only when
// `context.travel` is set. Hard cap 200 chars. Format:
//
//   [TRAVEL]
//   Day 2 of 3 — Point A → Point B by cart.
//   End this scene at nightfall. Do not reach Point B.
//
// Final leg replaces the second line with the arrival instruction. Constrained
// agency replaces the second line with the control line. Zero-regression: a
// context with no `travel` produces '' (byte-identical volatile payload).
const TRAVEL_BLOCK_CHAR_CAP = 200;

export function buildTravelBlock(context: GameContext, ledger: LocationEntry[]): string {
    const travel = context.travel;
    if (!travel) return '';

    const from = ledger.find(l => l.id === travel.fromId);
    const to = ledger.find(l => l.id === travel.toId);
    const fromName = from?.name ?? travel.fromId;
    const toName = to?.name ?? travel.toId;
    const modeWord = travel.mode; // lowercase id — "foot", "cart", "horseback", "flying"

    const headerLine = `Day ${travel.leg} of ${travel.totalLegs} — ${fromName} → ${toName} by ${modeWord}.`;

    let secondLine: string;
    if (travel.agency === 'constrained') {
        secondLine = 'The party does not control this journey. Stay at this checkpoint; the engine advances travel.';
    } else {
        secondLine = `Stay at this checkpoint. Do not advance travel or arrive at ${toName}; the player moves with Travel.`;
    }

    const block = `[TRAVEL]\n${headerLine}\n${secondLine}`;
    if (block.length <= TRAVEL_BLOCK_CHAR_CAP) return block;

    // The cap holds. If names are very long, hard truncate — the header line
    // carries the load-bearing facts (which leg, which destinations, which mode).
    return block.slice(0, TRAVEL_BLOCK_CHAR_CAP);
}

/**
 * PC Signature Kit line for the [CHARACTER PROFILE] block (WO-A §5).
 * Reads the PC record from `context.playerCharacter` (WO-A rewrite 2 §2 — D1:
 * the PC is no longer a row in `npcLedger`). When the PC has a `signatureKit`,
 * emits one bounded line: `Kit: <equipment> | Powers: <abilities> | element: <element>`.
 * Empty segments are omitted; the line is omitted entirely when there is no kit
 * or no PC record. Returns '' so the caller can skip insertion (byte-identical
 * to the pre-kit payload when there is no kit — regression guard).
 *
 * Legacy `npcLedger.find(n => n.isPC)` fallback: if `playerCharacter` is null
 * but a stray `isPC` row exists in `npcLedger` (defensive — should not happen
 * post-migration), we still read the kit off it. This keeps the payload stable
 * even if a future bug re-introduces a PC row.
 */
export function buildPcKitLine(pc: PlayerCharacter | null | undefined, npcLedger?: NPCEntry[]): string {
    let kitOwner: PlayerCharacter | undefined = pc ?? undefined;
    if (!kitOwner && npcLedger) {
        kitOwner = npcLedger.find(n => n.isPC);
    }
    if (!kitOwner || !kitOwner.signatureKit) return '';
    const kit = kitOwner.signatureKit;
    const segments: string[] = [];
    if (kit.equipment.length > 0) segments.push(`Kit: ${kit.equipment.join(', ')}`);
    if (kit.abilities.length > 0) segments.push(`Powers: ${kit.abilities.join(', ')}`);
    if (kit.element) segments.push(`element: ${kit.element}`);
    return segments.length > 0 ? segments.join(' | ') : '';
}


export function buildMapDiscoveriesBlock(context: GameContext): string {
    const data = context.mapDiscoveries;
    if (!data || data.placeId !== context.currentPlaceId || data.worldDay !== context.worldDay
        || data.leg !== (context.travel?.leg ?? null) || !data.sites?.length) return '';
    const lines = data.sites.slice(0, 4).map(site =>
        `${site.distance === 0 ? 'At this cell' : 'Nearby, not yet reached'}: ${String(site.name).slice(0, 80)} (${site.type}). ${String(site.description ?? '').slice(0, 160)}`);
    return `[MAP DISCOVERIES]\n${lines.join('\n')}\nKeep saved identities consistent. Discovery does not move the party; roleplay is optional.`;
}


export function buildMapEncounterBlock(context: GameContext): string {
    const event = context.mapEncounter;
    if (!event || event.placeId !== context.currentPlaceId || event.worldDay !== context.worldDay
        || event.leg !== (context.travel?.leg ?? null)) return '';
    const settingChanged = context.mapWorldSetting && (event.worldProfile ?? 'fantasy') !== context.mapWorldSetting.id;
    const situation = settingChanged ? 'The player changed the world setting. The previous encounter is historical; do not reintroduce its participants or premise as a new encounter.'
        : event.status !== 'available' ? 'This situation has already been handled or left behind. Do not restart it.'
        : event.quiet ? 'Quiet checkpoint. No encounter is required.'
            : event.events.slice(0, 3).map(row => `${String(row.title).slice(0, 80)}: ${String(row.text).slice(0, 300)}`
                + (row.actor ? `\nSaved participant: ${String(row.actor.name).slice(0, 80)} (${String(row.actor.role).slice(0, 80)}; identity ${String(row.actor.id).slice(0, 80)}). Motive: ${String(row.actor.motive).slice(0, 200)}.` : '')).join('\n');
    return `[CHECKPOINT SITUATION]\nWeather: ${event.weather}. Terrain: ${event.biome}.\n${event.scene ? String(event.scene).slice(0, 400) + '\n' : ''}${situation}\n${event.note ? 'Saved player outcome note: ' + JSON.stringify(String(event.note).slice(0, 1200)) + '\n' : ''}Continue from established conversation and saved identities; do not replay the introduction each turn. Local details must fit the terrain and reached sites. A camp request plays the camp scene here; it does not advance a travel leg or relocate the party.\nRoleplay is optional. Do not force movement, damage, rewards or resolution; the player chooses whether to engage and when to Travel.`;
}
