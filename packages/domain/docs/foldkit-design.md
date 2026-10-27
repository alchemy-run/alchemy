# Design: a Foldkit adapter for Domain

Status: proposal, implemented in this PR.

## The problem

`@alchemy.run/domain` and Foldkit have the same shape. Both are pure, typed state machines on Effect and Schema:

| Domain (server) | Foldkit (client) |
| --- | --- |
| Command | Message that asks for a change |
| `decide(state, command)` gives events or a Rejection | `update(model, message)` gives a Model and Commands |
| `evolve(state, event)` | the fold that applies a fact to the Model |
| View `watch` and `events` | Subscription that feeds the Model |
| Story (given / when / then) | Story and Scene |

The two halves meet only at the Api client, and each app writes the bridge by hand. The two Domain guides that show Foldkit show how much:

- `domain/foldkit.mdx` writes one Command per Domain command, each with an `Effect.catch` that turns a typed Rejection into a string (`error._tag`). The Rejection's fields and the command's `reply` are lost.
- `domain/foldkit.mdx` watches a View with `watch` and keeps only `state` (`({ state }) => ...`). The `cursor` that comes with it is dropped.
- `domain/optimistic-updates.mdx` reads `events` from the start on every restart and drops `Read.CaughtUp` with `Read.isEvent`. A reconnect replays the whole history, and the page cannot tell "catching up" from "live".
- Nothing carries `snapshot`'s `{ state, cursor }` into Flags, so the first paint has no data.

The guides also teach patterns that Foldkit's own conventions reject: `null` for absence instead of `Option`, `Succeeded` and `Failed` with no Command name, `GotBalance` for a Subscription fact (`Got*` is for child Submodel results), and `{ ...model }` instead of `modifyFields`.

A proof of concept against production aggregates (Foldkit canary of foldkit/foldkit#1655, Domain beta.84, `Domain.InMemory` in the browser, 51 tests) cut each command's glue to one line and each live feed's to about 15 lines.

## What Domain already gives

Domain provides these APIs:

| Need | API | PR |
| --- | --- | --- |
| The commands and Rejections of an Api, as values | `MyApi.commands`, `MyApi.rejections` (one Schema union of declared Rejections), `Domain.Api.CommandsOf`, `RejectionsOf`, `ClientOf` | alchemy#2566 |
| A command call with its own id | `client.X(target, input?, { commandId?, headers? })` gives `{ reply, stream, version }` | alchemy#2561 |
| State with its cursor | `watch(key)` gives `Read.Snapshot<S>` = `{ state, cursor }` on every change | alchemy#2579 |
| A log that resumes and marks the end of history | `events(key, { after? })` gives `View.Entry` (output event, `state` after it, `envelope`) and `Read.CaughtUp { cursor }` | alchemy#2579 |
| State and cursor from one read | `snapshot(key, { atLeast? })` gives `Read.Snapshot<S>`; typed `ConsistencyTimeout` | alchemy#2567 |
| Correlation on the wire | `Aggregate.Envelope` is a Schema with `commandId` and `correlationId`; a View output envelope carries the source `commandId` (see Open questions, 3) | alchemy#2565 |
| The aggregate's rules on the client | `Aggregate.predict`, `View.evolve` | alchemy#2568 |

The adapter in this design needs no new Domain primitive.

## Goals

1. **One line per command.** A Foldkit Command and its result Messages come from the Api. A Rejection reaches `update` typed, with its fields. The `reply` is kept.
2. **A View's state, live.** A Subscription follows `watch`, keeps the cursor in the Model, and restarts cleanly after a reconnect or a key change.
3. **A View's log, resumable.** A Subscription follows `events` from the last applied cursor, drops duplicates, and tells "catching up" from "live".
4. **No spinner on the first paint.** `snapshot` reaches the client through Flags.
5. **Foldkit conventions by default.** Absence is `Option`, the app names its own facts, and the guides pass Foldkit's lint rules.

## Non-goals

- Foldkit never imports Domain.
- No new wire protocol. The adapter uses the client from `Domain.protocolHttp` or `Domain.protocolWebSocket`.
- No generic optimistic helper in v1. See "Deferred".
- No trace fixtures in v1. They wait for alchemy#2570.
- No dependency on Foldkit's `LiveQuery` (foldkit/foldkit#1785) or on the Blocks branch (foldkit/foldkit#1655).
- No client-to-server sync, no capability catalog. Those belong to foldkit-plus (doeixd/foldkit-plus#190) and alchemy#2589.

## Placement

`@alchemy.run/domain/Foldkit`, an experimental subpath with `foldkit` as an optional peer. It is not re-exported from the package root.

- Alchemy already couples to Foldkit: `Cloudflare.Website.Foldkit`, `packages/aws/src/Website/Foldkit.ts`, a Foldkit guide, and a Foldkit bank example.
- The Domain client surface moves faster than Foldkit's.
- Foldkit stays general. Anything Foldkit gains from this work must serve any cursor-based backend.

foldkit-plus Phase 6 plans its own Domain adapter for its Remote layer. That is a different consumer at a different level. The two should share the transport and Schema seams, not compete; this is to agree in doeixd/foldkit-plus#190 after this design is accepted.

## Foldkit versions

The adapter targets the workspace catalog's Foldkit `^0.169.0`, whose `Command.define` takes `execute`. Tests and declarations run against the installed release. The Blocks branch is outside v1.

## The adapter

### 1. Commands from the Api

```ts
export const Bank = DomainFoldkit.commands(CustomerApi)
```

For each command in `CustomerApi.commands`:

| Member | What it is |
| --- | --- |
| `Bank.DepositMoney` | A Foldkit Command. Args: `{ target, input, commandId }`. It calls `client.DepositMoney(target, input, { commandId })`. |
| `Bank.Message.SucceededDepositMoney` | `{ commandId, reply, receipt: { stream, version } }`. `receipt` is what `atLeast` takes. |
| `Bank.Message.FailedDepositMoney` | `{ commandId, failure }`, where `failure` is one of the three below. |

| `failure` | When | What the app does |
| --- | --- | --- |
| `Rejected { rejection }` | The aggregate refused. `rejection` decodes with the command's declared Rejections. | Show it. The intent is over. |
| `Denied { error }` | Middleware refused (not signed in, missing MFA). | Ask for what is missing. The intent can be retried. |
| `Unknown` | Transport failure or a defect. The command may have committed before the reply was lost. | Keep the intent and retry with the same `commandId`. Never treat it as a Rejection. |

Interrupt-only Command Causes propagate without a result Message.

`Bank.Message` types come from a mapped type over `CommandsOf<A>`, not from a runtime record, so each tag keeps its own `input`, `reply`, and Rejections. Declaration tests cover an empty input, a branded target, a Schema transform in the input, and a command with middleware.

Headers such as an MFA code go through a client Layer or a config seam. They are never stored in a Message, because Messages are replayed in DevTools and Stories.

`DomainFoldkit.next(commandIds)` returns `{ commandId, commandIds }`. `CommandHeaders` is an optional service whose `get(commandName)` reads headers at execution time.

`commandId` must be unique and `update` must stay pure. `DomainFoldkit.CommandIds` is a Schema value `{ session, sent }` with a pure `next`. `session` comes from Flags, once per page load, so two tabs never share it, and a cached server render must not reuse it.

### 2. A View's state: `watchView`

```ts
watchView(CustomerApi, "AccountSummary", {
  key: (model) => model.accountId,
  toMessage: (snapshot): Message => Message.ReceivedSummary({ snapshot }),
  onFailure: (error): Message => Message.FailedWatchSummary({ reason: error._tag }),
  onDefect: (): Message => Message.FailedWatchSummary({ reason: "Read defect" }),
})
```

A Subscription entry on `watch`. The app passes its own Message, so the app names the fact. `state: null` arrives as `Option.none()`. The cursor goes into the Model with the state. `onFailure` maps a typed read failure to an app Message. `onDefect` receives the full Cause of an unexpected read defect. Interrupt-only Causes end the read without a Message. `isEnabled` can stop the stream while offline. A key change restarts the stream; a new cursor does not (`keepAliveEquivalence`, `packages/foldkit/src/subscription/subscription.ts:56` on `main`). A restart reads a fresh Snapshot. A middleware or `validate` failure becomes a Message.

This is the state source. Not every state change has an output event: the Kernel can evolve a View's state and emit nothing (for example `AccountOpened` in `Statement`), so state never comes from `events`.

### 3. A View's log: `viewEvents`

```ts
viewEvents(CustomerApi, "Statement", {
  key: (model) => model.accountId,
  cursor: (model) => model.statementCursor,
  onEntry: (entry): Message => Message.ReceivedStatementLine({ entry }),
  onCaughtUp: (cursor): Message => Message.CaughtUpStatement({ cursor }),
  onFailure: (error): Message => Message.FailedReadStatement({ reason: error._tag }),
  onDefect: (): Message => Message.FailedReadStatement({ reason: "Read defect" }),
})
```

A Subscription entry on `events(key, { after: cursor })`. The Model cursor is `Option<number>`: `None` starts without `after`. Optional `isEnabled` controls connectivity, and `restartKey` requests a new stream for the same key.

The feed:

- On a restart (offline, key change), it reads the last applied cursor from the Model (`readDependencies`) and resumes after it.
- It drops entries at or below the cursor, so a resume never applies an entry twice.
- `Read.CaughtUp` becomes `onCaughtUp`, so the app can show "live".
- It does not count gaps. On a filtered feed (`where`), the server drops entries before sending, so a `seq` gap is normal.

The adapter has no reducer. Each entry carries the View's `state` after it; any fold of entries into a list is the app's own UI shape. `View.evolve` takes source events, not View output entries, so it plays no part here.

### 4. First paint: `SnapshotFlags`

The server reads `snapshot(key)` and puts `{ state, cursor }` into Flags. `init` seeds the Model for `watchView` and the cursor for `viewEvents`. State and cursor come from one read, so the log resumes with no gap and no duplicate.

`SnapshotFlags(State)` decodes wire `{ state, cursor }` and converts null to `Option.none()`. `decodeSnapshotFlags(State, unknownFlags)` returns `None` when decode fails. The app keeps the untrusted snapshot field as `Schema.Unknown` in its outer Flags and decodes that field in init, so stale data cannot prevent boot.

Flags can be stale: a cached page, an old tab, a new deploy that changed the state's Schema. A Flags decode failure falls back to an empty Model and a fresh `watch`. An `events` failure on the Flags cursor lets the app clear the seeded state and cursor, then increment `restartKey`. The next stream starts with `after` unset. The app attempts this once; later failures reach its normal error state. Domain has no distinct stale-cursor error, so the adapter does not retry every read failure by itself.

## Failure modes

| Case | Behavior |
| --- | --- |
| Live reads and auth | Live reads authenticate by cookie only. Serve the app and the Api from one origin. |
| Platform | WebSocket push needs a store with `connect` (Cloudflare Durable Objects today). Other platforms answer 501, and the app uses `protocolHttp`, which polls. The adapter does not switch protocols on its own. |
| `validate` refuses mid-stream | The stream ends with a Rejection; the adapter turns it into a Message, never a defect. |
| `ConsistencyTimeout` on `snapshot({ atLeast })` | Typed. The page shows the previous state and retries. |
| Two tabs | Each tab has its own `session`. Nothing is shared between tabs in v1. |
| Lost reply | `Unknown`. Retry with the same `commandId`. |

## Deferred

Each needs its own design first.

- **Optimistic reconciliation.** A generic `Pending` helper does not hold. A command emits zero or more events, a View can drop or transform them, and the number of output entries with one `commandId` does not tell when a command is fully applied. A stored prediction goes stale when another device writes. The design must cover ordered intents, re-prediction from current Aggregate state, completion through the receipt and an `atLeast` read, idempotent duplicate confirmation, and where the Aggregate state for `predict` comes from (reading it over the wire may need a permission the Api does not give). Until then, the bank guide keeps its explicit pattern: confirm a pending line by `commandId` from the feed.
- **Trace fixtures.** A Domain Story run replayed as a Foldkit Story, after alchemy#2570.
- **LiveQuery.** Foldkit's keyed live feed (foldkit/foldkit#1785) becomes an optional source once `viewEvents` proves the shape and #1655 merges.

## Scope

V1 contains the `Foldkit` subpath, derived Commands and result Messages, command ids, per-call headers, View state and event Subscriptions, snapshot Flags, tests, guides, and the bank example.

Blocks, LiveQuery, trace fixtures, and a generic optimistic helper are deferred. Each needs a separate design.

## Alternatives considered

- **The adapter in Foldkit.** Foldkit would depend on Domain, and every Domain client change would need a Foldkit release.
- **The adapter in foldkit-plus.** It ties Domain users to a contract layer that does not exist yet.
- **`View.evolve` over `events` entries.** A type mismatch: `evolve` takes source events, entries are output events with the state already applied.
- **State from `events`.** Some state changes emit no event.
- **A `Pending` that confirms when the count of entries with a `commandId` reaches the predicted count.** The two counts measure different things.
- **`Rejected | Unreachable` as the only failures.** It loses middleware errors and treats a lost reply after commit as a failure.
- **`CompletedDepositMoney` with an outcome field.** It hides the Rejection in a payload. Foldkit names results `Succeeded*` / `Failed*` when failure is meaningful.

## Open questions

1. Does the Domain maintainer want an adapter subpath at all? Evidence needed: a reply on alchemy#2590 or on the design PR.
2. Resolved for this adapter: each command exposes its middleware error Schemas. The adapter builds the runtime union from them and maps the error types per command. It does not use `Middleware.Errors`.
3. The InMemory adapter test confirms that stored View entries preserve their source `commandId`. Other stores use the same envelope contract.
4. The migrated bank client builds to about 147 kB gzip with Foldkit 0.169.0. A per-helper bundle breakdown has not been measured.
5. Should a later optimistic design use client-side `predict` at all, or a server-side dry run?
