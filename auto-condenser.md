# Auto-Condenser: Context Pruning System

## Goal

Automatically compress old chat history behind the scenes to reduce token burn, while preserving Canon State / Header Index as player-controlled "hard save" anchors.

## Architecture

```
┌──────────────────────────────────────────────────┐
│ SYSTEM PROMPT (protected — never compressed)     │
│  • Lore + Rules (always)                         │
│  • Canon State / Header Index (player's anchor)  │
│  • Active template fields                        │
├──────────────────────────────────────────────────┤
│ CONDENSED BLOCK (auto-generated summary)         │
│  • Bullet-point summary of old turns             │
│  • Exact item/NPC/location names preserved       │
├──────────────────────────────────────────────────┤
│ RECENT HISTORY (verbatim, last N turns)          │
├──────────────────────────────────────────────────┤
│ USER MESSAGE                                     │
└──────────────────────────────────────────────────┘
```

### Two Independent Systems

| System | Trigger | Actor | Purpose |
|--------|---------|-------|---------|
| Auto-Condenser | Turn count threshold (e.g. 10) or token budget (e.g. 60%) | AI, background | Reduce token usage mid-session |
| Hard Save | Player clicks "Save State" | Player, manual | Checkpoint for session resume |

They do NOT interfere with each other.

## Success Criteria

- [ ] Old chat turns are auto-summarized when history exceeds 40% of context limit (dynamic threshold)
- [ ] Last 5 messages remain verbatim always
- [ ] Canon State / Header Index fields are used as glossary anchor (no synonym drift)
- [ ] Token gauge reflects condensed payload size
- [ ] Player sees no interruption during condensation
- [ ] Condense button available for manual trigger
- [ ] Settings toggle for auto-condense on/off

## Tech Stack

No new dependencies. Uses existing LLM endpoint for summarization calls.

## Files Affected

| File | Change |
|------|--------|
| `src/types/index.ts` | Add condenser settings to `AppSettings` |
| `src/services/condenser.ts` | **[NEW]** Core condensation logic — prompt builder, LLM call, result parser |
| `src/services/chatEngine.ts` | Modify `buildPayload` to inject condensed block between system prompt and recent history |
| `src/store/useAppStore.ts` | Add condenser state: `condensedSummary`, `condensedUpToIndex`, `autoCondenseEnabled`, `condenseThreshold` |
| `src/components/ChatArea.tsx` | Add "Condense" button to macro bar, trigger auto-condense on send |
| `src/components/TokenGauge.tsx` | Account for condensed block in token estimation |
| `src/components/SettingsModal.tsx` | Add auto-condense toggle + threshold slider |

## Tasks

- [ ] **T1: Types** — Add condenser fields to `types/index.ts`
  → Verify: `npx tsc --noEmit` passes

- [ ] **T2: Store** — Add condenser state fields to `useAppStore.ts`
  → Verify: `npx tsc --noEmit` passes, defaults are sane

- [ ] **T3: Condenser service** — Create `src/services/condenser.ts` with:
  - `buildCondenserPrompt(oldMessages, canonState, headerIndex)` — constructs the summarization prompt with glossary anchor
  - `condenseHistory(settings, messages, context)` — calls LLM, returns condensed summary string
  - Dynamic threshold check: `shouldCondense(messages, contextLimit)` — fires when history tokens > 40% of context limit using `chars/4` heuristic
  → Verify: `npx tsc --noEmit` passes

- [ ] **T4: Payload integration** — Modify `buildPayload` in `chatEngine.ts` to:
  - Accept condensed summary as parameter
  - Insert condensed block between system prompt and recent (verbatim) history
  - Adjust token budget calculation to account for condensed block
  → Verify: `npx tsc --noEmit` passes

- [ ] **T5: Auto-trigger** — In `ChatArea.tsx`, after each `handleSend`:
  - Check `shouldCondense()` based on store state
  - If true, fire `condenseHistory()` in background (non-blocking)
  - Store result in `condensedSummary`
  - Add "Condense Now" button to macro bar
  → Verify: `npm run dev`, send 10+ messages, observe condensation fires

- [ ] **T6: Token gauge** — Update `TokenGauge.tsx` to include condensed block in system token count
  → Verify: gauge updates after condensation

- [ ] **T7: Settings UI** — Add to `SettingsModal.tsx`:
  - Auto-condense toggle (on/off)
  - Threshold slider (5–20 turns, default 10)
  → Verify: toggle persists in localStorage

## Condenser Prompt Design

The prompt sent to the LLM for summarization:

```
You are a TTRPG session scribe. Summarize the following chat turns into
concise bullet points. 

RULES:
1. Preserve ALL dice rolls, damage numbers, HP/MP changes exactly
2. Preserve ALL item names, NPC names, location names EXACTLY as written
3. Use the Canonical Terms below — DO NOT paraphrase, rename, or synonym-swap
4. Keep quest/objective updates
5. Drop flavour text and generic narration
6. Output format: bullet points grouped by scene/event

CANONICAL TERMS (use these exact strings):
{canonState}
{headerIndex}

TURNS TO SUMMARIZE:
{oldMessages}
```

## Verification

Since there are no existing tests in the project, verification is manual:

1. `npx tsc --noEmit` — type checks pass after each task
2. `npm run build` — production build succeeds
3. **Manual test flow:**
   - Open http://localhost:5173
   - Paste lore + rules in Context Drawer
   - Send 12+ messages in chat (can be gibberish with an LLM running)
   - After turn 10, observe auto-condenser fires (check console / token gauge drops)
   - Verify "Condense Now" button appears and works on click
   - Verify Canon State / Header Index fields are unaffected
   - Toggle auto-condense off in Settings, verify it stops
   - Refresh page, verify condensed state persists

## Done When

- [ ] Old history is automatically compressed at threshold
- [ ] Recent turns stay verbatim
- [ ] Token gauge reflects actual payload
- [ ] Player's Hard Save fields are independent and unaffected
- [ ] No synonym drift in condensed output (canonical terms enforced)
