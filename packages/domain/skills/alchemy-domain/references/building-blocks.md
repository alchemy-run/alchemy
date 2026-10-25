# Building blocks

Templates for every block, taken from `examples/cloudflare-domain`. Every class is a `Domain.<Noun>(name, definition)`; extend it as `class X extends Domain.<Noun>(...) {}`.

## Id and values

```ts
// Account/Account.id.ts
import * as Schema from "effect/Schema";
export const AccountId = Schema.String.pipe(Schema.brand("AccountId"));
export type AccountId = typeof AccountId.Type;

// Money.ts
export const Cents = Schema.Int;
```

## Command, its events and its rejections

```ts
// Account/WithdrawMoney.command.ts
import * as Domain from "@alchemy.run/domain";
import { MfaChallenge } from "../MfaChallenge.middleware.ts";
import { Cents } from "../Money.ts";
import { Session } from "../Session.middleware.ts";
import { AccountId } from "./Account.id.ts";
import { NotOpen } from "./NotOpen.rejection.ts";

export class DailyLimitExceeded extends Domain.Rejection("DailyLimitExceeded", { remaining: Cents }) {}

export class MoneyWithdrawn extends Domain.Event("MoneyWithdrawn", {
  amount: Cents,
  balanceAfter: Cents,
}) {}

/** Take money out of an account, within the balance and the daily limit. */
export class WithdrawMoney extends Domain.Command("WithdrawMoney", {
  target: AccountId,                       // the aggregate id it targets
  middleware: [Session, MfaChallenge],     // authenticate; provide context to decide
  input: { amount: Cents },
  events: [MoneyWithdrawn],                // every event it may record
  rejects: [NotOpen, DailyLimitExceeded],  // every way it can be refused
  reply: { balance: Cents },               // optional typed reply
  attributes: (cmd) => ({ "bank.amount": cmd.amount }),  // optional: what its spans record
}) {}
```

A rejection with no fields: `class NotOpen extends Domain.Rejection("NotOpen") {}` in `NotOpen.rejection.ts`. Events and rejections take `attributes` as a third argument: `Domain.Event("MoneyWithdrawn", { ... }, { attributes: (e) => ({ ... }) })`. Nothing from a payload is traced unless `attributes` returns it, and `Redacted` values record as `<redacted>`.

## Aggregate

```ts
// Account/Account.aggregate.ts
export class Account extends Domain.Aggregate("Account", {
  id: AccountId,
  state: AccountState,                    // a Schema, usually a TaggedStruct union
  initial: { _tag: "Unopened" },
  commands: [OpenAccount, DepositMoney, WithdrawMoney],  // events derive from the commands
  decide: {
    OpenAccount: (s, cmd) =>
      s._tag !== "Unopened" ? new AlreadyOpen() : [new AccountOpened({ owner: cmd.owner })],
    // Effect.fn when decide reads middleware context or the clock
    WithdrawMoney: Effect.fn(function* (s, cmd, { now }) {
      const actor = yield* CurrentActor;
      if (s._tag !== "Open") return yield* new NotOpen();
      if (cmd.amount > s.balance) return yield* new InsufficientFunds({ balance: s.balance });
      return [new MoneyWithdrawn({ amount: cmd.amount, balanceAfter: s.balance - cmd.amount })];
    }),
  },
  evolve: {
    AccountOpened: (_, e) => ({ _tag: "Open" as const, owner: e.owner, balance: 0 }),
    MoneyWithdrawn: (s, e) => ({ ...s, balance: e.balanceAfter }),
  },
  reply: { WithdrawMoney: (s) => ({ balance: s.balance }) },
  // optional: let clients read/watch the aggregate through an Api
  read: { middleware: [Session], rejects: [NotOwner], validate: Effect.fn(function* (_req, s) { /* authorize */ }) },
}) {}
```

`decide` returns an array of events (`[]` for a no-op) or a rejection. `Aggregate.ref(id)` builds a reference for stories and views.

## Request context and middleware

```ts
// CurrentActor.context.ts
export class CurrentActor extends Domain.RequestContext<CurrentActor>()("Bank/CurrentActor", Actor) {}

// Session.middleware.ts (domain): the declaration, its error, and a client helper
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}
export class Session extends RpcMiddleware.Service<Session, { provides: CurrentActor }>()(
  "Bank/Session",
  { error: Unauthorized },
) {}

// server/src/Session.ts: the implementation
export const SessionLive = Layer.succeed(Session, (effect, { headers }) =>
  Option.match(actorOf(headers), {
    onNone: () => Effect.fail(new Unauthorized()),
    onSome: (actor) => Effect.provideService(effect, CurrentActor, actor),
  }),
);
```

A `RequestContext` has a schema, so its value travels with the command to the aggregate's Durable Object. A `decide` that reads `CurrentActor` won't type-check for a command without the middleware that provides it.

## View

```ts
// Account/AccountSummary.view.ts
export class AccountSummary extends Domain.View("AccountSummary", {
  from: [Account],             // aggregates or other views
  key: Account,                // what one row is about
  middleware: [Session],
  rejects: [NotOwner],
  state: Schema.Struct({ customerId: Schema.NullOr(CustomerId), balance: Cents }),
  initial: { customerId: null, balance: 0 },
  evolve: {
    AccountOpened: (v, e) => ({ ...v, customerId: e.customerId }),
    MoneyWithdrawn: (v, e) => ({ ...v, balance: e.balanceAfter }),
  },
  // judged on every get, list, and every change while watched
  validate: Effect.fn(function* (_request, summary) {
    yield* mustOwn(summary?.customerId ?? null);
  }),
}) {}
```

Emit derived events with `events: [StatementLine]` and `emit: { MoneyDeposited: (e) => new StatementLine({...}) }`. Each emitted event carries the view's state after it. Route one event to several keys with named routes:

```ts
keyOf: {
  TransferRequested: {
    out: ({ event }) => Account.ref(event.from),
    in: ({ event }) => Account.ref(event.to),
  },
},
emit: { TransferRequested: { out: moved("out"), in: moved("in") } },
```

A view keyed by a different aggregate than its source uses `keyOf`, returning `undefined` to skip. Add derived fields with `computed: { total: (v) => ... }`.

## Policy

```ts
// Customer/MainAccountProvisioning.policy.ts
export class MainAccountProvisioning extends Domain.Policy("MainAccountProvisioning", {
  from: Customer,
  on: [CustomerRegistered],
}) {}

export const MainAccountProvisioningLive = MainAccountProvisioning.toLayer(
  Effect.gen(function* () {
    const accounts = yield* Account;   // resolve clients once
    return Effect.fn(function* ({ source, event }) {
      yield* accounts
        .send(mainAccountId(source.id), new OpenAccount({ customerId: source.id, owner: event.name }))
        .pipe(Effect.catchTag("AlreadyOpen", () => Effect.void));   // handle every rejection
    });
  }),
);
```

The handler receives `{ key, source, event, envelope, state }` (`state` for a view source). It must handle every rejection. A policy has no session, so it provides context itself: `.pipe(Effect.provideService(CurrentActor, system("FraudReview")))`. To send a command later, durably, use `transfers.schedule(ref, new ExpireTransfer(), { after: "24 hours" })`. Only commands that never reject can be scheduled.

## Saga

```ts
// Transfer/ExecuteTransfer.saga.ts
export const Decision = DurableDeferred.make("decision", { success: Schema.Literals(["approved", "expired"]) });

export class ExecuteTransfer extends Domain.Saga("ExecuteTransfer", {
  key: TransferId,
  input: { from: AccountId, to: AccountId, amount: Cents, requestedBy: Actor, needsApproval: Schema.Boolean },
  rejects: [NotOpen, InsufficientFunds, DestinationClosed],
}) {}

export const ExecuteTransferLive = ExecuteTransfer.toLayer(
  Effect.gen(function* () {
    const accounts = yield* Account;
    const transfers = yield* Transfer;
    return Effect.fn(function* ({ key, from, to, amount, requestedBy, needsApproval }) {
      if (needsApproval && (yield* DurableDeferred.await(Decision)) === "expired") return;
      yield* Activity.make({
        name: "debit",
        error: Schema.Union([NotOpen, InsufficientFunds]),
        execute: accounts.send(from, new DebitTransfer({ transferId: key, amount, requestedBy })),
      }).pipe(
        ExecuteTransfer.withCompensation(() =>
          Activity.make({ name: "refund", execute: accounts.send(from, new RefundTransfer({ transferId: key, amount })) }),
        ),
      );
      yield* Activity.make({ name: "credit", error: DestinationClosed, execute: /* ... */ });
      yield* Activity.make({ name: "complete", execute: transfers.send(key, new CompleteTransfer()) });
    });
  }),
);
```

Start and signal it from a policy, keyed by the aggregate:

```ts
const executions = yield* ExecuteTransfer;
yield* executions.start(source, { from, to, amount, requestedBy, needsApproval });  // returns a run handle at once
yield* executions.get(source).signal(Decision, "approved");
// run handle: executionId, status, result, signal(deferred, value), interrupt
```

Rules:
- One command per step. Commands inside a step get stable ids, so a retried step doesn't apply twice.
- Report each outcome to an aggregate (`CompleteTransfer`, `FailTransfer` in a `Workflow.addFinalizer`), so views can follow the process.
- `DurableClock.sleep` waits durably.

## External system

```ts
// Fraud/FraudCheck.external.ts (domain)
export class FraudCheck extends Domain.ExternalSystem("FraudCheck", {
  score: { args: { accountId: AccountId, amount: Cents }, success: { risk: Schema.Number } },
}) {}

// server/src/Fraud/SiftFraudCheck.ts
export const SiftFraudCheck = FraudCheck.toLayer(
  Effect.succeed({ score: ({ amount }) => Effect.succeed({ risk: amount >= 80_000 ? 0.95 : 0.05 }) }),
);
```

Use it with `const fraud = yield* FraudCheck` in a policy or saga `toLayer`, then call `fraud.score({...})`. Declare typed errors per operation with `error:`. In a story, systems in `stub` are faked and the story answers their calls; the others run for real from a Layer you provide, and the story asserts what each call sent and returned. See [testing.md](testing.md).

## Projection and its port

```ts
// Ledger/LedgerStore.ts (domain): the port, plus a memory implementation for stories
export class LedgerStore extends Context.Service<LedgerStore, {
  readonly record: (rows: ReadonlyArray<LedgerRow>) => Effect.Effect<void, never, RuntimeContext>;
}>()("Bank/LedgerStore") {}

// Ledger/Ledger.projection.ts
export class Ledger extends Domain.Projection("Ledger", {
  from: [Account],
  key: Account,
  on: [MoneyDeposited, MoneyWithdrawn],
}) {}

export const LedgerLive = Ledger.toLayer(
  Effect.gen(function* () {
    const store = yield* LedgerStore;
    return Effect.fn(function* (batch) {
      yield* store.record(batch.map(({ key, event, envelope }) => ({
        id: `${envelope.stream}:${envelope.seq}`,   // idempotent: a replay upserts the same row
        accountId: key.id, kind: event._tag, amount: event.amount,
      })));
    });
  }),
  { batch: { size: 100, wait: "1 second" } },   // tuning lives on the Layer
);
```

The server provides `LedgerStore` with D1; a story provides it with memory.

## Stream

```ts
// Account/AccountCard.stream.ts
export class CardChanged extends Domain.Event("CardChanged", { balance: Cents, frozen: Schema.Boolean }) {}

export class AccountCard extends Domain.Stream("AccountCard", {
  key: Account,
  entries: [CardChanged],
  middleware: [Session],
  rejects: [NotOwner],
  validate: Effect.fn(function* (_request, latest) { /* authorize on the latest entry */ }),
}) {}
```

A projection with `writes: [AccountCard]` appends entries with `yield* cards.append(input, new CardChanged({...}))`. Clients `peek`, `watch`, `list` and read `events`.

## Api

```ts
// CustomerApi.api.ts
export class CustomerApi extends Domain.Api(
  "CustomerApi",
  RegisterCustomer, DepositMoney, WithdrawMoney,   // commands: client methods
  Account,                                          // aggregates with `read`
  AccountSummary, Statement,                        // views
  AccountCard,                                      // streams
) {}
```

Clients call commands as methods (`bank.WithdrawMoney({ target, amount }, { headers })`) and reads as namespaces. A view or aggregate has `get(id)` and `watch(id)` for its state, and `events(id)` and `list(id, { take, after })` for what it emitted. A stream has `peek`, `watch`, `events` and `list`. Each Api entry authorizes itself.

`Domain.Api.describe(CustomerApi)` lists every call the Api serves as plain JSON: entry, kind, operation (`send`, `get`, `peek`, `watch`, `events`, `list`), RPC tag, `mode` (`read` or `write`), whether it streams, and JSON Schemas for its input, success and typed errors. Build tool lists, CLI help or OpenAPI from it instead of a second hand-written list, and snapshot it in a test to catch a change to the public surface.

`@alchemy.run/domain/ai` gives an agent the Api as tools. `DomainAi.toToolkit(CustomerApi, { headers })` returns `{ toolkit, layer }`: an Effect AI `Toolkit` with one tool per call that returns once (`send`, `get`, `peek`, `list`; not `watch` or `events`), named `<api>_<entry>_<operation>`, and the Layer of its handlers. `DomainAi.toMcp(CustomerApi)` registers the same tools on Effect's `McpServer`; provide `McpServer.layerHttp` (or `layerHttpRequestScoped` on a Worker) and the model. Each call goes through the Api in process, so middleware, `validate` and rejections apply to the agent. By default a call sends the current HTTP request's headers to the middleware, so an MCP client signs in like any other client. Serve MCP from the server package.

```ts
// packages/server/src/BankMcp.ts
const BankMcp = DomainAi.toMcp(CustomerApi).pipe(
  Layer.provide(McpServer.layerHttp({ name: "bank", version: "1.0.0", path: "/mcp", protocols: [McpProtocol.v2025_11_25] })),
  Layer.provide(BankLive),
);
```

## Model

```ts
// Bank.model.ts
export class Bank extends Domain.Model("Bank", {
  aggregates: [Customer, UsernameClaim, Account, Transfer],
  views: [AccountSummary, Statement, CustomerDashboard],
  policies: [UsernameReservation, MainAccountProvisioning, TransferExecution],
  projections: [Ledger, AccountCards],
  streams: [AccountCard],
  sagas: [ExecuteTransfer],
}) {}

/** Every policy, saga and projection implementation, as one Layer. */
export const BankHandlers = Layer.mergeAll(
  UsernameReservationLive, MainAccountProvisioningLive, TransferExecutionLive,
  ExecuteTransferLive, LedgerLive, AccountCardsLive,
);
```

`Bank.layer(BankHandlers)` hosts the model on whatever platform is provided: `Domain.InMemory` or `DomainCloudflare.DurableObjects`.
