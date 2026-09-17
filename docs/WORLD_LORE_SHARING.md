# World lore PNG sharing

Narrative Engine world cards carry a world's lore, not a playable character or saved campaign.

## Use

- In **World Lore Builder**, select a draft and choose **Export world PNG**. Set a title, optional author/description, and optional cover. Without a cover, the app draws a title image locally. PNG is the primary sharing format; JSON is available too.
- Use **Import world PNG / JSON**, or drop a file on that panel. Review its entries and choose **Import as new world draft**. Existing drafts remain intact.
- In an active campaign's **Lore** screen, export its lore or preview a file and **Add lore to this campaign**. This appends fresh entry IDs and leaves existing lore in place.
- In **New/Edit Campaign**, the World Lore picker accepts PNG, JSON, Markdown and text. Re-uploading replaces campaign lore, as the picker states. World cards do not create live NPCs, assign a player character, install prompts, or import chat progress.
- Share the original PNG as a file. Screenshots and image recompression can remove its embedded lore.

## One-way SillyTavern input

Accepted: standalone World Info JSON (`entries` array or dictionary), and lorebooks embedded in V2/V3 JSON or PNG (`chara` / `ccv3`; V3 takes precedence). Character-only cards are rejected by this world importer. The separate existing character importer is unchanged.

Lore text, titles, primary keywords, basic secondary-key AND gating, enabled/disabled state, constant activation and scan depth are mapped to native entries. Character identity, greetings, dialogue examples and system prompts are excluded. SillyTavern positioning, recursion, probabilities, scripts and other advanced rules are not emulated; the import preview explains this. Entries with unresolved macros or unsupported secondary logic start disabled for review. Imports do not make an AI call.

Export is intentionally **not** SillyTavern compatible. Neither PNG nor JSON exports contain an ST character envelope. This is format separation, not encryption or a restriction on someone writing their own converter.

## Native format v1

- PNG text chunk keyword: `narrative-world`.
- Payload: Base64 of UTF-8 JSON, with a valid PNG chunk CRC.
- JSON envelope: `format: "narrative-engine-world"`, `version: 1`, `world`.
- `world`: name, author, description, native lore chunks, and optional structured builder draft.
- Builder drafts retain categorized sections, character-creation question templates and imported entries. Raw pasted scratch source, campaign messages, live ledgers and settings are not exported.
- Entry token counts are recomputed on import. Disabled entries and retrieval settings survive native PNG round trips. Markdown remains a text export and does not preserve all imported retrieval metadata.
- Cover pixels are rendered independently of data. Old textual/EXIF metadata is removed before embedding the new world payload. No `chara` or `ccv3` chunk is written.
- Limits: 20 MiB total PNG/input file, 4 MiB embedded JSON, 10,000 entries. Unknown native versions and malformed payloads fail before import.

## Persona 3 example

`Example_Setup/World_compendium/Franchisee/Persona 3/Persona 3.world.png` is an actual browser-exported, import-tested world card. The adjacent JSON is its editable source fixture. It is a small unofficial setting sample, not a full Persona 3 compendium. It includes Japanese text, an always-on overview, keyword and secondary-key entries, and a disabled test entry. The cover is a locally drawn title image, not franchise artwork.

The brief setting summaries use the official [Persona 3 Portable site](https://persona.atlus.com/p3p/sp/index.html?lang=fr) and [Persona 3 Reload site](https://asia.sega.com/p3r/en/) as references. The sample contains no game dialogue or scripted plot sequence.

## Validation

- `npx vitest run src/services/lore/__tests__/worldCard.test.ts src/components/__tests__/WorldCardPanel.test.tsx src/services/__tests__/campaignWorldCard.test.ts`
- `npx playwright test e2e/worldLoreSharing.spec.ts`
- `npm run build`

The browser test uses an isolated builder fixture and intercepts API requests. It exports a real PNG, verifies the payload, reimports it, and checks that both drafts and disabled state survive without touching saved campaigns.
