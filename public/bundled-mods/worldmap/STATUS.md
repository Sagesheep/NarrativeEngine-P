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

## What is NOT done

1. **Roads cost the pathfinder nothing.** `cellCost` reads biome only, so a
   route will cut across open country beside a road the map itself drew. The
   intended fix is to wear roads in through the existing `visited` hardening —
   walked routes become cheap — rather than declaring them. See MASTERPLAN
   §6.1(a).
2. **`departMultiHop` sets `totalLegs` to the day count, not the camp count.**
   Camps are days − 1, so a multi-hop journey takes one press too many at the
   end. Single-hop is correct only by accident of the `bandFromLegs` →
   `legsFor` round trip.
3. **WORKORDER 7 (features) and 8 (events) are unbuilt.** These are load-bearing,
   not decorative: with travel now paced one press per day, a checkpoint with
   nothing to say makes a journey nine clicks of nothing. WO 8's model is
   designed; neither is written up as a work order.
4. **Alternative routes (shortest vs fastest) are not offered**, and only become
   interesting once (1) exists.
5. **Checkpoints do not snap to reachable features** — blocked on WO 7.
6. **More biome *types* have not been added.** Deliberately deferred: re-authoring
   the Whittaker table re-classifies existing campaigns' terrain, and hardened
   cells keep their frozen biome, so a played campaign would come back
   patchworked. That is a decision to take deliberately, not a silent change.
7. **Pressing Continue is not tested end to end in a browser.** Both halves are
   covered separately — the panel dispatches `continue`, the bridge advances a
   leg on that event — but not joined, because the dev server writes to
   `data/campaigns/` and a travel press would mutate a real save. It needs a
   scratch campaign.

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
