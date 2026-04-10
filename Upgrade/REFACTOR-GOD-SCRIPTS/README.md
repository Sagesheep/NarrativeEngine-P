# God Script Decomposition Plan

**Date:** April 2026
**Status:** Phase 1 complete · Phase 2 next
**Estimated Total Effort:** 17-23 hours across 6 phases
**Priority:** Critical - codebase stability and maintainability

---

## Table of Contents

1. [Overview & Motivation](#overview)
2. [Danger Assessment](#danger-assessment)
3. [Guiding Principles](#guiding-principles)
4. [Phase 0: Test Infrastructure](./phase-0-test-infrastructure.md)
5. [Phase 1: server.js Decomposition](./phase-1-server-decomposition.md)
6. [Phase 2: turnOrchestrator.ts Decomposition](./phase-2-orchestrator-decomposition.md)
7. [Phase 3: ChatArea.tsx Decomposition](./phase-3-chatarea-decomposition.md)
8. [Phase 4: CampaignHub.tsx Decomposition](./phase-4-campaignhub-decomposition.md)
9. [Phase 5: Server TypeScript Migration (Optional)](./phase-5-server-typescript.md)
10. [Risk Matrix](#risk-matrix)
11. [Execution Rules](#execution-rules)

---

## Overview

Four files in this codebase have grown into "god scripts" — single files that handle too many
unrelated responsibilities. This makes the codebase fragile: a bug fix in NLP heuristics requires
editing the same 1,819-line file that handles Express routing, LLM proxying, and backup management.

The goal is to **decompose without rewriting**. Every extraction step moves code, not changes logic.

### Target Files

| File | Lines | Responsibilities | Danger Level |
|------|-------|-----------------|--------------|
| `server.js` | 1,819 | 14 domains, 50 routes, 0 Express Routers | **8.5/10** |
| `src/services/turnOrchestrator.ts` | 818 | 10+ subsystems, 5-deep nesting, leaky DI | **9/10** |
| `src/components/ChatArea.tsx` | 956 | 9 concerns, 12 state vars, 6 async pipelines | **8/10** |
| `src/components/CampaignHub.tsx` | 834 | 9 concerns, 13 state vars, lore processing in UI | **7.5/10** |

---

## Danger Assessment

### server.js (8.5/10)
- **50 Express routes** with no use of Express Router for modularization
- **~562 lines of pure business logic** (NLP heuristics + LLM proxy) inlined in the server entry point
- **3 LLM proxy functions** (~347 lines) are near-identical copy-paste (DRY violation)
- **No data access layer** — every route does raw `fs.readFileSync`/`writeFileSync`
- **A single POST handler** spans 147 lines touching 7 domains
- Mitigated by: clear section comments, coherent domain (single app backend), KeyVault already extracted

### turnOrchestrator.ts (9/10)
- **818 lines** with a single exported function containing a 340-line inner `executeTurn`
- **12 direct module imports** + 8+ direct `useAppStore.getState()` calls
- **Deep nesting**: 5 levels deep in streaming callback; archiving code inside callback inside `executeTurn` inside `runTurn`
- **Hidden subsystems**: AI Player system (165 lines) and auto-bookkeeping (30 lines) are completely separate feature domains
- **Leaky DI**: Despite `TurnState`/`TurnCallbacks` types, code still reaches into global store
- Mitigated by: sequential structure is readable, some dependency injection already exists

### ChatArea.tsx (8/10)
- **394 lines of async orchestration** before first JSX line
- **12 useState/useRef** hooks + 7 `useAppStore.getState()` calls
- Directly orchestrates condensation, save-file pipelines, archive rollback, chapter sealing
- Raw `fetch()` calls bypassing the API client
- Mitigated by: coherent scope (chat area), `runTurn` already extracted

### CampaignHub.tsx (7.5/10)
- **13 pieces of local state** for what is conceptually a "landing page"
- **65-line `handleSave`** crossing 4 domain boundaries (file I/O, lore processing, NPC management, engine config)
- Sub-components already extracted (good pattern awareness)
- Mitigated by: concerns loosely related (all campaign-centric)

---

## Guiding Principles

1. **Extract, don't rewrite** — move code verbatim, don't change logic
2. **One phase = one shippable change** — system works after every phase
3. **Tests before extraction** — characterization tests validate the monolith first, then validate extracted modules
4. **Git branch per phase** — each phase gets its own branch, merged only after verification
5. **No logic changes during extraction** — only move code and add imports
6. **App runs after every single step** — manual smoke test after each extraction
7. **Server modules stay .js for now** — TypeScript migration is a separate follow-up phase

---

## Risk Matrix

| Phase | Risk Level | Revert Difficulty | What Could Break |
|-------|-----------|-------------------|------------------|
| Phase 0: Test infra | **None** | N/A | Nothing |
| Phase 1A: Server tests | **None** | Delete test files | Nothing |
| Phase 1B: Server extract | **Low** | Revert git commit | Server routes (each extraction independently shippable) |
| Phase 1C: DRY LLM proxy | **Medium** | Revert commit | LLM extraction functions have subtle prompt/parsing differences |
| Phase 2B: Store coupling fix | **Medium** | Revert commit | ChatArea.tsx callsite changes; must pass all fields |
| Phase 2C: Orchestrator extract | **Medium** | Revert commit | Post-turn pipeline ordering must be preserved exactly |
| Phase 3: ChatArea hooks | **Low-Medium** | Revert commit | Well-understood React pattern |
| Phase 4: CampaignHub | **Low** | Revert commit | Less coupled, simpler extraction |

---

## Execution Rules

### Before Starting
- [ ] All existing tests pass (`npm run test`)
- [ ] App builds and runs correctly
- [ ] Create a git branch: `refactor/phase-N-description`

### After Every Extraction Step
- [ ] Run all tests: `npm run test:run`
- [ ] App still builds: `npm run build`
- [ ] Manual smoke test: app launches, can create campaign, send message, view archive
- [ ] Commit with message: `refactor: extract <module> from <source> (phase N, step X.Y)`

### Only Proceed to Next Phase When
- [ ] All tests pass
- [ ] All extraction steps committed
- [ ] App runs without regressions
- [ ] Phase branch merged to main (or feature branch)

---

## Estimated Effort

| Phase | Steps | Estimated Time |
|-------|-------|---------------|
| Phase 0: Test infrastructure | 3 steps | 15 min |
| Phase 1A: Server characterization tests | 4 test files | 2-3 hours |
| Phase 1B: Server extraction | 14 extractions | 3-4 hours |
| Phase 1C: DRY LLM proxy | 1 refactor | 1 hour |
| Phase 2A: Orchestrator characterization tests | 3 test sets | 2-3 hours |
| Phase 2B: Store coupling fix | 1 refactor | 1 hour |
| Phase 2C: Orchestrator extraction | 5 extractions | 2-3 hours |
| Phase 3A: ChatArea characterization tests | 1 test suite | 2-3 hours |
| Phase 3B: ChatArea extraction | 6 extractions | 2-3 hours |
| Phase 4: CampaignHub | 4 extractions + tests | 1-2 hours |
| **Total** | | **~17-23 hours** |
