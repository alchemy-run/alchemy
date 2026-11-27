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

More: [Aggregate: Give it an identity](https://alchemy.run/domain/aggregate#give-it-an-identity).

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
  middleware: [Session, MfaChallenge],     // authenticate; provide context to decide
  input: { accountId: AccountId, amount: Cents },  // includes the id of the instance it is for
  events: [MoneyWithdrawn],                // every event it may record
  rejects: [NotOpen, DailyLimitExceeded],  // every way it can be refused
  reply: { balance: Cents },               // optional typed reply
}) {}
```

A rejection with no fields: `class NotOpen extends Domain.Rejection("NotOpen") {}` in `NotOpen.rejection.ts`. Nothing from a payload is traced unless a handler annotates it: `yield* Effect.annotateCurrentSpan("bank.amount", cmd.amount)` in `decide` lands on the engine's `Domain.decide` span.

`Domain.Rejection(tag, fields, annotations)` is `Schema.TaggedError` with its type filled in: the third argument takes the same annotations (`httpApiStatus`, `description`, ...) `rejects` takes any tagged error class, `HttpApiError.Forbidden` included.

More: [Command: Annotate a rejection](https://alchemy.run/domain/command#annotate-a-rejection).

More: [Command](https://alchemy.run/domain/command), [Event](https://alchemy.run/domain/event).

## Aggregate

```ts
// Account/Account.aggregate.ts
type Open = Extract<AccountState, { _tag: "Open" }>;

// A shared rule: the narrowed state, or the rejection. Every decide handler starts from it.
const openFor = (s: AccountState): Open | NotOpen => (s._tag === "Open" ? s : new NotOpen());

export class Account extends Domain.Aggregate("Account", {
  id: AccountId,
  state: AccountState,                    // a Schema, usually a TaggedStruct union
  initial: { _tag: "Unopened" },
  commands: [OpenAccount, DepositMoney, WithdrawMoney],  // events derive from the commands
  keyOf: (cmd) => cmd.accountId,
  decide: {
    OpenAccount: (account, cmd) =>
      account._tag !== "Unopened" ? new AlreadyOpen() : [new AccountOpened({ owner: cmd.owner })],
    DepositMoney: (account, cmd) => {
      const o = openFor(account);
      if (o._tag !== "Open") return o;
      return [new MoneyDeposited({ amount: cmd.amount, balanceAfter: o.balance + cmd.amount })];
    },
    // Effect.fn when decide reads middleware context; fail with `return yield* rejection`
    WithdrawMoney: Effect.fn(function* (account, cmd) {
      const o = openFor(account);
      if (o._tag !== "Open") return yield* o;
      if (o.owner !== (yield* CurrentActor).customerId) return yield* new NotOwner();
      if (cmd.amount > o.balance) return yield* new InsufficientFunds({ balance: o.balance });
      return [new MoneyWithdrawn({ amount: cmd.amount, balanceAfter: o.balance - cmd.amount })];
    }),
  },
  evolve: {
    AccountOpened: (_, e) => ({ _tag: "Open" as const, owner: e.owner, balance: 0 }),
    // decide already refused a closed account: keep any state the event can't follow
    MoneyDeposited: (s, e) => (s._tag === "Open" ? { ...s, balance: e.balanceAfter } : s),
    MoneyWithdrawn: (s, e) => (s._tag === "Open" ? { ...s, balance: e.balanceAfter } : s),
  },
  reply: { WithdrawMoney: (s) => ({ balance: s._tag === "Open" ? s.balance : 0 }) },
}) {}
```

An aggregate's state is never read by clients directly: a view projects what they may see of it.

`Aggregate.ref(id)` builds a reference for stories and views.

To move history in from another system, `accounts.import(id, events, { commandId })` appends already-decided events without `decide` (pass `{ event, at }` to keep an event's original commit time; times must go forward from the instance's latest event and not pass the clock, else `ImportOutOfOrder`): views and projections apply them, policies and sagas never react. A retry with the same `commandId` returns the first receipt; it fails with `UnexpectedVersion` unless the instance is at `expectedVersion` (default `0`, so import in batches by passing the previous receipt's `version`). Wait with `Projection.caughtUp(receipt)`.

More: [Aggregate](https://alchemy.run/domain/aggregate).

### Patterns for decide, evolve and reply

- **decide answers one of three ways.** Events when the command changes something; `[]` when the state already is what it asks for (freezing a frozen account); a declared rejection when it can't be done.
- **Name shared rules as pure guards** that return the narrowed state or the rejection (`openFor`), and start each handler from one. In an `Effect.fn` handler, fail with `return yield* o`.
- **Events carry the outcome**, not just the request (`balanceAfter`), so `evolve` copies it and never repeats a rule. Views and policies see the same numbers.
- **decide reads time from `now`** (its third argument) and the actor from middleware context. In an effectful `decide`, `DateTime.now` and `Clock.currentTimeMillis` give that same time. Never `Date.now()` or randomness.
- **evolve and reply are total and never fail.** decide already refused the command, so a handler keeps any state its event can't follow: `s._tag === "Open" ? { ...s, balance: e.balanceAfter } : s`. An event that changes the stage returns the new state whole.
- **Use optics (`effect/Optic`) once an `evolve` nests or repeats a check**, in aggregates and views alike. Never spread three levels deep. `Optic.id<State>().tag("Open").key("balance")` focuses on a field of one state; `.key("issues").at(id)` on a record entry, and does nothing when it is missing; `.key("issues").optionalKey(id)` on one that may be added. `Optic.replace(s, balance, e.balanceAfter)` sets a field, `issue(id).key("replies").modify((n) => n + 1)(s)` changes one, and `pipe(s, a.modify(...), b.modify(...))` makes several changes. An optic that does not match leaves the state as it is, which keeps `evolve` total. The example bank's `Account` and the issue board's `IssueList` view use them.
- **A compensation never refuses.** A command that undoes another process's step (`RefundTransfer`) records a fact for every state (`TransferRefunded`, or `RefundStranded` when the account closed), so the saga that sent it has no refusal to handle.

More: [Aggregate: Focus on a state with optics](https://alchemy.run/domain/aggregate#focus-on-a-state-with-optics), [Aggregate: Never refuse a compensation](https://alchemy.run/domain/aggregate#never-refuse-a-compensation).

## Decision

A command that involves several aggregate instances names each in its input. A decision implements it. It reads the instances, decides against all their states, and records events on them; all commit, or none.

```ts
// Customer/RegisterCustomer.command.ts
export class RegisterCustomer extends Domain.Command("RegisterCustomer", {
  input: { customerId: CustomerId, name: Schema.String, username: Username },
  events: [CustomerRegistered, UsernameClaimed],
  rejects: [AlreadyRegistered, UsernameTaken],
}) {}

// Customer/UsernameClaim.aggregate.ts: only folds what decisions record on it
export class UsernameClaim extends Domain.Aggregate("UsernameClaim", {
  id: Username,
  state: Schema.Union([
    Schema.TaggedStruct("Free", {}),
    Schema.TaggedStruct("Claimed", { customerId: CustomerId }),
  ]),
  initial: { _tag: "Free" },
  events: [UsernameClaimed],              // no `commands`, no `decide`
  evolve: { UsernameClaimed: (_, e) => ({ _tag: "Claimed" as const, customerId: e.customerId }) },
}) {}

// Customer/Registration.decision.ts
export class Registration extends Domain.Decision(RegisterCustomer, {
  reads: { customer: Customer, claim: UsernameClaim },
  keyOf: (cmd) => ({ customer: cmd.customerId, claim: cmd.username }),
  decide: ({ customer, claim }, cmd) =>
    customer.state._tag === "Registered"
      ? new AlreadyRegistered()
      : claim.state._tag === "Claimed"
        ? new UsernameTaken()
        : [
            customer.record(new CustomerRegistered({ name: cmd.name, username: cmd.username })),
            claim.record(new UsernameClaimed({ customerId: customer.id })),
          ],
}) {}

const registration = yield* Registration;
yield* registration.send(new RegisterCustomer({ customerId, name: "Sam", username }));
```

- **`reads` is static, `keyOf` depends only on the command.** `reads` maps a key to an aggregate; `keyOf` gives each key an id, or an array of ids for several instances. Each instance arrives in `decide` under its key, with `id`, `state`, `version` and `record`. Reading an aggregate the model leaves out is a type error.
- **`record` puts an event on one instance**, which folds it with its own `evolve`. An aggregate lists such events in `events`. Views and policies see them like any other.
- **`decide` follows an aggregate's rules:** events, `[]`, or a declared rejection; pure, or an `Effect.fn` that reads only middleware context. A command with a `reply` needs the decision's `reply`, from each instance's state after the events.
- **List it in the model's `decisions`.** Every command has one implementation, an aggregate or a decision; a second is a type error.
- **The receipt has `commits`**, one `{ stream, version }` per instance read: pass one as a view's `atLeast`.
- **Send it like any command:** `bank.RegisterCustomer({ customerId, name, username })` from an Api client, `Story.when(command)` in a story.
- **State what it must keep in `transitions`:** `({ before, after, command, events }) => boolean`, with each state under its key in `reads`. Verification proves them, and that the decision keeps each aggregate's own rules.
- **Use a saga instead** when the process waits, takes time, or calls an external system.

More: [Decision](https://alchemy.run/domain/decision), [Decision: How it commits](https://alchemy.run/domain/decision#how-it-commits), [Decision: Say what it must keep](https://alchemy.run/domain/decision#say-what-it-must-keep), [Unique values](https://alchemy.run/domain/unique-values).

## Request context and middleware

```ts
// CurrentActor.context.ts: the key must be unique across every request context
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

The middleware's server half asks your auth library who is signed in, such as better-auth's `auth.getSession(headers)`. See [Sign in with better-auth](https://alchemy.run/domain/better-auth) and `examples/cloudflare-domain-better-auth`.

More: [Sessions and middleware](https://alchemy.run/domain/sessions), [Sign in with better-auth](https://alchemy.run/domain/better-auth).

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
}) {}

// judged on every get, list, and every change while watched; required when the view declares middleware or rejects
export const AccountSummaryLive = AccountSummary.toLayer(
  Effect.succeed(
    Effect.fn(function* (_request, summary) {
      yield* mustOwn(summary?.customerId ?? null);
    }),
  ),
);
```

Merge `AccountSummaryLive` into the model's handlers: `Bank.layer(handlers)` is a type error until every guarded view and stream has its Layer. The Layer's construction may resolve services; `validate` itself may only read what the middleware provides.

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

A view keyed by a different aggregate than its source uses `keyOf`, returning `undefined` to skip. A view about something with no aggregate of its own (an org) takes a string Schema as `key` (`key: OrgId`); its `keyOf` returns the value, and reads take the value (`watch(orgId)`). Policies, projections and streams take a Schema `key` the same way (`Domain.Key.Any` is either). Don't declare an empty aggregate only to key something. Add derived fields with `computed: { total: (v) => ... }`.

When you change what a deployed view computes (`evolve`, `emit`, `keyOf`, `state`, the events or sources it reads), bump its `version` in the declaration (`version: 1`), and only ever increase it. The deploy recomputes it from the events: in place for a view keyed by the one aggregate it reads, from the history otherwise, and rebuilds whatever reads it.

More: [View](https://alchemy.run/domain/view), [Views as security boundaries](https://alchemy.run/domain/view-security), [Change a view: bump its version](https://alchemy.run/domain/model#change-a-view-bump-its-version).

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
        .send(new OpenAccount({ accountId: mainAccountId(source.id), customerId: source.id, owner: event.name }))
        .pipe(Effect.catchTag("AlreadyOpen", () => Effect.void));   // handle every rejection
    });
  }),
);
```

The handler receives `{ key, source, event, envelope, state }` (`state` for a view source). It must handle every rejection. A policy has no session, so it provides context itself: `.pipe(Effect.provideService(CurrentActor, system("FraudReview")))`. To send a command later, durably, use `transfers.schedule(new ExpireTransfer({ transferId: ref.id }), { after: "24 hours" })`. Only commands that never reject can be scheduled. `schedule` returns a `ScheduleReceipt` (`{ commandId, at }`). To cancel one that no longer applies, call `transfers.unschedule(ref, commandId)` with a known `commandId` or the receipt's. Scheduling again under the same `commandId` replaces that command, pending or already run, so a deadline can be armed again; a policy that runs again for the same event arms nothing new. `unschedule` fails with `AlreadyExecuted` (it ran), `AlreadyCancelled` (cancelled before) or `NotScheduled` (never scheduled). A policy catches the ones it expects with `Effect.catchTag([...], ...)`, since a redelivery finds its expiry already cancelled. A policy cancels after the event is recorded, so the command can still fire first: keep the guard in `decide`.

More: [Policy](https://alchemy.run/domain/policy).

## Saga

```ts
// Transfer/ExecuteTransfer.saga.ts
export const Approval = DurableDeferred.make("approval", { success: Schema.Literals(["approved", "expired"]) });

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
      if (needsApproval && (yield* DurableDeferred.await(Approval)) === "expired") return;
      yield* Activity.make({
        name: "debit",
        error: Schema.Union([NotOpen, InsufficientFunds]),
        execute: accounts.send(new DebitTransfer({ accountId: from, transferId: key, amount, requestedBy })),
      }).pipe(
        ExecuteTransfer.withCompensation(() =>
          Activity.make({ name: "refund", execute: accounts.send(new RefundTransfer({ accountId: from, transferId: key, amount })) }),
        ),
      );
      yield* Activity.make({ name: "credit", error: DestinationClosed, execute: /* ... */ });
      yield* Activity.make({ name: "complete", execute: transfers.send(new CompleteTransfer({ transferId: key })) });
    });
  }),
);
```

Start and signal it from a policy, keyed by the aggregate:

```ts
const executions = yield* ExecuteTransfer;
yield* executions.start(source, { from, to, amount, requestedBy, needsApproval });  // returns a run handle at once
yield* executions.get(source).signal(Approval, "approved");
// run handle: executionId, status, result, signal(deferred, value), interrupt
```

Rules:
- One command per step. Commands inside a step get stable ids, so a retried step doesn't apply twice.
- Report each outcome to an aggregate (`CompleteTransfer`, `FailTransfer` in a `Workflow.addFinalizer`), so views can follow the process.
- `DurableClock.sleep` waits durably.

More: [Saga](https://alchemy.run/domain/saga).

## Rewrite

Changes events an instance has already recorded: for removing personal data, or what should never have been stored. Each handler keeps (returns the event), replaces (returns another event) or removes (returns `null`) one kind of event. `delete: true` removes the whole instance.

```ts
// Account/ForgetOwner.rewrite.ts
export class ForgetOwner extends Domain.Rewrite("ForgetOwner", {
  of: Account,
  input: { customerId: CustomerId },
  events: {
    AccountOpened: (event, { customerId }) =>
      event.customerId === customerId ? new AccountOpened({ ...event, owner: "" }) : event,
  },
}) {}

// Customer/DeleteCustomer.rewrite.ts
export class DeleteCustomer extends Domain.Rewrite("DeleteCustomer", { of: Customer, delete: true }) {}

// anywhere the aggregate's client is available
const receipt = yield* accounts.rewrite(accountId, new ForgetOwner({ customerId }));
yield* accounts.rewritten(receipt); // every view, projection and stream has caught up
```

- List it in the model's `rewrites`.
- Handlers are pure. Sequence numbers never change: a removed event leaves a gap.
- It fails with `InvariantBroken`, changing nothing, when the rewritten state breaks an invariant.
- Views fold again by themselves. Every projection a rewrite reaches needs a `rewrite` handler, or the model won't build.
- Policies and sagas are not told.
- Run several rewrites as one process in a saga: one `Activity` per rewrite, each ending with `rewritten`.

More: [Rewrite](https://alchemy.run/domain/rewrite), [Erasing personal data](https://alchemy.run/domain/erasing-personal-data).

## Sealed fields and the Vault

Seal personal data under a key kept per subject, and erase it everywhere by deleting the key: backups, archives and exported copies included.

```ts
// Customer/Address.ts
export const Address = Domain.Sealed(Schema.String);

// Customer/SetAddress.command.ts
export class AddressSet extends Domain.Event("AddressSet", { address: Address }) {}
export class SetAddress extends Domain.Command("SetAddress", {
  input: { customerId: CustomerId, address: Address },
  events: [AddressSet],
  rejects: [NotYourAddress],
}) {}

// a client: the model seals the value when the command arrives
yield* bank.SetAddress({ customerId, address: Address.plain(customerId, "1 Main St") });

// a query, policy or saga step: open it, or shred the subject's key
const vault = yield* Domain.Vault;
const address = yield* vault.open(Address, contact.address); // Option; None once shredded
yield* vault.shred(customerId);
```

- `decide`, `evolve` and views see `{ subject, box }`, never the value. In `decide`, reject a value whose `subject` is not the instance's own.
- Keep ids, unique values and anything a rule compares plain; remove those with a rewrite.
- Provide `Domain.VaultLive` where the model's Layer is built, over a `Domain.KeyStore` (where each subject's key is kept) and a `Domain.KeyWrap` (what is stored of it).
- Stores: `Domain.HostKeyStore` (the model's own host), `DomainCloudflare.D1KeyStore`, `DomainAWS.DynamoKeyStore`, `DomainGCP.FirestoreKeyStore`, `SqlKeyStore`, `Domain.MemoryKeyStore`.
- Wraps: `DomainCloudflare.SecretKeyWrap`, `DomainAWS.KmsKeyWrap`, `DomainGCP.KmsKeyWrap`, `Domain.RootKeyWrap`, `Domain.NoKeyWrap`. Any store pairs with any wrap.
- A KMS wrap calls KMS on every seal and open. `KmsKeyWrap(RootKey, { intermediateKey: { keep: "5 minutes" } })` calls it once per process instead; it puts an intermediate key in memory and drops per-subject KMS logs. Shredding is unchanged.
- A restored backup of the key store brings shredded keys back: keep its backups off or expiring.
- Stories run with a test Vault: expect values with `Domain.sealedInTest(Address, subject, value)`, shred with `Story.shred(subject)`.

More: [Sealed Value](https://alchemy.run/domain/sealed-value), [Crypto-shredding](https://alchemy.run/domain/crypto-shredding), [Choose where the keys are kept](https://alchemy.run/domain/crypto-shredding#choose-where-the-keys-are-kept), [Call KMS less often](https://alchemy.run/domain/crypto-shredding#call-kms-less-often), [Erasing personal data: Or seal it under a key you can delete](https://alchemy.run/domain/erasing-personal-data#or-seal-it-under-a-key-you-can-delete).

## Compaction

Replaces an instance's history with a roll-up of its state, so its log stops growing. The declaration says what the roll-up is. Its Layer says where the replaced events go and when an instance compacts.

```ts
// Account/BringForward.compaction.ts
export class BringForward extends Domain.Compaction("BringForward", {
  of: Account,
  rollup: (account) => [new AccountBroughtForward({ state: account })],
}) {}

// Account/BringForward.live.ts
export const BringForwardLive = BringForward.toLayer(
  Effect.gen(function* () {
    const archive = yield* Cloudflare.R2.WriteBucket(Archive);
    return Effect.fn(function* ({ stream, events }) {
      const first = events[0]!.envelope.seq;
      const last = events[events.length - 1]!.envelope.seq;
      yield* archive.put(`${stream}/${first}-${last}.json`, JSON.stringify(events)).pipe(Effect.orDie);
    });
  }).pipe(Effect.provide(Cloudflare.R2.WriteBucketBinding)),
  { after: { events: 1_000 } },
);
```

- The roll-up is ordinary events of the aggregate: `evolve` handles them, and so does every view that reads the aggregate.
- A view's roll-up handler says what the replaced events amount to (a total adds `e.state.balance`). A view key that already holds those events never folds the roll-up; only one added or rebuilt later does.
- Folding the roll-up from `initial` must give the state back, or it is refused with `CompactionLossy`.
- List it in the model's `compactions`, and its Layer in the model's handlers.
- `after: { events }` makes each instance compact by itself after its own commits. Without it, call `accounts.compact(id, BringForward)`.
- Views and projections keep what they built. A later rewrite still reaches the copies views kept.

More: [Compaction](https://alchemy.run/domain/compaction), [Compaction: Teach the views the roll-up](https://alchemy.run/domain/compaction#teach-the-views-the-roll-up).

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

Use it with `const fraud = yield* FraudCheck` in a policy or saga `toLayer`, then call `fraud.score({...})`. Declare typed errors per operation with `error:`: one schema, or a list (`error: [RefundDeclined, CardFrozen]`) when the vendor can refuse in several ways. Every call through a `toLayer` adapter is checked against the operation's schemas (args before, success or error after); a value a schema rejects dies with an `ExternalSystemSchemaError` naming the system and operation. `toLayer(build, { validate: false })` turns the check off. In a story, systems in `stub` are faked and the story answers their calls; the others run for real from a Layer you provide, and the story asserts what each call sent and returned. See [testing.md](testing.md).

More: [External System](https://alchemy.run/domain/external-system).

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

A projection given events a `Domain.Rewrite` changes returns `{ write, rewrite }` instead of the handler alone. `rewrite` gets each such event as it was (`before`) and as it is now (`after`, `undefined` when removed).

More: [Projection](https://alchemy.run/domain/projection), [Projection: Follow a rewrite](https://alchemy.run/domain/projection#follow-a-rewrite).

## Stream

```ts
// Account/AccountCard.stream.ts
export class CardChanged extends Domain.Event("CardChanged", { balance: Cents, frozen: Schema.Boolean }) {}

export class AccountCard extends Domain.Stream("AccountCard", {
  key: Account,
  entries: [CardChanged],
  middleware: [Session],
  rejects: [NotOwner],
}) {}

export const AccountCardLive = AccountCard.toLayer(
  Effect.succeed(Effect.fn(function* (_request, latest) { /* authorize on the latest entry */ })),
);
```

A projection with `writes: [AccountCard]` appends entries with `yield* cards.append(input, new CardChanged({...}))`. Clients `peek`, `watch`, `list` and read `events`.

In the writer's `rewrite` handler, `cards.rewrite(input, ...entries)` replaces what was appended for that input; with no entries it removes them.

More: [Stream](https://alchemy.run/domain/stream), [Stream: Rewrite what was appended](https://alchemy.run/domain/stream#rewrite-what-was-appended).

## Query

A question across keys, answered from a store a projection writes. Never serve such a store with a hand-written route.

```ts
// Ledger/AccountLedger.query.ts
export class AccountLedger extends Domain.Query("AccountLedger", {
  input: { account: AccountId },   // filters, sort orders and scopes are input fields
  success: LedgerRow,              // the result, or with `paged`, one entry of a page
  paged: true,                     // result { entries, cursor }; leave out for one result
  waitsFor: [Ledger],              // `atLeast` waits on these; reads outside their stores aren't covered
  middleware: [Session],
  rejects: [NotOwner],
}) {}

// One handler: it checks the caller, then reads the store scoped to what the caller may see.
export const AccountLedgerLive = AccountLedger.toLayer(
  Effect.gen(function* () {
    const store = yield* LedgerStore;           // resolved once
    const summaries = yield* AccountSummary;    // model members too
    return Effect.fn(function* ({ account }, page) {   // page: { after, take }
      const summary = yield* summaries.get(Account.ref(account)).pipe(Effect.orDie);
      yield* mustOwn(Option.getOrNull(summary)?.customerId ?? null);   // fail with a declared rejection
      return yield* store.forAccount(account, page);
    });
  }),
  { take: { default: 50, max: 200 } },   // tuning lives on the Layer: page limits
);
```

List it in the model's `queries` and its Live Layer in the handlers. The port returns `{ entries, cursor }`, with `cursor: null` on the last page; page by keyset on the store's sort key (`"<at>:<id>"`), never by offset. Scope the store query by the caller in the handler, so a page holds only rows the caller may see. Clients call it as a method: `bank.AccountLedger({ account }, { atLeast: receipt, take, after })`.

More: [Query](https://alchemy.run/domain/query).

## Api

```ts
// CustomerApi.api.ts
export class CustomerApi extends Domain.Api("CustomerApi", {
  model: Bank, // names must be part of it
  commands: ["RegisterCustomer", "DepositMoney", "WithdrawMoney"], // client methods
  views: ["AccountSummary", "Statement"],
  streams: ["AccountCard"],
  queries: ["AccountLedger"], // client methods
}) {}
// A kind left out is served whole; `[]` serves none. An aggregate's state is never served.
```

Clients call commands and queries as methods (`bank.WithdrawMoney({ accountId, amount }, { commandId, headers })`, `bank.AccountLedger({ account }, { take })`) and reads as namespaces. A view has `get(id)` and `watch(id)` for its state, and `events(id)` and `list(id, { take, after })` for what it emitted. A view also has `snapshot(id)`: its state and the cursor to pass as `events(id, { after })`. A stream has `peek`, `watch`, `events` and `list`. What an Api serves authorizes itself: a command in `decide`, a view or stream in its Layer's `validate`, a query in its handler.

Give every declaration a `{ description }` as its last argument, written for the person or agent who calls it; `toMcp` tools, `toCli` help and the `toHttpApi` OpenAPI document show it. Add your own keys by augmenting `Domain.Annotations` (`declare module "@alchemy.run/domain"`), and read them as `X.annotations`.

More: [Api](https://alchemy.run/domain/api), [Annotations](https://alchemy.run/domain/annotations).

An Api is the domain's interface for its own clients. For a public or partner API, write a separate `HttpApi` with its own response schemas that calls the Api in process; see [hosting.md](hosting.md#public-and-partner-apis). `toHttpApi`, `toMcp` and `toCli` publish only the calls their `expose` option lists, as the domain shapes them, which is convenient for internal tools only; see [hosting.md](hosting.md#conveniences-for-internal-tools).

## Model

```ts
// Bank.model.ts
export class Bank extends Domain.Model("Bank", {
  aggregates: [Customer, UsernameClaim, Account, Transfer],
  decisions: [Registration],
  views: [AccountSummary, Statement, CustomerDashboard],
  policies: [MainAccountProvisioning, TransferExecution],
  projections: [Ledger, AccountCards],
  streams: [AccountCard],
  sagas: [ExecuteTransfer, EraseCustomer],
  queries: [AccountLedger],
  rewrites: [ForgetOwner, ReleaseUsername, DeleteCustomer],
}) {}

/** Every policy, saga, projection and query implementation, as one Layer. */
export const BankHandlers = Layer.mergeAll(
  MainAccountProvisioningLive, TransferExecutionLive,
  ExecuteTransferLive, LedgerLive, AccountCardsLive, AccountLedgerLive,
);
```

`Bank.layer(BankHandlers)` hosts the model on whatever platform is provided: `Domain.InMemory` or `DomainCloudflare.layerDurableObjects()`.

An AI process is not a member, and Domain knows nothing of one. A policy holds it (`yield* Assistant`), so the policy's Layer requires it. A host gives it each session, `AICloudflare.layerDurableObjects` or `AI.layerInMemory`, and is given the model its prose mentions. That prose and the model lead to each other, so the model takes its members as a thunk, `Domain.Model("Bank", () => ({ ... }))`. See the `alchemy-ai` skill's `references/domain.md`.

More: [Domain Model: Declare the model](https://alchemy.run/domain/model#declare-the-model), [Processes and Domain models](https://alchemy.run/ai/domain).
