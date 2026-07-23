# Narrative Engine

## Version 1.0.3

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform: Desktop](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-blue)]()
[![Self-Hosted](https://img.shields.io/badge/Self--Hosted-100%25%20Local-brightgreen)]()
[![Discord](https://img.shields.io/badge/Discord-Join%20Server-7289da?logo=discord&logoColor=white)](https://discord.gg/gf3Ntw6pUY)

**Your AI Dungeon Master.** A self-hosted TTRPG engine that runs extended, multi-session campaigns with persistent memory, living NPCs, and automated world management — powered by any OpenAI-compatible LLM or local Ollama model.

No cloud. No subscription. Your campaigns stay on your machine.

> 📱 **Android client available:** [NarrativeEngine-M](https://github.com/Sagesheep/NarrativeEngine-M/releases/tag/v1.6.20)
> 
> 💬 **Join our community:** [Discord Server](https://discord.gg/Qp2y7s3X6T)

---

## Getting Started

1. **Clone the repo**
   ```bash
   git clone https://github.com/Sagesheep/NarrativeEngine-P.git
   cd NarrativeEngine-P
   ```

2. **Install & run**

   **Windows** — double-click `Start_Narrative_Engine.bat`

   **Linux / macOS** — run `start.sh`

   **Or manually:**
   ```bash
   npm install
   npm run dev
   ```

3. **Open your browser** at `http://localhost:5173`

4. **Configure your LLM** — open Settings and add your API key + endpoint. Supports OpenAI, Ollama, DeepSeek, and any OpenAI-compatible API.

That's it. Create a campaign, write your world lore, and start playing.

---

## Updating to the Latest Version

When a new version comes out, you can update your local copy without losing your campaigns or settings.

**Windows** — double-click `Update_Narrative_Engine.bat`

It will:
- Download the newest app files from GitHub (`git pull`)
- Run `npm install` to keep dependencies in sync
- Leave your saved campaigns, lore, and API keys untouched (the `data/` folder is not tracked by Git)

**Manual:**
```bash
git pull
npm install
```

**Notes**
- Close the app completely before updating (close any terminal windows titled "Narrative Engine").
- If you downloaded the app as a ZIP instead of cloning it, the updater won't work — download the newest ZIP from GitHub instead.
- If you edited any app files directly, the update may ask before overwriting them. Edits inside `data/` are never touched.

After updating, start the app the same way as before (`Start_Narrative_Engine.bat` / `start.sh` / `npm run dev`).

---

## Troubleshooting

**"Node.js is not installed"** when running the start script
Install the LTS version from https://nodejs.org/ and run the script again.

**"needs Node 20 or newer"** when running the start script
Your Node.js is too old. Upgrade to the LTS version at https://nodejs.org/.

**"NODE_MODULE_VERSION mismatch"** error after upgrading Node
Your database module was built for the old Node version. Run the repair script and choose **option 1 (Quick fix)**:
- **Windows** — double-click `Repair_Narrative_Engine.bat`
- **Linux / macOS** — run `./Repair_Narrative_Engine.sh`

If the repair fails on Windows with a C++ build tools error, install the [Visual C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (select "Desktop development with C++") and run the repair again. Alternatively, run the repair script and choose **option 2 (Full clean reinstall)** — it may succeed without needing the C++ build tools.

**"Cannot find native binding" / "rolldown" / "is not a valid Win32 application"** when starting the app
Your dependency install was incomplete (a known [npm bug](https://github.com/npm/cli/issues/4828) with optional dependencies). Run the repair script and choose **option 2 (Full clean reinstall)**:
- **Windows** — double-click `Repair_Narrative_Engine.bat`
- **Linux / macOS** — run `./Repair_Narrative_Engine.sh`

---

## Setting Up Your First Campaign

The `Example_Setup/` folder contains ready-to-play campaigns across multiple genres — including a gritty survival fantasy (*Spirit Card World*), a *Naruto*-inspired setting, and more. Each comes with a world bible, a GM ruleset, and an opening prompt.

### Quick start with an example

1. Create a new campaign
2. Open **World Info (Lore)** and paste the contents of one of the lore files (e.g. `Spirit_Card_World_Lore.md`)
3. Open **Campaign Settings** and paste the latest ruleset (`AI_GM_OS_v3_4_App_Optimized.md`) into the **System Prompt** field
4. Start a new chat and paste the genre's start prompt as your first message
5. The GM will walk you through character creation and then drop you into the world

### Writing your own setup

- **Lore** — write your world in Markdown with `##` / `###` headers. Each section becomes a lore chunk the GM can recall. Use `[CHUNK: TYPE -- NAME]` prefixes to classify entries (`world_overview`, `faction`, `location`, `character`, `power_system`, `economy`, `event`, `rules`, `culture`, `misc`)
- **System Prompt** — define how the GM behaves: tone, output format, NPC behaviour rules, dice resolution, event protocols. The engine handles memory and recall — you define the style
- **First Message** — set the scene, ask for character creation, or simply say "begin"

---

## Memory That Never Forgets

Most AI TTRPG tools suffer from **context drift**. After a handful of sessions the LLM runs out of token space, and suddenly it has no idea who Bob is, what happened in Chapter 1, or why the kingdom is at war. Players notice. Immersion breaks.

Narrative Engine was built from the ground up to solve this. Every piece of your campaign history is preserved and retrievable, no matter how many sessions you play.

### Lossless Scene Archive

Every turn — every dice roll, every line of dialogue, every narrative beat — is archived verbatim. Nothing is summarised away. Nothing is discarded.

### Two-Phase Deep Archive Search

When the GM needs to recall something from a sealed chapter, it runs a two-stage retrieval pipeline:

1. **Chapter scan** — the engine evaluates LLM-generated chapter overviews to identify which sealed chapters are relevant
2. **Scene retrieval** — within those chapters, specific scenes are retrieved using local vector embeddings (`@huggingface/transformers` running ONNX models locally, stored in `sqlite-vec` via `better-sqlite3`), ranked by importance, and injected verbatim into context

This means the GM can accurately recall that Bob betrayed the party in Chapter 3 and reference the exact dialogue — even if that was 50 chapters and 200 sessions ago.

### Auto-Condensation

When approaching the token limit, older turns are compressed automatically using one of three strategies:

| Strategy | Compression | Best for |
|---|---|---|
| **Tight** | ~50% | Long-running campaigns, smaller context windows |
| **Smart** | ~75% | Balanced play (default) |
| **Deep** | Maximum detail | Short campaigns, large context windows |

The most recent 8 messages are always kept verbatim. Dice rolls, HP/MP values, and all proper names are preserved exactly. Dramatic moments are tagged and survive re-compression.

### Pinned Memories

Select any passage from the chat and pin it. Pinned excerpts are injected into every GM call until you unpin them — useful for keeping critical plot points, NPC promises, or player-declared intentions in active context.

### World State Tracking (Divergence Register)

A structured fact-sheet the GM maintains throughout your campaign:

- Automatically extracts world-state facts after each turn: who is where, who holds what, alliances, deaths, promises, debts
- Organised into categories: locations, NPC events, promises & debts, world state, party facts, lore & rules
- Pin high-priority facts so they are always in context regardless of token budget
- AI-assisted structuring for manual entries — paste raw notes and let the engine categorise them
- Semantic deduplication and fact clustering prevent redundant entries from bloating context

---

## NPC Agency

NPCs are not static text snippets. They are simulated characters with their own psychology, goals, and relationships — all managed automatically in the background.

### Auto-Detection & Profiling

NPCs are detected as they appear in the story. The AI generates full profiles: personality, voice, goals, faction, visual description. No manual data entry required.

### Personality Hexagon

Each NPC is defined by six psychological axes, each ranging from −3 to +3:

| Axis | Low end | High end |
|---|---|---|
| Drive | Passive | Ambitious |
| Diligence | Careless | Meticulous |
| Boldness | Cautious | Reckless |
| Warmth | Cold | Affectionate |
| Empathy | Detached | Compassionate |
| Composure | Volatile | Stoic |

These values shape how the NPC speaks, reacts, and makes decisions. They drift naturally as the NPC experiences events — a betrayal might erode warmth, while a victory could boost boldness.

### Background Goal Engine

Every NPC maintains three tiers of wants:

- **Short-term** — immediate scene needs (drawn from personality pools, no LLM cost)
- **Medium-term** — session-level goal templates that advance via background dice rolls
- **Long-term** — a single defining ambition, LLM-generated at creation

Each turn, a heartbeat roll determines whether an NPC's goal advances. Successes and failures accumulate. When NPC goals collide, the engine detects the conflict, resolves the "tangle" with dice, and surfaces the results as rumours or direct events in the GM's next response.

### Relationships & Pressure

- **NPC-to-NPC relations** — directed relationship edges (−3 to +3) that evolve based on goal outcomes and collisions
- **PC Relation Meter** — a dedicated tracker for how each NPC feels about the player
- **Pressure system** — `ignored` and `engaged` counters track how the player treats each NPC, with natural decay. Cross a threshold and the NPC's behaviour shifts
- **Behavioural triggers** — keyword-mapped pressure spikes (mention a sensitive topic and the NPC reacts)
- **Boundaries** — hard limits (NPC refuses outright) and soft limits (NPC complies but pressure rises)

### Tiering & Progression

- NPCs are classified as **Recurring**, **One-shot**, or **Walk-on**
- A skill rung ladder (0–4) tracks NPC competence, with promotion possible as goals succeed
- Inactive NPCs are automatically archived to reduce context clutter and restored when they reappear

### Portrait Generation

Generate NPC portraits on the fly in 5 art styles: Realistic, Anime Realistic, Anime, Western RPG, Chibi. Works with any OpenAI-compatible image API. Images are stored locally.

---

## World Simulation

### World Arc Engine

Large-scale storylines — political coups, economic crises, supernatural plagues — run as background **World Arcs**. Each arc is a 5-to-12 rung ladder that advances via dice, independently of the player's actions:

- **Stance tracking** — the engine detects whether the player is `opposing`, `aiding`, `ignoring`, `fleeing from`, or `unaware of` each arc, and adjusts difficulty accordingly
- **Avoidance has consequences** — if the player ignores or flees from a direct threat, the world moves without them. The engine writes the consequence as a permanent fact in the Divergence Register
- **Surface tiers** — arc events reach the player as ambient hints, rumours, or direct confrontations depending on the current rung

### Narrative Event Engines

Three probability engines create emergent storytelling:

- **Surprise Engine** — ambient flavour events. Default DC 95, drops by 3 per turn
- **Encounter Engine** — mid-stakes hooks and challenges. Default DC 198, drops by 2 per turn
- **World Event Engine** — seismic world shifts. Default DC 498, drops by 2 per turn. Generates a four-part event: who, what, why, where

The longer nothing happens, the more likely something will. All thresholds, decay rates, and event tables are fully configurable.

### Timeskip Simulation

Type *"three weeks later"* and the engine handles the gap. It detects the narrative jump, runs background ticks to advance NPC goals, resolves faction conflicts, and updates the world state — so the world has believably moved forward when the player re-engages.

### Knowledge Boundaries

The engine programmatically prevents NPC metagaming:

- **Witness tracking** — every scene records which NPCs were physically present vs. merely mentioned. When recalling past events, witness-matching scenes are ranked higher
- **Faction scoping** — facts in the Divergence Register carry `knownBy` permissions (`player`, `npc:<id>`, `faction:<name>`). An NPC will never reference a secret they shouldn't know about

---

## Dice & Combat Fairness

The **Dice Fairness** system pre-rolls d20 pools each turn and injects structured outcomes for 7 skill categories (Combat, Perception, Stealth, Social, Movement, Knowledge, Mundane) across Disadvantage / Normal / Advantage tiers — ensuring the GM uses real rolls rather than fabricating outcomes.

The GM can also call the `roll_dice` tool mid-response for specific checks, receiving a tier result (Catastrophe → Failure → Success → Triumph → Critical) with configurable breakpoints.

---

## Lore Check

A consistency QA tool you can run on any message:

- Select text from any chat message to flag it for review
- Choose from check categories: wrong fact, contradicts lore, wrong NPC/place, tone mismatch, out of character
- The engine cross-references your lore chunks, chapter archive, and sealed chapters
- Returns a verdict (consistent / unsupported / contradicts), specific issues with citations, and a suggested rewrite
- Accept the rewrite with one click to replace the message in place

---

## LLM Tool Calls

The GM can use tools mid-conversation:

- **Query Campaign Lore** — the GM searches your world bible on the fly when it needs a detail
- **Update Scene Notebook** — a volatile working memory for tracking active spells, timers, NPC positions, environmental conditions, and combat state
- **Roll Dice** — request a specific skill check with tier-mapped results
- **Propose Inventory Change** — suggest adding, removing, or equipping items (player must confirm)
- **Initiate Combat** — signal that combat is beginning and list hostile combatants

Works with OpenAI function calling and DeepSeek models (with DSML fallback parsing).

---

## World Building Tools

### Overworld Map

A procedurally generated world map tied to your campaign:

- Terrain generation using Perlin noise with Voronoi biome clustering (plains, hills, mountains, coast, swamp, forest, deep ocean)
- Multiple world shapes: single continent, two continents, archipelago, coastal kingdom
- Named landmarks snap to cardinal anchor positions
- Player position tracked on the overworld grid
- Custom map pins for locations, events, or points of interest

### World Lore Builder

A structured pre-game world editor:

- Dedicated fields for world background, languages, power systems, technology level, timeline, tone, and house rules
- Expandable lists for geography, factions, cultures, threats, and pre-seeded NPCs
- Export to Markdown with one click for backup or sharing
- Import Markdown with a smart review modal that merges changes without overwriting your work
- Multiple draft worlds — switch between them or delete old ones

### Rules Manager

Your system prompt is automatically chunked and indexed. Each rule chunk gets AI-generated trigger keywords so the engine retrieves only the relevant rules for each turn, keeping token usage efficient.

---

## Backups & Rollback

- **Automatic backups** before any risky operation
- **Manual labelled backups** at any time
- **Batch backup deletion** for cleanup
- **Scene-level rollback** — undo any scene and the entire world state (timeline, chapters, NPCs, Divergence Register) cascades back to that point
- Pre-rollback safety backup so you can never lose data

---

## Security & Privacy

- **Encrypted API key vault** — AES-256-GCM encryption, password-optional
- **Machine-key mode** — no password needed, keys auto-unlock on your device
- **Password mode** — PBKDF2 with 100K iterations for full lock-down
- **Client-side encryption** — API keys are encrypted in the browser before they touch the server
- **100% local vector search** — all semantic memory, lore queries, and embedding operations run locally via `@huggingface/transformers` (ONNX models) and `sqlite-vec`. No campaign text is sent to third-party vector providers
- All campaign data stored as local files — no database server, no cloud, no vendor lock-in
- Export and import your vault for backups

---

## Supported LLM Providers

Any OpenAI-compatible API works. Configure up to 5 endpoints per preset:

| Role | Purpose |
|---|---|
| **Story AI** | Main GM narration — required |
| **Summarizer AI** | Condensing old history (can use a cheaper/faster model) |
| **Utility AI** | Lore checks, divergence structuring, archive reranking, rule indexing |
| **Image AI** | Portrait and scene illustration generation |
| **Auxiliary AI** | Witness capture, NPC intro engine, scene analysis fallback |

Each endpoint has its own model, API key, base URL, and sampling config (temperature, top-p, max tokens). Thinking/reasoning effort is supported where the provider offers it.

Works with Ollama for fully local play — no internet required after setup.

---

## Quick Reference

| Action | Command |
|---|---|
| Install & run (Windows) | Double-click `Start_Narrative_Engine.bat` |
| Install & run (Linux) | Run `start.sh` |
| Update to latest (Windows) | Double-click `Update_Narrative_Engine.bat` |
| Update to latest (manual) | `git pull` then `npm install` |
| Install manually | `npm install` |
| Start the app | `npm run dev` |
| Run tests | `npm run test` |
| Lint | `npm run lint` |

---

## License

This project is licensed under the [MIT License](LICENSE) — Copyright (c) 2026 Sagesheep.
