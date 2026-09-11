# World Map delivery milestones

Updated 2026-09-08. Deliver one reviewable milestone per run to conserve quota.
Use one lead by default; delegate only when the user requests it and the task
can be isolated. Do not replay work orders whose implementation already exists.

## Product contract

The player chooses a destination and walks an overworld route in daily steps.
Each Travel/Continue press moves the party and advances one day without an LLM.
The player can roleplay at the checkpoint until choosing to move again.
The engine supplies geography and situations; the GM supplies identity and prose.

## 1. Travel timing and browser journey — COMPLETE

Implemented:
- N advertised days = N presses, final press arrives; N - 1 camps.
- Exact map days survive both single-hop and multi-hop departure.
- Intermediate place reached at its hop boundary.
- No synthetic A-to-C shortcut when travelling A-to-B-to-C.
- Existing authored distance bands survive travel.
- Flying line ends at the real destination and carries cumulative cell costs.
- Camp labels and GM payload obey the engine-owned movement contract.

Verification:
- Production build (`npm run build`) passes; targeted implementation/harness lint passes.
- Full regression run: 4,512 of 4,513 tests passed. The remaining failure is
  `src/components/block-view/__tests__/renderArtifact.test.ts`: its output
  folder `Upgrade/EPIC PROJECT - Modularity/Project 5 - Block Architecture`
  was absent before this work. Existing deletions there were left untouched.
- Subsequent focused run after adding authored-band preservation: 158 tests pass.
- Browser: two tests pass through actual mod controls, event bus, React bridge,
  Zustand actions and canvas. Four-day flight traverses checkpoints, survives
  reload and arrives on day 14 from day 10; Abandon clears travel without arrival.
- Browser persistence is a scratch session-storage adapter, with every /api
  request intercepted. No real campaign was used. This verifies the control/state/
  renderer seam, not production disk hydration or an actual story-provider call.

Commands:
```
npx playwright test --config e2e/worldMapTravel.config.ts
npx vitest run src/services/turn/__tests__/departureComposer.test.ts src/services/turn/__tests__/travelState.test.ts src/services/turn/__tests__/travelState.multiHop.test.ts src/services/mods/__tests__/worldMapJourney.test.js src/services/__tests__/locationParser.test.ts
```

The browser config starts Vite only, at 127.0.0.1:5175. Fixture files live under
`e2e/fixtures`; they are not part of the production app entry point.

## 2. Road-aware routes and position continuity — COMPLETE (2026-09-08)

- Party coordinates persist by occupied place; abandon/reload/redepart keeps
  the exact checkpoint. Visited terrain freezes at that cell.
- A separate `trails` table stores undirected ground segments and a replay-safe
  journey cursor. Only traversed segments gain wear: 10%, 20%, then 30% less
  travel cost. Flying creates no trails. Terrain still controls passability.
- Tan physical trails draw the same segments the pathfinder discounts. Dashed
  ledger links show topology, not a claimed physical highway.
- Fastest accounts for terrain and trails; shortest minimizes distance but
  reports real travel cost. The selector appears only when costs differ.
- Places/composer departure pickers open the same map route preview when the
  mod is active. The player reviews exact days and commits there. With the
  mod disabled, the existing topology-only departure remains available.
- Journey clearing writes an empty object: unlike JSON null, it passes the
  production HTTP parser. The reader normalizes it to no active journey.

Verification:
- 642 affected regression tests pass; production build and targeted TS lint pass.
- Four Chromium tests cover flight arrival, stopped-cell reload/redepart,
  external picker preview, and ground trails surviving reload without extra wear.
- Ground browser terrain is an explicitly seeded plains fixture, using the
  existing visited-cell format; it does not change a real campaign.
- `server/__tests__/worldMapPersistence.test.js` uses the real mod-table HTTP
  routes and a temporary data directory, then recreates the server registry
  and mod caches. It verifies ground costs, persisted coordinates, no replay
  wear, and final-day trail recording with the map window closed.
- This covers production mod-table disk persistence, not a complete app startup
  and campaign-hydrator end-to-end test. No real campaign or provider was used.

## 3. Persistent discoveries — COMPLETE

### 3a. Seeded sites and saved identity — COMPLETE

- Seeded settlement, ruin, shrine, camp, crossing and landmark slots with
  per-type minimum spacing, biome eligibility/density and trail affinity.
- Surveyed areas and discovered IDs/coordinates persist; later terrain or trail
  changes do not regenerate surveyed sites or erase saved absences.
- Discovered site cells are hardened to preserve their geography.
- Map markers and a nearby-site panel let the player save names/details. These
  are retained on revisit/reload; no model is called to discover or name a slot.
- GM context distinguishes nearby observations from the current cell and is
  scoped to the current place/day/leg, preventing stale discoveries after travel.
- 672 affected regression tests pass. Five browser tests cover the travel flow
  and naming/reloading a site; a production mod-table disk test also checks identity.

### 3b. Visiting and feature stops — COMPLETE

- Visit/Enter site promotes a discovered slot into the Places ledger once,
  creates reciprocal connections, and preserves subsequent ledger edits.
- Fixed site coordinates and associated transit anchors are overlaid outside
  the relational layout solver. Identity changes cannot move a discovered site.
- Nearby and previously discovered sites can be selected for a terrain-priced
  route. Active travel must be abandoned before choosing a new destination.
  Entering a site at the occupied cell requires no additional travel day.
- Known sites already on a route can replace a nearby overnight checkpoint
  only when both adjacent travel days fit their cost budgets. Features do not
  move, off-route detours are not invented, and the advertised day count stays fixed.
- Checkpoint site names survive journey serialization and appear in the journey panel.
- Promoted sites use the normal Places edit workflow; name/description edits
  are reflected back into discovery records and survive reload/revisit.

Verification: 684 affected tests pass, production build passes, targeted
browser-fixture lint passes. Six Chromium tests include visiting, ledger rename,
reload, leaving for another place, and returning to the same fixed site. Backend
mod-table coverage checks persistence of the fixed promoted anchor. Off-route
feature detours/push-on alternatives remain outside this conservative stop rule.

Original milestone contract:

- Seeded feature placement with biome-dependent density, per-type spacing and
  road affinity: settlements, ruins, shrines, camps, crossings and landmarks.
- Stable feature IDs/positions; identity authored on engagement and retained.
- Discoveries visible in checkpoint UI and GM context; revisit the same place.
- Prefer reachable features for overnight stops without moving the features.

Done when travelling reveals persistent places worth investigating and revisits
preserve identities. Do not make model calls merely to advance movement.

## 4. Encounters and checkpoint roleplay — COMPLETE

- Deterministic feature, biome and weather event tables, plus weighted authored
  combinations. A combination replaces its constituent events.
- Quiet outcomes are explicit; events are consumed once and recorded.
- Clear checkpoint presentation and context for voluntary roleplay.
- No event gating in the first version, per the latest travel decision.

Done when a journey produces coherent situations, roleplay stays at the current
stop, and repeated views/reloads cannot reroll an encounter.

Implemented and verified 2026-09-09:

- Weather is seeded by region and world day. Feature, biome and weather
  situations can compose; finite authored combinations have higher selection
  weight without being guaranteed, and replace the base events when selected.
- The campaign encounters table records the first outcome per cell/day,
  including quiet outcomes. Reloads, identity edits and same-day revisits
  retain that result. Leaving closes available situations; Mark handled saves
  completion immediately. Neither action awards anything or advances time.
- A checkpoint panel displays the situation, weather and six recent records.
  The full journal persists in the mod table, separate from the chat timeline.
  The first occupied location is also recorded when the mod activates.
- GM context is limited to the current place/day/leg. Quiet and handled records
  explicitly prevent new encounters or restarts; roleplay cannot advance Travel.
  No model calls are needed to roll a checkpoint or move.
- 797 affected regression tests and seven Chromium tests pass. Production build
  and targeted TypeScript lint pass. Browser coverage checks saved outcomes,
  handling, reload and continued travel; backend coverage checks the encounter
  journal through actual mod-table HTTP/disk storage and fresh mod activation.
- Browser tests use a fixture campaign and intercepted APIs. No real campaign,
  provider call, or full campaign-hydrator restart was exercised. Authored event
  variety and game balance still need playtesting.

## Deferred

Mutation/decay, blocking-event resolution, extra biome types, animation and
repeat-journey compression need separate scoped work. Preserve existing terrain
classification and visited cells. Do not expand these milestones silently.


## Live-play correction — 2026-09-09

The previous fixture used a simplified live context and did not prove the
production host boundary. It now uses buildHostFacade/buildModContext with
frozen snapshots, real reactive subscriptions and real commit callbacks;
only storage and window mounts remain fixture adapters.

- Routine departure, advance and arrival no longer append chat messages.
  Movement updates map/state; events remain in the checkpoint panel and
  player-authored camping/roleplay uses normal chat.
- A stale duplicate departure request cannot restart an active journey.
- ModLocation now exposes optional travelMode, matching the snapshot and
  subscription projections. The map previously read data.context, which is
  not part of the public ModData surface, and fell back to walking.
- Seven existing browser scenarios pass through the actual host boundary.
  An eighth replays the reported saved cart route: reload at (499,498), then
  Continue to (496,494), with day/leg advancement and no added chat message.
- 647 affected regressions passed before the additional duplicate-departure
  test; the updated bridge suite passes all 11 tests. Production build passes.
  Expanded lint finds eight pre-existing any-type errors in modContext.ts;
  the other checked files pass.
- The user's campaign was inspected read-only. Its route start day and current
  day disagree, consistent with stale loaded map code; the open browser runtime
  could not be inspected because the browser-control tool failed. Fully reload
  the application to load changed native mod modules before live verification.


## Gameplay phase — agreed 2026-09-10

### G1. Encounters and roleplay — IMPLEMENTED; ready for live playtest
- Context-eligible, varied encounters at the occupied checkpoint: worn-path travellers,
  wildlife appropriate to terrain, activity at reached sites, and weather situations.
- Saved local scene, participant identity, motive and interaction suggestion. Reopening,
  renaming or reloading never rerolls an observed scene. Nearby sites are not occupied sites.
- Reply and camp controls prepare editable text in the normal story composer; the player
  sends it through the existing GM turn flow. Free-text play uses the same scoped facts.
- Optional outcome notes persist with the encounter; handling/departure prevents restarting.
- Quiet movement remains silent. No automatic combat, rewards, time advance or paid model call.
- Verify eligibility, persistence, GM payload, stale-action rejection and browser interaction.
  Provider narration remains subject to real-campaign playtesting.

### G2. Places and roads — PLANNED
Persistent usable places, terrain-aware generated road connections, and manual waypoint paths.

### G3. Geography and biome expansion — PLANNED
Coherent elevation/climate/moisture regions and transitions; volcanic, snowy, dead-zone,
sand and swamp variants with distinct travel, discoveries, encounters and art.

G1 verification: 257 map/bridge/payload/backend checks and 12 Chromium scenarios passed;
production build and targeted TypeScript lint passed. Browser checks cover an actual
floating window closing into a prepared story draft, unchanged position/day/messages,
identity/outcome reload, handled-state controls and camp drafts. No paid provider was called.
New scene details apply to newly observed checkpoints; existing saved encounters are kept.
Road travellers currently require a physical trail with at least two recorded passes;
ledger connection lines alone are not generated roads (G2). Participants are saved in the
encounter journal; automatic promotion into fully simulated NPC-ledger agents is deferred.
Outcome notes are player-authored; story consequences still use the ordinary GM pipeline.


### G1a. World-setting selection — IMPLEMENTED 2026-09-10
- Saved World setting dropdown: Fantasy, Historical / low-tech, Modern day, Cyberpunk,
  Science fiction, Post-apocalyptic. Missing/invalid older settings default to Fantasy.
- 15 additional profile-specific local encounters join the original 12 local templates.
  Eligibility combines setting, terrain and physical trail presence; site participants
  adapt to the setting. Science fiction avoids assuming Earth wildlife.
- The selected label/guidance is appended to the ordinary story payload in normal and
  debug modes. New details must fit the setting and established campaign lore.
- Existing rolls, participants and notes remain historical. Switching settings does not
  reroll a stop; old-setting event premises are suppressed until a newly observed stop.
- Selection does not regenerate terrain, roads, place identities or sprites. G2/G3 must
  consume this same saved profile when those generators are expanded.
- Verification: 342 affected tests, all 13 browser scenarios, production build and
  targeted lint pass. Tests include dropdown/layer persistence, next-stop generation,
  profile eligibility and full outgoing payload constraints. No provider call was made.


### G2A. Free-cell exploration and fog — IMPLEMENTED 2026-09-11
Every reachable grid cell can be previewed and committed as a fixed destination.
Exploration persists both discoveries and empty results; settlements obey tier-dependent
spacing, including authored places. Fog reveals the traversed corridor and current sight
radius, retains explored ground and allows known lore locations to remain marked.
No terrain is revealed merely by panning or previewing a route. Existing journeys and
place identities remain valid. Roads/manual waypoint construction follow in G2B.


G2A delivery details:
- Exact-cell destination previews replace the old two-cell anchor requirement. The
  context menu now previews Travel here even on empty cells; committing saves a fixed,
  nameable exploration point and then performs the normal terrain-priced journey.
- Empty points use plain markers, not town sprites. They survive rename, reload,
  travelling away and returning. Impassable ground endpoints are not silently snapped.
- Settlement spacing in cells: village 8, town 12, city 24, capital 40. For mixed tiers,
  the smaller tier sets separation, so villages can surround capitals. Generated
  candidates compete deterministically and respect already saved/authored places.
  Legacy unclassified authored places use town spacing; names explicitly containing
  capital/city get those tiers. Existing conflicting places are never deleted/moved.
- Sight radius is two cells. Travel reveals its traversed corridor, persists explored
  ground, and surveys along that corridor. Known ledger markers remain above fog;
  unknown terrain hover details are hidden. Fog can be toggled as a map layer.
- Older saves seed exploration from recorded physical trails when no exploration
  table exists. Other unrecorded historical travel cannot be reconstructed.
- New exploration storage is registered in the bundled manifest and tested through
  the backend's actual JSON-file routes. No real campaign was modified by tests.
- 263 affected tests and all 14 browser scenarios verified. One browser navigation
  hit Windows ERR_NO_BUFFER_SPACE before loading; its isolated rerun passed.
  Build and targeted lint passed. Place generation still uses sparse seeded slots;
  this milestone does not populate every cell with a settlement or generate roads.


## Three-state fog correction — 2026-09-11

Exploration schema v2 persists generatedCells independently from remembered cells.
Legacy explored cells migrate without erasing known ground. Current visibility is
computed from party position; it is never used as proof that generation finished.
Generation is committed only after terrain and discovery/empty results have saved.

Visible generated terrain is bright; generated terrain outside sight is dim; ungenerated
terrain stays dark. Known ledger markers may appear above that darkness without revealing
surrounding terrain. Hover text and the map legend distinguish these states. The Fog
checkbox controls remembered-terrain dimming; it cannot reveal ungenerated terrain.
The renderer and shoreline neighbour lookups read only generated cells, so panning does
not generate terrain content. Pathfinder/solver terrain sampling remains provisional
calculation for route pricing and geography constraints, not saved exploration.

Tests cover independent states, old-save migration, unknown-cell read prevention,
preview without generation, remembered ground after movement, and reload persistence.


## G2B. Roads and manual paths — COMPLETE 2026-09-11
Terrain-aware road proposals between known connected places and nearby discovered
settlements; manual waypoint footpaths/roads with preview, naming, undo and save.
Separate saved geometry affects pathfinding without stacking discounts or bypassing
terrain. Preview/save never moves the party, advances time or reveals terrain.
Saved roads can be removed; existing authored ledger connections remain untouched.


G2B delivery details:
- Open Roads and paths, then Generate roads to review proposals and Save roads to
  commit them. Candidates follow known ledger connections and connect discovered
  settlements to their nearest known place within 40 cells. Wilderness exploration
  points are excluded; existing saved endpoint pairs are not generated again.
- Draw path accepts 2–12 waypoint cells, with Undo waypoint, Footpath/Cart road,
  an optional name, preview, save and removal. Each segment is limited to 160 cells;
  generation proposes at most 24 connections per run. Impassable or snapped endpoints
  are rejected; this milestone does not build bridges or change terrain.
- Roads and paths persist separately from actual travelled trails. Roads reduce
  terrain travel cost by 30%, footpaths by 10%; overlapping surfaces use the strongest
  discount without stacking. Terrain passability still applies. Already committed
  journeys retain their original schedule; future previews use the saved surfaces.
- Saved geometry draws beneath fog, while editing previews remain visible. Drawing,
  generating and saving do not explore cells, spend time, move the party or call AI.
  Authored ledger connections remain untouched. Saved paths survive reload and can
  be removed from the same panel; road save/remove feedback stays visible.
- Verified: 252 map/backend tests, all 16 browser scenarios, production build and
  targeted lint pass. Backend coverage exercises real JSON-file persistence; browser
  coverage exercises manual save/reload/remove and duplicate-free generated proposals.
  Dependency import graph refreshed. No live campaign or paid AI provider was used.
