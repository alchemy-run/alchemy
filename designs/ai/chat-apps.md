# Building Chat Apps — design, architecture, philosophy, UX, packages

Status: **design** (July 2026). Companion to [serving.md](./serving.md)
(the serving tier this UI plugs into). The reference implementation is
`examples/agent-chat-web`, which this design will upgrade.

## 0. The one-sentence architecture

The kernel produces **facts** (the Trace), the serving tier folds facts
into the **AI SDK UI message stream**, and the chat app is a thin,
code-owned composition of **shadcn primitives** that renders message
parts — so everything below the part renderer is ecosystem-standard and
everything above it is ours to own and restyle.

## 1. Philosophy

### 1.1 Open code, not dependencies (shadcn's model)

shadcn/ui distributes components as **source copied into your repo**
via a registry (`npx shadcn add …`), not as an npm package you import
from. AI Elements does the same (components land in
`components/ai-elements/`). We adopt this wholesale:

- The chat UI is **vendored source we own** — restyleable, forkable,
  debuggable, no breaking upstream releases.
- Behavior that is genuinely hard (scroll engineering) comes from the
  one *actual* dependency, `@shadcn/react` — headless primitives with
  the styled skin vendored on top. Behavior is a dependency;
  presentation is ours.
- This mirrors the alchemy stance on terms vs layers: contracts are
  small and stable, implementations are swappable and owned.

### 1.2 Scroll engineering (normative)

shadcn's "What Makes a Great Streaming Chat Experience" is adopted as
**normative UX law** for every alchemy chat surface. Start here: *never
move the reader against their intent.*

1. Move only when the reader asked to move — auto-scroll is never the
   default.
2. Follow only while they're following (live-edge pinning backs off the
   moment they scroll away).
3. Every interaction is intent — selecting text, keyboard use, opening
   a link all stop the interface from moving.
4. Start a new turn near the top of the viewport…
5. …then stream the answer into the available space.
6. Keep part of the previous conversation in context (a peek of the
   prior exchange above the anchor).
7. Let new content arrive offscreen.
8. Show what's happening out of view (streaming/new-message indicators).
9. Make it easy to return to the latest reply (jump-to-latest).
10. Let people jump anywhere (message links, search, unread markers).
11. Reopen where the reader left off — usually the **last user
    message**, not the absolute bottom.
12. Keep the reader's place when layout changes (images load, markdown
    expands, history prepends).
13. Handle interruptions without stealing position (stop, retry,
    regenerate, branch, errors).
14. Stay responsive in long threads.
15. Be accessible without the noise (transcript as `role="log"`,
    focus preserved, announcements paced).

We do not reimplement any of this: `MessageScroller` encodes rules
1–15 (anchored turns via `scrollAnchor` on user messages, follow-output
off the React render path, prepend preservation, jump button, saved
thread restore, `content-visibility` performance, `role="log"` a11y).
**Rule 13 has an alchemy-specific corollary**: an ask card flipping
pending → answered, a background delegation completing, or a budget
halt arriving must never move the reader — they're in-place part
reconciliations, never appends that trigger anchoring.

### 1.3 The transcript renders facts

Our own addition to the philosophy. Everything in the transcript is a
projection of kernel facts (the Trace, designs §2.7): tool cards are
`tool.requested/.completed` rows, ask cards are `ask.requested/
.answered` rows, the assistant text is `model.delta`s or the halt row.
Consequences:

- The UI never invents state. "Approved" renders when the
  `ask.answered` fact arrives — not when the button was clicked
  (optimistic styling is fine; state transitions are not).
- Anything visible is replayable: reconnect/refresh reconstructs the
  same transcript from the Trace. No UI-only state worth losing.
- The same facts can render at two zoom levels: the **chat view**
  (conversational projection) and the **trace view** (the engine room:
  every event, seq-addressed). Both are windows onto one log.

## 2. Architecture (layered, each seam standard)

| Layer | What | Owned by |
| --- | --- | --- |
| Kernel | rings, turns, Trace | alchemy (`src/AI`) |
| Serving tier | `ChatSessions`, `agentApi()` — AI SDK UI message stream over SSE | alchemy (`src/AI/Api`) |
| Transport | `DefaultChatTransport({ api: "/api/chat" })` | AI SDK (`ai`) |
| Chat state | `useChat` → `UIMessage[]` with typed parts | AI SDK (`@ai-sdk/react`) |
| Part renderers | one component per part type | **vendored** (AI Elements + ours) |
| Message layout | `Message`/`Bubble`/`Marker`/`Attachment` | **vendored** (shadcn/ui) |
| Scroll layer | `MessageScroller` over headless `@shadcn/react` | dependency (behavior) + vendored skin |
| Control plane | asks / steer / interrupt / trace fetches | ours (small typed client) |

The load-bearing decision was made in [serving.md](./serving.md):
because the server speaks the AI SDK wire verbatim, layers 3–7 are the
*entire ecosystem's* — any AI SDK-compatible component works unchanged.
The UI needs zero knowledge of kernels, rings, or Effect.

### 2.1 Part-type → component mapping

The chat app is essentially one `switch` over `message.parts`:

| Part type | Component | Source |
| --- | --- | --- |
| `text` | `MessageResponse` (streaming markdown, incremental re-parse) | AI Elements |
| `reasoning` | `Reasoning` (auto-open while streaming, collapse when done) | AI Elements |
| `dynamic-tool` | `Tool` (name, input, state, output/error, collapsible) | AI Elements |
| `data-ask` | **`AskCard`** — approve/deny → `POST /api/asks/:id` | ours |
| `data-run` (future) | **`RunCard`** — a delegated/background run: delegate, status, link into its ring's trace | ours |
| `file` / attachments | `Attachment` | shadcn/ui |
| `source-url` (future) | `Sources` | AI Elements |
| streaming/status markers | `Marker` + `shimmer` | shadcn/ui |

`AskCard` is deliberately custom: the AI SDK's native approval part
models *pre-execution* approval, while an alchemy ask is a **parked
mid-execution tool** (serving.md decision 1). It's a real state machine
(pending → answered, reconciled on a stable part id), composed from
vendored shadcn primitives (`Card`, `Button`, `Marker`) so it looks
native next to the ecosystem components.

### 2.2 The trace view (our differentiator)

Chat is the *conversational* projection. Agent orgs need the **engine
room** too: what tools ran with what params, what was delegated to
which ring, budgets burning down, checks passing, asks parked across
*all* conversations. That's a second, read-only surface over
`GET /v1/stream/:ring?offset=N` (replay-then-tail, seq-cursored):

- a collapsible side panel in the chat app ("show the work"),
- rendered as a flat, seq-ordered event list with type-specific rows
  (reusing the same `Tool`/`Marker` vocabulary),
- later: a run tree across rings (Coordinator → Scouts) — the org
  topology view. This is where alchemy's UI diverges from every
  single-agent chat product, and why the facts-first architecture
  matters: the data is already there.

### 2.3 Sessions and reopening

`useChat` owns in-flight state; the serving tier owns history
(`GET /api/chat/:id` → materialized transcript). Opening a saved
conversation = fetch transcript → `useChat({ messages })` →
`MessageScroller` `initialPosition` targeting the **last user message**
(rule 11). Conversation ids are client-minted (`crypto.randomUUID`),
listed by a `GET /api/chats` index (serving-tier addition, deferred).

## 3. UX composition (the reference layout)

```
┌───────────────────────────────────────────┬──────────────┐
│ header: agent name · status · trace toggle│              │
├───────────────────────────────────────────┤  trace panel │
│ MessageScroller                           │  (collapsed  │
│   user turn (scrollAnchor)                │   by default)│
│   assistant turn                          │   seq-ordered│
│     Reasoning (collapsed after stream)    │   event rows │
│     Tool card(s)                          │              │
│     AskCard (if parked)                   │              │
│     MessageResponse (markdown)            │              │
│   MessageScrollerButton (jump to latest)  │              │
├───────────────────────────────────────────┴──────────────┤
│ PromptInput (textarea, attachments, submit/stop)         │
│ Suggestions (empty state only)                            │
└───────────────────────────────────────────────────────────┘
```

Rules of composition:

- User turns get `scrollAnchor` (rule 4); assistant content streams
  into the space below (rule 5).
- One assistant **message** per run, many parts — steps stitch via
  `start-step`/`finish-step` (already emitted by our fold).
- Empty state = `Empty` + `Suggestion` chips (already in the example).
- While a run streams with no visible output yet (tool executing,
  ask parked): a `Marker` row with `shimmer`, `role="status"`.
- Interrupt is a first-class button (wired to `POST /api/interrupt`),
  rendered in the prompt input as stop-while-streaming — and it must
  not move the scroll (rule 13).

## 4. Package choices (specific)

| Package | Role | Why this one |
| --- | --- | --- |
| `@ai-sdk/react` | `useChat` | already our wire contract |
| `ai` | `DefaultChatTransport`, `UIMessage` types | ditto |
| `@shadcn/react` | headless message-scroller | the only real behavior dependency; benchmarked, a11y-correct |
| shadcn/ui registry (vendored) | `message-scroller`, `message`, `bubble`, `marker`, `attachment`, `empty`, `input-group`, `card`, `button`, `tooltip`, `scroll-fade`, `shimmer` | open-code model; Tailwind-native |
| AI Elements registry (vendored) | `MessageResponse`, `Reasoning`, `Tool`, `Sources`, `PromptInput`, `Suggestion`, `Loader` | maps AI SDK parts 1:1; built on shadcn/ui |
| `streamdown` (via `MessageResponse`) | streaming markdown | incremental parsing — no full re-parse per token (rule 14) |
| Tailwind CSS v4 | styling | required by both registries; CSS-variables theming |
| `lucide-react` | icons | shadcn default |
| Vite + React 19 | app shell | shadcn supports Vite; no Next.js requirement for a local agent UI |

Notes:

- **Registry over npm**: components are added with
  `npx shadcn add <item>` / the Elements registry URL and committed.
  Upgrades are deliberate re-vendoring, never silent.
- AI Elements assumes Next.js in its docs but the components are
  plain React + Tailwind; they vendor cleanly into Vite. Anything that
  doesn't (server-only imports), we fork — we own the code.
- Virtualization (`@tanstack/react-virtual`) is *not* adopted now —
  `MessageScroller` handles thousands of turns without it; the seam
  exists if an org trace view ever needs it.

## 5. What we adopt vs what we build

**Adopt (vendored, restyled at most):** scroll layer, message layout,
markdown streaming, reasoning display, tool cards, prompt input,
suggestions, attachments, empty states.

**Build (ours, composed from vendored primitives):**

1. `AskCard` — the Ask protocol's approval/question surface
   (pending → answered on one part id; deny with reason; later:
   amendments — "approve for session" — the §9.3 autonomy dial).
2. `TracePanel` — the seq-cursored engine-room feed over
   `/v1/stream/:ring`.
3. `RunCard` / run tree — delegation and spawn-and-continue rendering
   (needs a `data-run` part from the fold; kernel already journals
   the facts).
4. Budget meter — tokens/iterations remaining, from `run.admitted` +
   `model.completed` usage rows (header widget; goes red near ceiling).
5. The control-plane client — a ~50-line typed wrapper over asks /
   steer / interrupt / transcript / trace endpoints.

## 6. Kernel/serving gaps this design surfaces

Ordered; each is small and independently shippable:

1. **Reasoning parts.** ✅ Done. `reasoning-delta` stream parts ride the
   live `model.delta` event with `kind: "reasoning"`; the chunk fold
   fences them into `reasoning-start/delta/end` blocks (closed before
   the text block opens). **Reasoning is live-only by design** — never
   journaled, absent from trace replay (consistent with the AI SDK's
   opt-in `sendReasoning`; keeps the Trace lean). The example enables
   Anthropic extended thinking (`config.thinking`) and renders the
   `Reasoning` component; verified over the wire with a tool round.
2. **`data-run` part.** Delegation tools already summarize; emit a
   custom part when a delegation/spawn happens so the UI can render a
   `RunCard` instead of a generic tool card.
3. **`GET /api/chats`** — ✅ Done. `ChatSessions.conversations` indexes
   the transcript map (titled by the first user message); the sidebar
   lists it, `new chat` mints a client UUID, and reopening a saved
   conversation loads the transcript into `useChat` with
   `defaultScrollPosition="last-anchor"` — rule 11's "reopen at the
   last user message" comes straight from the scroller.
4. **Reconnect route** (`GET /api/chat/:id/stream`) — resume a live
   window from the trace cursor so a refresh mid-run reattaches
   (the fold already handles replay; this is just a route).

## 7. Rollout

1. Re-scaffold `examples/agent-chat-web` with Tailwind v4 + shadcn init
   + vendored components; keep the croupier backend unchanged.
   (The protocol seam means zero server changes.)
2. Ship `AskCard` + `Tool` + `MessageResponse` + `MessageScroller`
   composition (rules 1–9, 12–15).
3. Kernel gap #1 (reasoning), then `Reasoning` in the UI.
4. `TracePanel` (gap none — endpoint exists).
5. Sessions sidebar (gap #3), reopen-at-last-user-message (rule 11).
6. `data-run` + `RunCard` (gap #2) — the first org-shaped UI.
