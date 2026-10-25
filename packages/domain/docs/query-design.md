# Design: `Domain.Query`

Status: proposal, implemented on the `domain-query` branch.

## The problem

Every read the model serves today is tied to one key. A view, a stream, or an aggregate with a `read` contract answers `get`, `watch`, `events` and `list` for one key, and `where` filters run in memory on that key's rows (`matches` in `src/Filter.ts`). There is nothing to read across keys.

The answer for cross-key reads is a `Domain.Projection` that writes to a store the app owns. But a projection covers only the write side. Its docs say so: "you choose where it writes and handle serving it yourself". The bank example serves its ledger from a hand-written route in `examples/cloudflare-domain/packages/server/src/BankWorker.ts`:

```ts
const LEDGER = /^\/api\/ledger\/([^/]+)$/;
// ...
const ledgerRoute = (accountId: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const actor = actorOf(request.headers);
    if (Option.isNone(actor)) return HttpServerResponse.empty({ status: 401 });
    const summary = yield* summaries.query(Account.ref(accountId)).pipe(Effect.orDie);
    const owner = Option.getOrNull(summary)?.customerId;
    if (actor.value._tag === "Customer" && owner !== actor.value.customerId) {
      return HttpServerResponse.empty({ status: 404 });
    }
    return yield* HttpServerResponse.json(yield* ledger.forAccount(accountId));
  });
```

That route:

- re-implements authentication (`actorOf(headers)`) and authorization (an ownership check against `AccountSummary`, then 401 or 404) by hand, outside the `Session` middleware and the `mustOwn` rule every other read uses;
- returns untyped JSON (`LedgerRow` is a TypeScript interface, not a schema);
- has no typed client, no `atLeast` (`Ledger.caughtUp(receipt)` exists only on the server), no pagination, and no story coverage.

Each such route is a new, improvised design. That costs consistency, especially when agents write the code, and it costs authorization most, which is the motivating case: health data with per-row access rules.

Prior art agrees on the shape of the fix. Axon declares `@QueryHandler`s for query messages sent through a `QueryGateway`. Marten exposes projections as queryable documents. Commanded keeps a thin Ecto read side. In each, queries are messages, declared next to commands with input and result types and authorization, and the read side stays thin, with no domain logic.

## Requirements

1. Declared in the domain package, which imports only `@alchemy.run/domain` and `effect`: a name, an `input`, a result, `middleware`, `rejects`, and authorization consistent with `validate` on views and `decide` on commands.
2. Implemented against the app's store, usually the port a projection writes through, with `toLayer`. Dependencies resolve once; the handler needs nothing per call but the request's own context.
3. Exposed through `Domain.Api` like commands and views: a typed client method, schema-encoded and decoded on both sides, with middleware errors and rejections reaching the client typed.
4. Read-your-writes: `atLeast: receipt` waits until the projections the query reads from have handled that write, on top of `Projection.caughtUp`.
5. Testable in stories, against the in-memory platform and memory stores.
6. Traced like the other blocks: a `Domain.query` span, input attributes opt-in only, `Redacted` respected.
7. A clear answer for pagination and for per-row versus per-request authorization.

## Differences from the brief

The brief was written against a pkg.alchemy.run build of PR #2392. This design is against `main` (`085974d10`), which differs:

- There is no `SqlStorage.ts` or `StoragePlatform.ts` on `main`. Platforms are `Domain.InMemory` and `@alchemy.run/cloudflare/Domain`'s `DurableObjects`. A query needs no platform support, so nothing changes for a future storage platform either.
- `Filter` and `OrderBy` exist on `main` as TypeScript types with in-memory evaluators (`matches`, `sort`). They are not schemas; on the wire a view's `where` is `Schema.Unknown`.
- On `main`, `LedgerStore` (the port) and `LedgerLive` (the projection's implementation) live in the bank's domain package; only `D1LedgerStore` is in the server package.

## Declaration

A query is a message: a name, its input, its result, who may send it, and how it is refused. It is declared in a `<Noun>.query.ts` file in the domain package.

```ts
// packages/domain/src/Ledger/AccountLedger.query.ts
export const LedgerEntry = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  amount: Cents,
  balanceAfter: Cents,
  at: Schema.Number,
});

export class AccountLedger extends Domain.Query("AccountLedger", {
  input: { account: AccountId },
  row: LedgerEntry,                // a paged result: { entries, cursor }
  from: [Ledger],                  // the projections it reads; `atLeast` waits on them
  middleware: [Session],
  rejects: [NotOwner],
  // Per request, before the store is read: may this caller ask this question?
  validate: Effect.fn(function* ({ account }) {
    const summaries = yield* AccountSummary;
    const summary = yield* summaries.query(Account.ref(account)).pipe(Effect.orDie);
    yield* mustOwn(Option.getOrNull(summary)?.customerId ?? null);
  }),
}) {}
```

The options:

| Option | Meaning |
| --- | --- |
| `input` | The query's fields, like a command's `input`. Filters, sort keys and scopes are fields here. |
| `row` | A paged query: the schema of one row. The result is `{ entries: Row[], cursor: string \| null }`. |
| `success` | A single-result query: the schema of the result. Exclusive with `row`. |
| `from` | The projections whose stores the query reads. `atLeast` waits on each. |
| `middleware` | Guards the query in an Api, in order. What it provides is what `validate`, `visible` and the handler may read. |
| `rejects` | The rejections it may fail with; they reach the client typed. |
| `validate` | Per request: `(input, { atLeast }) => Effect<void, Rejection>`. |
| `visible` | Per row, paged queries only: `(row, input) => Effect<boolean>`. Rows it refuses are dropped. |
| `take` | Page size: `{ default, max }`, by default `{ default: 50, max: 500 }`. |
| `attributes` | Span attributes for the input, like a command's. Nothing is recorded unless returned here. |

`validate` and `visible` may read what the middleware provides and what the hosted model provides (its views, aggregates, streams, sagas and projection progress), so a rule can look up a relationship ("the caller is on this trial's team") in a view. Both are checked by type: anything else fails at the declaration, and a member the model does not host becomes a requirement of the model's Layer that nothing can satisfy, so it fails to type-check rather than at run time. At run time the model's members are merged under the request's own services, so the request always wins.

## Implementation

A query is a model member, like a projection, and its implementation is a Layer, built once.

```ts
// packages/domain/src/Bank.model.ts
export class Bank extends Domain.Model("Bank", {
  aggregates: [/* ... */],
  projections: [Ledger, AccountCards],
  queries: [AccountLedger],
}) {}

export const BankHandlers = Layer.mergeAll(/* ... */, LedgerLive, AccountLedgerLive);
```

```ts
// packages/domain/src/Ledger/AccountLedger.query.ts
export const AccountLedgerLive = AccountLedger.toLayer(
  Effect.gen(function* () {
    const store = yield* LedgerStore;
    return ({ account }, page) => store.forAccount(account, page);
  }),
);
```

The handler receives the decoded input and, for a paged query, `{ after, take }` with `take` already clamped. It returns the result, or fails with a declared rejection. It may require what the middleware provides (to scope a store query by the caller) and `RuntimeContext` (a database binding), as a projection's handler may.

Where the implementation lives follows the existing rule: "a block's implementation sits in its file, unless it touches infrastructure". `AccountLedgerLive` uses only the `LedgerStore` port, so it sits next to the declaration, like `LedgerLive`. The server package provides the port with D1. A handler that talks to a database directly lives in the server package and is merged into the handlers Layer there.

Why a model member, and not a service the Api requires directly:

- The model already builds every handler with the model's own services available, so a handler can resolve a view or a port while it is constructed.
- `Model.layer(handlers)` requires the implementation by type, and a story gets it from the same `layer` option as the projections.
- The model can check the declaration when it is built: `from` must name projections it hosts.
- The Api finds the query's runner in `Model.Internals`, as it finds a command's aggregate.

## Api and client

An Api lists queries next to commands and reads.

```ts
export class CustomerApi extends Domain.Api(
  "CustomerApi",
  DepositMoney,
  AccountSummary,
  AccountLedger,
) {}
```

The client calls a query as a method, like a command:

```ts
const receipt = yield* bank.WithdrawMoney({ target: accountId, amount: 10 }, mfa);
const page = yield* bank.AccountLedger(
  { account: accountId },
  { atLeast: receipt, take: 20 },
);
const next = yield* bank.AccountLedger({ account: accountId }, { after: page.cursor!, take: 20 });
```

The wire value is `{ input, after?, take?, atLeast? }`, so a query's own fields never collide with the paging and consistency options. The success schema is the `row` page or `success`. The error schema is the union of `rejects`, plus `ConsistencyTimeout` when `from` is not empty. As with every entry, anything else (an infrastructure error, an undeclared rejection) becomes a defect, so it never reaches the client as an error it cannot decode.

The client's error type is `QueryError<Q>`: the declared rejections, the middleware's errors, `ConsistencyTimeout` when the query has `from`, and `RpcClientError`.

## Authorization

Views authorize every read with `validate(request, state)`: the middleware says who is asking, and the key's own state says what they ask about. A query has no single key, so it splits that in two.

**Per request: `validate(input, { atLeast })`.** It runs before the store is read and judges whether this caller may ask this question at all: the caller owns the account, is on the trial's team, has the role. It fails with a declared rejection, which reaches the client typed. It is the query's counterpart of a view's `validate`, and it is where most rules belong.

`validate` runs before the `atLeast` wait. An unauthorized caller is refused at once, and cannot make the server wait on a projection. When the rule reads a view that the same write updates (the caller was just added to a team), `validate` receives `atLeast` and can pass it to that view's `query(key, { atLeast })`. Only for a write to an aggregate that view consumes: a view's checkpoint for a stream it never receives stays at 0, so the read would wait out the timeout.

**Per row: `visible(row, input)`.** It runs on every row of a paged result and drops the rows it refuses. It never rejects: rejecting a whole page because one row is hidden would leak that the row exists, and would break paging. The span records how many rows were hidden (`domain.query.hidden`).

How they fit together:

1. The handler scopes its store query by the caller where the rule allows (a `WHERE` on the owner, the site, the team). That is the only way to return full pages from a large store.
2. `visible` states the rule in the domain, and is checked on every row the handler returns. A handler that forgets a scope, or a row whose access changed after the projection wrote it, is caught there. It is the guarantee, not the filter.
3. Keep `visible` cheap: compare row fields with what the middleware provides. A rule that needs a lookup belongs in `validate`, once per request, not once per row.

A query is a security boundary, like a view: to show an audience different rows, make another query rather than branching on the caller inside one.

## Read-your-writes

A client that has just sent a command passes its receipt:

```ts
const receipt = yield* bank.DepositMoney({ target: accountId, amount: 100 });
const page = yield* bank.AccountLedger({ account: accountId }, { atLeast: receipt });
```

`atLeast` is `{ stream, version }`, the same value a view's `get` takes, so a command's client result can be passed as is. For each projection in `from`, the query waits until it has handled every event of that command it consumes, then runs the handler.

The command's events are not on the wire: the client only has `stream` and `version`. So `Projection.Progress.caughtUp` now accepts a receipt without `events`, and looks them up. It reads the aggregate's events up to `version` (clamped to the instance's current version) from a small window before it, widening the window until it reaches an event of an earlier command, and keeps the events that share the last one's `commandId`. Usually that is one read of a handful of events. Then it waits exactly as before: for each key those events route to, until the key's checkpoint for the stream reaches the event's `seq`.

Failure modes:

- **Timeout.** After 10 seconds (the same default as views and streams), the query fails with `Domain.ConsistencyTimeout { view, key, stream, version }`, where `view` names the projection. It is typed on the wire, so a client can retry or show a stale notice. `ConsistencyTimeout` becomes a schema-backed tagged error for this; its fields and tag are unchanged.
- **A receipt from another aggregate.** If no projection in `from` consumes that aggregate, there is nothing to wait for and the query runs at once.
- **A version beyond the instance's.** It is clamped to the current version. A forged receipt can make the query wait at most for events that exist.
- **A no-op command** (accepted with no events) has `version` equal to the instance's current version, so the wait covers the instance's last command. That is stricter than needed, and harmless.
- **No `from`.** `atLeast` is accepted and ignored.

Like `caughtUp` today, the wait covers events a projection consumes directly from the aggregate. A projection fed by a view is not waited on through the view.

Views keep their current behaviour: a view `get` whose `atLeast` times out is still a defect on the client. Making it typed too is a follow-up.

## Pagination

Paging is cursor-based, and the cursor is opaque to the framework.

- The client sends `take` (clamped to `[1, take.max]`, default `take.default`) and `after`, a cursor from the previous page.
- The handler receives `{ after, take }` and returns `{ entries, cursor }`, with `cursor: null` on the last page. It chooses the cursor's encoding: keyset paging on the store's sort key (`"<at>:<id>"`) is stable under concurrent writes; an offset is not.
- `visible` may drop rows, so a page can be shorter than `take` without being the last. Clients page until `cursor` is `null`, as they do for a view's `list`.
- Sorting and filtering are input fields. A query declares the filters and sort orders it supports, and the store indexes them.

`Filter` and `OrderBy` from `src/Filter.ts` are deliberately not part of the input:

- They are evaluated in memory, by `matches` and `sort`, on rows the platform already holds. A query's store is a database or an index; each adapter would need a compiler from `Filter` to its query language.
- An open filter over every field widens what a client can ask, and so what `validate` must judge. A query's input is its contract: declared fields, typed on the wire, indexed in the store, and authorized in `validate`.
- They are TypeScript types without schemas, while a query's input must decode on the server.

A query that wants an expressive filter can declare a field with the schema of exactly the filter it supports.

## Stories

A story runs a query against the in-memory model, with the context `Story.provide` set, just as it sends commands. The implementation comes from the story's `layer`, with the other handlers.

```ts
const story = Story.make(Bank, {
  layer: BankHandlers.pipe(Layer.provide(MemoryLedgerStore)),
  stub: [FraudCheck, Payments],
});

it.effect("an owner reads their account's ledger; others are refused", () =>
  story(
    given(a1, opened(), new MoneyDeposited({ amount: 10_000, balanceAfter: 10_000 })),
    as(sam),
    when(a1, new WithdrawMoney({ amount: 2_500 })),
    Story.query(AccountLedger, { account: a1.id }, [
      { kind: "MoneyDeposited", amount: 10_000 },
      { kind: "MoneyWithdrawn", amount: 2_500 },
    ]),
    as(alex),
    Story.query(AccountLedger, { account: a1.id }),
    rejected(new NotOwner()),
  ),
);
```

- `Story.query(Q, input, expected?, { take, after }?)` runs the query: `validate`, the handler, then `visible`. The result goes through the wire schema and back, so the story sees what a client would.
- `expected` is the rows in order, each a partial match, for a paged query; a partial result for a single-result query; or a function over the result.
- A rejected query is recorded like a rejected command: the next step must be `Story.rejected(...)`, or the story fails.
- Every `when` already runs projections until the model settles, so a story needs no `atLeast`.

## Tracing

Each run is a `Domain.query <Name>` span, under the RPC server's span when served by an Api.

- `domain.query`: the query's name.
- `domain.outcome`: `ok`, the rejection's tag, or `defect`, as for commands.
- `domain.query.rows` and `domain.query.hidden`: rows returned and rows `visible` dropped, for paged queries.
- The input's attributes, only those `attributes` returns, flattened and capped, with `Redacted` values recorded as `<redacted>`, through the same `Telemetry.attributesOf` as commands.
- An `atLeast` wait is a child span, `Domain.caughtUp <Projection>`, with `domain.stream` and `domain.version`.

The `domain.queries` counter counts runs by `domain.query` and `domain.outcome`.

## Hosting

Nothing in `Platform` changes. A query runs wherever the Api's handlers run, and reads the app's store plus the platform's read paths.

- **InMemory:** in the process. Stories and `testClient` use it.
- **Cloudflare:** in the Worker, inside the Api's RPC handler, like a view's `get` and `list`. It never runs in a Durable Object: it has no key, so no object owns it, and the app's store (D1, a search index) is bound to the Worker. `validate` reading a view calls that view's Durable Object. `atLeast` reads the aggregate's events from its Durable Object once, then polls the projection keys' Durable Objects for checkpoints every 25ms, as a view's `atLeast` does.
- **A storage platform** (PR #2392): the same. A query only needs `AggregateStore.state` and `tail`, and `ProjectionStore.checkpoints`, which every platform provides.

A query is a request-response RPC, so `Domain.protocolWebSocket` sends it over HTTP like a command or a view's `get`.

## Alternatives considered

- **A view over all keys, or a view with SQL storage.** That makes the platform a query engine, and couples the read model to one store. Projections already let the app pick the store; what was missing is serving it.
- **`Domain.Api` routes with a raw handler** (`Domain.Route("GET /ledger/:id", handler)`). It would fix routing, but not typing, authorization or testing: the handler would still do its own auth and return untyped JSON. Declaring the query as a message is what makes `validate`, `rejects` and stories possible.
- **The Api requiring the implementation directly**, as an Effect service, without making queries model members. It works, but stories would need a second place to provide implementations, the handler could not resolve model services at construction, and nothing would check `from`.
- **A generic `where: Filter<Row>` and `orderBy: OrderBy<Row>` input.** Rejected for the reasons under Pagination.
- **Per-row authorization that rejects.** Rejected: it leaks the existence of hidden rows and breaks paging.
- **Per-row authorization only, without `validate`.** Rejected: most rules are about the question, not the rows, and per-row checks that need lookups cost one lookup per row.
- **Returning the command's events in its client result**, so `atLeast` could reuse `caughtUp` unchanged. Rejected: events may carry data the client should not see, and it changes every command's wire shape.
- **Waiting on every event of the stream up to `version`.** Correct, but it reads the instance's whole history on every query.
- **`ConsistencyTimeout` as a defect**, as for views today. Rejected for queries: the client should be able to tell "not caught up yet" from a failure.

## Follow-ups

- **Live queries (`watch`).** A query has no key, so no object owns it and nothing can push on a commit. Options: re-run on the projection's checkpoints advancing for keys the result touched, or have the handler declare the keys it depends on. Neither is cheap, and polling from the client with `atLeast` covers today's screens. Not in this change.
- **Projection reset and rebuild.** A query reads whatever the projection wrote; rebuilding is independent of serving it. Not in this change.
- **Typed `ConsistencyTimeout` for views and streams**, matching queries.
- **A `timeout` option for `atLeast`**, on the client or the query's Layer. The default is the views' 10 seconds.
- **`atLeast` through a view-fed projection**, for views and projections alike.
- **A query reading model state only** (no projection), as a cross-key read over views: possible today with `from: []`, but views have no cross-key read API to call.
