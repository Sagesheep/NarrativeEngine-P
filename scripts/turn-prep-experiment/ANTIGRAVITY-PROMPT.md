# Task: finish re-sealing chapters CH11–CH23 of an experiment campaign copy

This repo is a tabletop-RPG narrative app. We are rebuilding the long-term memory ("chapter seals") of an **experiment copy** of a campaign, `exp-c1-rebuilt`. For each chapter, the app's own code generates one prompt. **You act as the model that answers it.** CH01–CH10 are already done. You do CH11 → CH23, strictly in order.

Working directory: `D:\Games\AI DM Project\Automated_system\mainApp`

## The only commands you run

```
node scripts/turn-prep-experiment/seal-step.mjs status
node scripts/turn-prep-experiment/seal-step.mjs prompt <CH>
node scripts/turn-prep-experiment/seal-step.mjs apply <CH>
```

- `status`: lists every chapter as applied or not applied, and prints `NEXT: <CH>`.
- `prompt <CH>`: writes `scripts/turn-prep-experiment/work/exp-c1-rebuilt/<CH>.prompt.txt`.
- `apply <CH>`: reads `<CH>.output.json` from the same folder, parses it with the app's own parser, and writes it into the campaign.

## Loop

Chapter order: **CH11, CH12, CH13A, CH14, CH15, CH16, CH17, CH18, CH19, CH20, CH21, CH22, CH23**. There is no CH13; it's CH13A.

For each chapter:

1. Run `prompt <CH>`. **Always regenerate the prompt, even if a prompt file already exists**, because each prompt lists facts from the chapters applied before it. (The existing `CH22.prompt.txt` is stale.)
2. Read the **entire** prompt file, from the first line to the last.
3. Answer it as the "TTRPG campaign archivist" it addresses. Follow its output format, category definitions and extraction rules exactly. The key rules:
   - Each fact is one short sentence, **at most 15 words**.
   - `sceneRef` must be one of the scene IDs the prompt lists.
   - `npcIds` and `knownBy` use NPC ledger IDs **exactly** as listed. `knownBy` lists only NPCs **physically present** when the fact happened. Omit it for `rules_lore` and `locations`.
   - **To update something already tracked** (who holds an item, where someone is, their status, a debt): reuse the **exact same `stateKey`** as the fact listed under CURRENT STATE FACTS, and set `supersedesFactId` to that fact's ID. Never supersede an ID that isn't listed there.
   - At most 3 scene events per scene.
   - Include `witness_corrections` only for scenes where the listed witnesses are wrong. Common errors: people who were only *mentioned* but listed as present, or people who were present but missing from the list.
4. Also apply these two rules, which earlier chapters used:
   - **The NPC ledger is authoritative.** If a name in the scenes matches a ledger name or one of its aliases, it **is** that character; use that ID. The ledger was written late in the campaign, so its names, titles and descriptions show each character's **latest** status. A mismatch with how they appear earlier does not mean it's a different person.
   - **Grey Holmes (`mo258d9dxn6e3`) is the player character.** Use his ID in `npcIds` and in `stateKey`s about him, but **never** in `knownBy`.
5. Write your answer to `scripts/turn-prep-experiment/work/exp-c1-rebuilt/<CH>.output.json`. It must be **one valid JSON object** with exactly the top-level keys the prompt asks for. No markdown code fences, no text before or after.
6. Run `apply <CH>`. Success means it prints a `[seal-harness] ... applied:` line containing `"parseError":false` and ends with `OK: apply <CH>`.
   - If it prints `FAILED` because your JSON is broken, fix `<CH>.output.json` and run `apply <CH>` again.
   - If it says the chapter is **already applied**, don't force it; just move on to the next chapter.
7. Move to the next chapter. **Never generate chapter N+1's prompt before chapter N has been applied.**

## Rules

- Only create or overwrite `CHxx.output.json` files in `scripts/turn-prep-experiment/work/exp-c1-rebuilt/`.
- Do **not** edit anything else: not the harness scripts, not files in `data/`, not source code.
- Never touch the original campaign files `data/campaigns/mnwf9obfkz6rk.*`.
- Speed matters more than perfection, but every output must parse and must follow the rules above.
- If your context is getting full, stop right after a successful `apply`. A new session can resume by running `status`, which prints `NEXT`.

## When you're done

When `status` prints `ALL SEALED CHAPTERS APPLIED`, reply with a table: chapter · facts · scoped · superseded · witnessCorrections · parseError. Copy the values from each chapter's `applied:` line.
