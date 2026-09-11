# World Map — status: UNFINISHED



**Version 0.3.0 · work in progress. Do not treat this mod as done.**



It is shipped enabled because a half-built map that draws real terrain and

walks a real journey is more useful than a hidden one — but the feature is

mid-build, and the list below is the honest state of it.



## What works, and is verified



Verified means *checked in a real browser* (`e2e/worldMapTerrain.spec.ts`,

`e2e/worldMapApp.spec.ts`) or by unit tests over the real code path — not

merely "the suite is green".



- The field solve: places anchored from ledger relations, terrain-aware

  placement, hardened cells frozen on visit.

- Terrain rendering: twelve biomes each drawn in their own colour with eight

  textured variants, hillshade, contour lines, coastal shading, a tile pyramid

  with LRU eviction.

- Routing: A\* over the chunk grid, per-mode impassable sets, multi-hop through

  the ledger graph, terrain-priced day counts, camps placed on real cost.

- Travel as an engine action: one press, one day, one camp, no LLM call.

  Depart / Continue / Abandon from the map panel, the Places panel and the

  composer, all through the same functions.

- One route at a time; the committed journey and a route preview cannot both

  be on screen.



## Milestone 1 — completed 2026-09-07



See [MILESTONES.md](./MILESTONES.md) for the current delivery sequence.

Historical work-order filenames are not an accurate queue for this checkout.



- Total legs consistently means total travel days, including arrival. N days

  now takes N presses, with N - 1 camps. Exact map durations bypass band rounding.

- Multi-hop boundaries put the party at the intermediate place on its arrival

  day. Departing A -> B -> C does not create an A -> C shortcut or overwrite

  existing authored distance bands.

- Flying uses a real Bresenham cell line with cumulative costs. It ends at the

  destination and produces all daily checkpoints.

- The GM travel block keeps roleplay at the current checkpoint; it no longer

  instructs prose-driven arrival or forces every scene to end at nightfall.

- Real map controls, the mod event path, React bridge and Zustand actions are

  exercised together in `e2e/worldMapTravel.spec.ts`, including Continue,

  reload, arrival and abandonment. Storage is a session-storage scratch adapter;

  the production filesystem persistence path is not covered by this fixture.



## What is NOT done



1. **Checkpoint events remain unfinished.** Authored encounter combinations,
   quiet outcomes and once-only consumption are milestone 4.
2. **Off-route feature detours and push-on alternatives are not implemented.**
   Overnight stops currently prefer budget-safe known sites already on the route.
3. **Additional biome types, mutation and decay remain deferred.** Preserve
   existing terrain classifications and visited cells.

## Milestone 2 — completed 2026-09-08

Persisted ground trails now reduce route costs gradually, capped at 30% after
three passes. Only walked segments gain wear; flying leaves none. Tan trails
show physical segments; dashed connections show ledger topology. Fastest and
shortest are offered when their travel costs differ. Places and composer travel
pickers open the same map preview while the mod is active.

Checkpoint coordinates survive abandon/reload/redepart. Production mod-table
HTTP/disk tests caught and fixed the parser rejection of JSON-null journey
clears. Four browser tests and 642 affected regressions pass. See MILESTONES.md
for exact test scope and remaining work.

## Notes for anyone working on this



**Never verify rendering or layout in vitest.** jsdom has no 2D canvas context

and returns 0 for every rect, so canvas tests there are tests of a stub. Use

`e2e/` — Playwright and Chromium are already installed and configured. A bug

that painted *every land cell of every biome one flat green* survived a full

green suite for months and was found in one real-browser run.



Canvas painters in `renderer.js` are held to a documented API subset by

`src/services/mods/__tests__/worldMapAtlas.test.js`. A painter that reaches

outside it throws inside a `requestAnimationFrame`, which means the map draws

nothing while the suite stays green. Widen the subset deliberately, and grow

every canvas stub in the suite with it.



Planning documents live in `Upgrade/WorldMap/` (git-ignored): MASTERPLAN.md

carries the findings log, and the work orders carry their status in the

filename.

## Milestone 3a — discovered sites

Seeded sites are now observed around checkpoints, with type spacing, biome
eligibility and trail affinity. IDs, coordinates, surveyed areas and saved
names/details persist. A nearby-site panel shows observations and accepts
player-authored identity; no model call runs during movement. GM context
labels nearby sites as not yet reached and rejects observations from old stops.

Verified with 672 affected regressions, five Chromium tests, and a backend
mod-table identity round trip. Site visits and conservative on-route feature stops are now complete in 3b.
See MILESTONES.md.

## Milestone 3b — site visits and overnight stops

Discovered sites can be visited, entered at the current cell, and revisited.
Promoted Places-ledger identities retain their fixed map coordinates, and ledger
edits synchronize their names/details. Known sites on the route can become
night stops when adjacent days fit the existing cost budget. Arrival days do
not change and no off-route movement is implied.

684 affected regressions and six browser journeys pass, alongside the production
build and targeted lint. The browser round trip covers ledger rename, reload,
travel away, and return to the same site; backend tests check fixed-anchor storage.


## Milestone 4 — checkpoint situations and optional roleplay

Complete 2026-09-09. Feature, biome and weather tables now produce saved
situations, weighted authored combinations or explicit quiet stops. Each
cell/day is recorded once. Mark handled and departure consume the situation;
reloads and edits cannot reroll it. The map shows the current situation and
recent checkpoint journal, while GM context prevents handled situations from
restarting. Travel remains available throughout.

797 affected regressions, seven Chromium tests, production build and targeted
TypeScript lint pass. The backend disk test verifies encounter persistence;
the browser fixture verifies handling, reload and onward movement. This does
not replace real-campaign playtesting. The four planned milestones are now
implemented; mutation/decay, blocking resolution and off-route detours remain
deferred. See MILESTONES.md for precise scope and verification limits.


## Live-play correction

Travel now updates position/day without routine chat lines. A duplicate
start request cannot replace an active journey. Travel mode is read through
ModLocation rather than a nonexistent data.context field. The browser fixture
now exercises the actual host facade and frozen context. Seven scenarios plus
the reported saved route pass; see MILESTONES.md for verification limits.
A full app reload is needed for already-imported native mod changes.


## Pixel-art presentation — 2026-09-10

Original sprite atlas, pixel ground motifs and connected coasts replace the
old shaded terrain hatchwork. Biomes select trees, mountains, snow vegetation
and marsh trees; sites select village, tent, ruin, shrine or crossing art.
The party uses the blue traveller sprite at its real checkpoint coordinate.
Controls use cream/green styling; the HUD shows day rather than tile-cache
statistics. Grid defaults off; existing explicit preferences remain respected.

The art is a presentation change: no land, roads, discoveries or travel rules
are generated by the visual layer. The illustrated example is not pasted over
campaign geography. See assets/README.md for atlas layout and prompt provenance.
Nine browser checks pass, including transparent asset loading, a terrain visual
fixture and the eight existing movement/identity/persistence flows. Renderer
regressions cover pan caching, scale/layers and biome readouts.


## Open-window refresh correction — 2026-09-10

WindowManager now refreshes the declaration's context before mounting and
rebinds the interior when the active campaign changes. Registration-time
contexts can belong to pre-load/revoked campaign subscriptions; reading fresh
data inside the map did not repair subscriptions made against that old context.
Late refresh results are ignored after close or campaign change, and existing
cleanup runs before rebinding. Drag/resize and normal travel do not remount
the host window.

A browser regression now uses the real floating-window host with a pre-campaign
registration context. It asserts the rendered party-cell attribute, visible
camp number and day after Continue without closing/reopening. All 62 window
unit tests pass, along with production build and targeted lint. The complete
map browser suite includes this scenario alongside the prior nine checks.


## Gameplay G1 — encounters and roleplay — 2026-09-10

New checkpoints save local scenery and varied terrain/site/path encounters, including
road merchants and forest bears. Named participants have saved roles and motives.
Only reached sites generate at-site activity; neighbouring discoveries remain nearby.
A travelled trail must have two passes before it qualifies for road travellers.

Write reply, Look around and Make camp prepare editable text in normal story chat,
closing the floating map. The player sends the draft to their configured GM. Ordinary
free text receives the same current-location scene context. No action silently sends a
model request, advances time, changes position or awards items. Outcome notes persist
with journal entries; handled scenes cannot be restarted through the reply control.
Existing saved rolls remain intact; newly observed stops receive the expanded scenes.

257 affected checks, 12 browser scenarios, build and targeted lint pass. Actual provider
narration is not covered by the isolated browser fixture. See MILESTONES.md for G1 scope
and the planned G2 places/roads and G3 geography/biome work.


## G1a — world settings — 2026-09-10

World setting is now selectable and saved per campaign. Six profiles filter local
encounters and guide the same story AI through its hidden append/debug payload.
Fifteen new local templates include hardware traders, drones, field technicians,
modern rangers and salvage encounters. Saved scenes are not rerolled by a setting
change; older-setting premises stay in history and are excluded from the new prompt.
This is a content setting, not yet a terrain or sprite regeneration control.
G2/G3 will apply it to place, road and biome generation. 342 checks and 13 browser
scenarios pass, alongside build and targeted lint.


## G2A — free-cell exploration and fog — 2026-09-11

Any reachable cell now supports a preview and committed journey. Unnamed cells become
fixed exploration points, remain renameable, and never imply that a town was generated.
Settlement tiers obey separate distance limits, including existing-place exclusions.
Fog retains explored terrain, reveals the actual travelled corridor and hides unknown
hover details while keeping known lore markers visible. The Fog layer toggles it.
Historical recorded trails seed the new exploration table for older saves.

Verified: 263 affected tests, 14 browser scenarios (one infrastructure navigation retry),
backend disk persistence, production build and targeted lint. Browser checks include
empty-cell preview without reveal, arrival, rename/reload, travel away and return.
See MILESTONES.md for spacing defaults, legacy classification and remaining G2B work.


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


## G2B — roads and manual waypoint paths — COMPLETE 2026-09-11

The Roads and paths panel now offers terrain-aware generated proposals and manual
waypoint drawing, preview, surface selection, naming, undo, save and removal.
Roads persist independently from actual travel trails and affect future route costs
without bypassing impassable terrain or stacking discounts. Creation never moves the
party, reveals fog or calls story AI. Existing journeys keep their saved schedule.

Verified: 252 map/backend tests, 16 browser scenarios, production build, targeted lint
and dependency import graph refresh. See MILESTONES.md for candidate rules and limits.
Next planned milestone: G3 biome logic and expanded biome palette.
