# 11 — Screen Host API

This is the narrow message-passing contract for a declared mod screen. A screen runs in an iframe with `sandbox="allow-scripts"`; `allow-same-origin` is forbidden. The server carries screen source as text and never evaluates it.

## Authentication

Every mount gets a fresh random nonce. The host sends one init message after the iframe loads:

```ts
{ __screenInit: true, nonce, theme }
```

Every screen request contains `__screenRequest`, a numeric `id`, and that nonce. Every response contains `__screenResponse`, the same `id`, the nonce, `ok`, and either `result` or `error`.

The host accepts an inbound message only when both conditions hold:

1. `event.source === iframe.contentWindow`.
2. `event.data.nonce === the nonce minted for this mount`.

Origin is deliberately not used for authentication. An opaque sandboxed frame reports `event.origin === "null"`, so two different screen frames have the same origin value. Origin can identify neither the declaring frame nor a sibling forgery.

## Capabilities

Exactly four capabilities exist:

| Capability | Request fields | Result | Rule |
|---|---|---|---|
| `table.read` | `table` | the table value | The name is re-validated against this mod's declared `tables[]` at the message boundary. |
| `table.write` | `table`, `value` | `{ written: true }` | The table name and `recordShape` are re-validated at the boundary. Writes apply immediately; there is no journal because a screen has no bounded run to roll back. |
| `theme` | none | plain token values | Tokens are data only: colours, font sizes, radii, and a version. No stylesheet or class names cross the boundary. |
| `resize` | `height` | `{ height }` | The proposed height is rounded and clamped to `MIN_SCREEN_HEIGHT_PX` through `MAX_SCREEN_HEIGHT_PX`. Width remains the host container's width. |

Table callbacks use only the declaring mod's namespaced key (`mod.<modId>.<table>`). No general Zustand accessor, host store field, function, or live object is exposed to the screen. Values crossing the channel must be plain structured-clone-safe data.

## Denial and fault behavior

The API is deny-by-default. An unknown capability, a table outside the declaring mod's `tables[]`, a nonce failure, or an invalid boundary request returns an error and faults the screen with `denied` or `malformed`. Unknown capabilities are not silently ignored.

Each mount accepts at most `MAX_INBOUND_MESSAGES` messages. Exceeding the cap faults the screen with `flood` and tears down the frame. Screen fault kinds remain separate from compute sandbox fault kinds.

## Why four capabilities are enough

Four capabilities are sufficient for the fixed 5.3 proof target: a skill-tree-class editor can keep its nodes and prerequisites in its own declared table, persist edits through `table.write`, render with token data from `theme`, and request the vertical space it needs through `resize`. Its canvas, node layout, prerequisite lines, drag targets, and interaction model remain inside the screen. No fifth capability is needed for that editor, so none is added speculatively.

## Network and styling boundaries

The frame CSP remains:

```text
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:
```

The screen receives no app stylesheet and has no network capability. The browser harness proves fetch, XHR `send()`, and WebSocket failure, as well as the opaque-origin, storage, forgery, resize, denial, and flood behaviors.
