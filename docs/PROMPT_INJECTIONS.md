# Prompt injections

Open **Injection Modifier** in the chat sidebar, beside Gallery. Toggle cards directly in the sidebar, or choose **Edit injections** to open the side editor while keeping chat visible. Changes save automatically for the current campaign.

- **Sends to:** **Story AI** (the default, and what every older card uses), **Director Brief** or **Context Recommender**. See [Helper-prompt cards](#helper-prompt-cards) below; the rest of this list applies to Story AI cards.
- **Message at depth:** choose System, User or Assistant. Depth 0 follows the latest conversational message; depth 1 precedes it. Deeper positions count back through retained player/narrator messages. Leading context and tool exchanges are excluded from the count.
- **Order:** use the up/down buttons. Card order breaks ties at one depth.
- **Triggers:** replies/retries, swipes and scene continues can be selected independently. Empty, disabled and unselected cards are not sent.
- **Assistant prefill:** places text at the end as an assistant prefix.
- **Reasoning prefill:** places an unfinished `<think>` prefix followed by your text. This is prompt text, not access to private model reasoning. Prefill behavior depends on the chosen model/backend.
- **Preview:** an illustrative conversation using the same placement logic as the outgoing request, before provider conversion. Actual history is context-fitted.
- **Claude/Gemini:** native APIs move system messages into a separate system field. In-chat System injections are therefore sent as labeled User messages to preserve their position.

Cards are stored in campaign context and travel with campaign saves/backups/exports. Switching AI presets does not change them; switching campaigns loads a separate list. Deleting a card can be undone within the editor; undo is cleared when switching campaigns. Legacy preset injections are never applied automatically. If any exist, **Copy from old preset injections** can copy them into the current campaign without changing the original.

Story AI cards are applied at the streaming request boundary for story generation, never written into chat history or cached swipe payloads. Context assembly reserves space for enabled Story AI cards. If a changed injection overflows an older cached request, shorten the injection or start a new turn to refit history. Tool call/result pairs remain intact. Background helper calls receive only the cards aimed at them.

## Helper-prompt cards

A card sent to **Director Brief** or **Context Recommender** steers that helper instead of the story AI:

- **Director Brief** — the Continuity Director audits the last GM turn and writes a short Writer Brief (Pro and Max tiers). Use a card to tell it what to watch, e.g. "Treat faction loyalty as hard continuity."
- **Context Recommender** — picks which NPCs, lore, items and character details are loaded for the turn. Use a card to tell it what to prefer, e.g. "Consider faction lore whenever a noble house is named."

A helper prompt is one block of text, not a conversation, so role, depth, prefill and triggers do not apply: every enabled, non-empty card is sent each time that helper runs, in card order. The text goes after the helper's evidence and before its answer format, labelled with the card's name. The format always comes last, so a card can change what the helper pays attention to but not the shape of its reply. Editing or toggling a Director card makes the next turn draft a fresh brief instead of reusing a cached one.
