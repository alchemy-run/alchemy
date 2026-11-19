# Testing

## Stories: specify the model

A story is given/when/then over the real model, in memory. Policies, sagas and projections run for real. External system calls wait until the story answers them, and a clock you control stamps commands. A story fails on any event, rejection, external call or saga defect it doesn't account for, so a passing story has accounted for every outcome.

```ts
// packages/domain/test/Bank.story.test.ts
import { it } from "@effect/vitest";
import { Story } from "@alchemy.run/domain/Story";
import * as Layer from "effect/Layer";
import { Account } from "../src/Account/Account.aggregate.ts";
import { MoneyDeposited } from "../src/Account/DepositMoney.command.ts";
import { AccountOpened } from "../src/Account/OpenAccount.command.ts";
import { InsufficientFunds } from "../src/Account/InsufficientFunds.rejection.ts";
import { MoneyWithdrawn, WithdrawMoney } from "../src/Account/WithdrawMoney.command.ts";
import { customer } from "../src/Actor.ts";
import { Bank, BankHandlers } from "../src/Bank.model.ts";
import { CurrentActor } from "../src/CurrentActor.context.ts";
import { CustomerId } from "../src/Customer/Customer.id.ts";
import { FraudCheck } from "../src/Fraud/FraudCheck.external.ts";
import { MemoryLedgerStore } from "../src/Ledger/LedgerStore.ts";
import { Payments } from "../src/Settlement/Payments.external.ts";

const story = Story.make(Bank, {
  layer: BankHandlers.pipe(Layer.provide(MemoryLedgerStore)),  // required when the model has handlers
  stub: [FraudCheck, Payments],                                 // faked: the story answers each call
});
const a1 = Account.ref("a-1");

it.effect("withdraws within the balance, and refuses beyond it", () =>
  story(
    Story.given(a1, new AccountOpened({ customerId: CustomerId.make("c-1"), owner: "sam" }),
                    new MoneyDeposited({ amount: 100, balanceAfter: 100 })),
    Story.provide(CurrentActor, customer("c-1")),        // what the command's middleware would provide
    Story.when(new WithdrawMoney({ accountId: a1.id, amount: 30 })),
    Story.then(a1, new MoneyWithdrawn({ amount: 30, balanceAfter: 70 })),
    Story.replied({ balance: 70 }),
    Story.when(new WithdrawMoney({ accountId: a1.id, amount: 100 })),
    Story.rejected(new InsufficientFunds({ balance: 70, requested: 100 })),
  ),
);
```

The steps:

- `given(ref, ...events)` records history. It reaches views, but never triggers policies.
- `when(ref, command)` sends a command, then runs every policy, saga and projection until the model settles.
- `then(ref, ...events)` asserts the next events committed on that stream, since the last `then` or `given` on it. With no events, it asserts that nothing new was committed. Every committed event needs a `then`, on every stream, including those a policy or saga writes: an event no `then` asserts fails the story at the end.
- `anyOrder(...events)` / `inOrder(...events)` group events inside a `then` when the model doesn't order them, e.g. a policy and a saga step writing one stream: `then(ref, anyOrder(a, b))`. They nest, and payloads and counts still have to match.

A story runs every order of concurrent work that can matter: when several policies or saga steps that write the same stream are ready at once, it replays once per order, and every run must pass. An ordered `then` over events from concurrent writers fails in the order it doesn't hold; use `anyOrder`. More than 256 orders fails the story: split it.
- `rejected(rejection)` asserts the last command's rejection. An unasserted rejection fails the story.
- `replied(value)` asserts the last command's reply.
- `state(ref, partial | fn)` asserts aggregate state.
- `view(View, ref, partial | fn | Story.none)` asserts view state. `emitted(View, ref, [...])` asserts a view's emitted events, and `streamed(Stream, ref, ...)` a stream's entries.
- `query(Query, input, rows | partial | fn, { take, after }?)` asks a query as the provided context: its handler runs, and the result goes through its schema. Rows are matched in order, each partially. Without an expectation, the query must be rejected, and the next step is `rejected(...)`.
- `provide(Service, value)` stands in for middleware on the commands that follow.
- `clock("2026-01-02T09:00:00Z")` moves time: commands are stamped with it, and scheduled commands and saga sleeps that are now due fire. It also takes epoch milliseconds or a `DateTime`. It only moves forward: a time before the current one fails the story, unless only `provide` steps ran before it.
- `advance("1 day")` moves the clock forward by a duration (any `Duration.Input`) instead of to a time.

The steps type-check against the last `when`: `rejected` takes only a rejection its command declares in `rejects`, and `replied` only its reply type. A `when` type-checks only after a `provide` for every service its command's middleware provides. A helper typed as plain `Step` turns these checks off until the next `when`, so let helpers infer their return type.

More: [Testing models](https://alchemy.run/domain/testing-models), [Story](https://alchemy.run/domain/story).

### External system calls

```ts
Story.call(FraudCheck.score, { accountId: a1.id }),  // a matching call is waiting (partial args)
Story.succeed(FraudCheck.score, { risk: 0.95 }),           // answers the only waiting call to score
```

When several calls are waiting, tag each one as you expect it, and answer it by tag. A tag names the earliest matching call, in the order calls were made:

```ts
Story.call("a-1", FraudCheck.score, { accountId: a1.id }),
Story.call("a-2", FraudCheck.score, { accountId: a2.id }),
Story.succeed("a-2", FraudCheck.score, { risk: 0.1 }),
Story.succeed("a-1", FraudCheck.score, { risk: 0.95 }),
```

An answer is checked against the operation's schemas like an adapter's, so a `succeed` or `fail` value the schema rejects fails the policy. Every call needs a `call` step before it's answered; each one matches a single call, earliest first. An untagged `succeed` with several calls waiting fails the story, and so does a call left unanswered at the end.

`fail` answers a waiting call with the operation's declared `error:`, to test the branch where the vendor refuses. `die` answers it with a defect, as when the transport breaks. Both find the call the way `succeed` does, untagged or by tag, and only a declared error type-checks (any one of them, when the operation lists several):

```ts
Story.call(Payments.refund, { settlementId: "st_1" }),
Story.fail(Payments.refund, new RefundDeclined({ reason: "card-closed" })),
Story.call("r-2", Payments.refund, { settlementId: "st_2" }),
Story.die("r-2", Payments.refund, new Error("socket closed")),
```

More: [Testing models: Answer outside systems](https://alchemy.run/domain/testing-models#answer-outside-systems).

### Real calls

A system left out of `stub` is called for real through its adapter Layer, which you provide to the story (its type requires it). The story records each call: a `call` step checks what it was sent and must come first, and `returned` / `failed` / `died` check how it ended, found like `succeed`. A real call no step asserts fails the story, and the story waits for real calls to finish before each step.

```ts
const story = Story.make(Bank, { layer: BankHandlers, stub: [FraudCheck] });   // Payments runs for real

story(
  Story.when(new RecordSettlement({ accountId: account.id, settlementId: "st_1", amount: 500 })),
  Story.call(Payments.refund, { settlementId: "st_1", amount: 500 }),
  Story.returned(Payments.refund, { refundId: "re_st_1" }),
).pipe(Effect.provide(StripePayments));
```

More: [Testing models: Assert real calls](https://alchemy.run/domain/testing-models#assert-real-calls).

### Every adapter, same tests

An adapter is a Layer for the system's service. Run one set of tests against each adapter (vendor, in-memory fake, no-op) so a fake never drifts from the vendor:

```ts
for (const [adapter, layer] of [["Twilio", TwilioSms], ["fake", FakeSms]] as const) {
  describe(`Sms: ${adapter}`, () => {
    it.effect("counts the segments", () =>
      Effect.gen(function* () {
        const sms = yield* Sms;
        const sent = yield* sms.send({ to: "+15550100", body: "x".repeat(200) });
        expect(sent.segments).toBe(2);
      }).pipe(Effect.provide(layer)),
    );
  });
}
```

More: [Testing models: Run the same tests against every adapter](https://alchemy.run/domain/testing-models#run-the-same-tests-against-every-adapter).

### Sagas

Test what a saga does: the events its steps record on aggregates, and how the run ended. Don't test its internal steps.

```ts
Story.then(a1, new TransferDebited({ ... }), new TransferRefunded({ ... })),   // the compensation ran
Story.saga(ExecuteTransfer, t1, { _tag: "Rejected", rejection: new DestinationClosed() }),
Story.saga(ExecuteTransfer, t1, { _tag: "Running" }),
Story.signal(ExecuteTransfer, t1, Approval, "approved"),    // complete a DurableDeferred it waits on
```

The statuses are `NotStarted`, `Running`, `Completed`, `Rejected`, `Interrupted` and `Died`. A run that dies fails the story unless a step asserts `{ _tag: "Died" }`.

More: [Saga: Test it](https://alchemy.run/domain/saga#test-it).

### The declaration

`Domain.verify(Model)` returns every definition problem that would fail the model's Layer build (missing `keyOf`, view `state` without `initial`, a policy or projection `on` an event no source emits, a stream with two writers, duplicate names). Keep one test that expects it to be empty:

```ts
it("the model is well defined", () => expect(Domain.verify(Bank)).toEqual([]));
```

More: [Domain Model: Check the declaration](https://alchemy.run/domain/model#check-the-declaration).

### What to cover

For every command, cover the happy path, each rejection, and each authorization case (owner, other customer, agent). For every policy, cover the reaction, the reaction when its command is rejected, and the reaction when an external call fails with its declared error. For every saga, cover completion, each failure with its compensation, and each wait (signal, timeout via `clock`). For every view, check its state after the events it folds. For every query, cover the rows the owner sees, each refused caller (`rejected`), rows of other callers left out, and a second page.

```ts
as(sam),
Story.query(AccountLedger, { account: a1.id }, [{ kind: "MoneyDeposited", amount: 10_000 }]),
as(alex),
Story.query(AccountLedger, { account: a1.id }),
Story.rejected(new NotOwner()),
```

More: [Testing models: Check every outcome](https://alchemy.run/domain/testing-models#check-every-outcome).

## Rules: verify the model

A story checks one example. A rule says what is always true, and `Verify` looks for any state, input or sequence of commands that breaks it. Write a rule for each thing the business says can never happen.

Rules go on the declaration. An aggregate has `invariants` (what no state may be) and `transitions` (what no command may do); a model has `invariants` (true whenever nothing is left to react) and `eventually` (true once every reaction and scheduled command has run). A model's rule is given every instance by aggregate name (`bank.Account`), every view key by view name (`bank.DailyOutflow`), and what each projection was given by projection name (`bank.Ledger`).

```ts
export class Account extends Domain.Aggregate("Account", {
  // id, state, initial, commands, decide, evolve
  invariants: {
    NeverOverdrawn: (account) => account._tag !== "Open" || account.balance >= 0,
  },
  transitions: {
    AClosedAccountStaysClosed: ({ before, after }) =>
      before._tag !== "Closed" || after._tag === "Closed",
  },
}) {}

export class Bank extends Domain.Model("Bank", {
  // aggregates, views, policies, sagas
  invariants: {
    NoTransferLeftPending: (bank) =>
      bank.Transfer.every((transfer) => transfer.state._tag !== "Pending"),
  },
  eventually: {
    EveryTransferEnds: (bank) =>
      bank.Transfer.every(
        (transfer) => transfer.state._tag === "Completed" || transfer.state._tag === "Failed",
      ),
  },
}) {}
```

One test per model verifies them, and one per aggregate is the fast check to write first. Pass the story runner so every sequence found is also run on the real model. They run under Node (vitest), not Bun; the solver and parser come with `@alchemy.run/domain`.

```ts
import * as Verify from "@alchemy.run/domain/Verify";

it.effect("an account keeps its rules", () =>
  Verify.aggregate(Account).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "the bank keeps its promises",
  () =>
    Verify.model(Bank, { apis: [CustomerApi, SupportApi], story }).pipe(
      Effect.provide(NodeServices.layer),
    ),
  120_000,
);
```

Rules of thumb:

- A failure prints the shortest sequence that breaks the rule, and a `Story` to paste in as a regression test. Fix the model, or fix the rule when the business agrees it was wrong.
- `Proved` holds for every state and input. `Checked` holds in the sequences run (2 commands deep by default, each event delivered twice, each saga step run twice, reactions reordered, schedules late, every answer an external system's schema allows). `Sampled` is 200 seeded random walks of up to 12 commands, for rules that take longer to break. Raise `depth` with `faults` off, or `walks`, when you need more.
- Keep numbers that are added or multiplied whole (`Schema.Int`, `Schema.BigInt`, money in cents). Arithmetic JavaScript rounds is reported as not read. A division is read through `Math.floor`, `Math.ceil` or `Math.trunc`.
- A `Domain.Decision` states rules about its step in `transitions`: `({ before, after, command, events })`, with each state under its name in `reads`. `Verify.model` proves them, and proves the decision keeps the rules of every aggregate it records on; `Prove.decision(Transfer, { source })` does it for one decision. Two names of the same aggregate are tried as two instances and as one. An aggregate a decision records on is verified through its model, not alone.
- A model's `relations` relate a few instances, each made with `Domain.Relation({ over: { customer: Customer, claim: UsernameClaim }, holds: ({ customer, claim }) => ... })`. `holds` is given `{ id, state }` for each name and starts with which instances it is about (`claim.state.customerId !== customer.id || ...`). `Verify.model` proves one where every command and decision that records on its aggregates keeps it, so a decision that writes both sides is what makes it provable. When a proof fails on states nothing reaches, add the relation that rules them out: relations are proved together.
- `decide`, `evolve` and rules are plain functions of their inputs: loops, `+=`, rest patterns, `Option`, `effect/Array`, `effect/Record` and `effect/Struct` helpers are read. A loop over a list from the state or a command is tried up to 2 items past what its schema asks for, so its rule is `Checked`, not `Proved`.
- Pin the rules that must stay proved with `require: { proved: ["Account.NeverOverdrawn"] }`: one that slips to `Checked` then fails the test.
- Never widen `allow` to get a pass. It names what the check may skip, and each entry is something no longer verified.
- A rule that is true but not proved needs a second invariant that rules out the state the prover started from.
- An external call listed under "called again" must be safe to repeat: give the vendor an idempotency key made from the event.

More: [Verifying a model](https://alchemy.run/domain/verifying-models).

## Api tests: the client's view

In the server package, host the model in memory with the real middleware, and drive it through the Api client. This checks authentication, `validate`, and live reads.

```ts
// packages/server/test/CustomerApi.test.ts
const Ports = Layer.mergeAll(SiftFraudCheck, StripePayments, MemoryLedgerStore);
const BankInMemory = Bank.layer(BankHandlers).pipe(Layer.provide(Layer.mergeAll(Ports, Domain.InMemory)));
const World = Layer.mergeAll(SessionLive, MfaChallengeLive).pipe(Layer.provideMerge(BankInMemory));

const asCustomer = (id: string) =>
  CustomerApi.clientInProcess.pipe(Effect.provide(sessionClient(`customer:${id}`)));

it.live("only the owner may withdraw", () =>
  Effect.gen(function* () {
    const sam = yield* asCustomer("c-1");
    const deposited = yield* sam.DepositMoney({ accountId, amount: 250 });
    // deposited: { reply: { balance: 250 }, stream: "Account/...", version: 2 }
    const alex = yield* asCustomer("c-2");
    const refused = yield* alex.WithdrawMoney({ accountId, amount: 10 }, mfa).pipe(Effect.flip);
    expect(refused._tag).toBe("NotOwner");
  }).pipe(Effect.scoped, Effect.provide(World)),
);
```

`clientInProcess` talks to the in-memory host directly. Use `Domain.protocolHttp` with a local HTTP server to cover the wire too.

More: [Testing an Api](https://alchemy.run/domain/testing-apis).

## Integration: the deployed stack

At the root, deploy `alchemy.run.ts` with `@alchemy.run/test/Bun` and drive the deployed Api over HTTP and WebSocket. Keep it to one end-to-end flow. Stories carry the behavior.

More: [Testing an Api: Test a deployment](https://alchemy.run/domain/testing-apis#test-a-deployment).

## Commands

- Domain package: `pnpm --filter @acme/domain test` (vitest).
- Monorepo type-check: `tsc -b`.
- Integration: `bun test test/integ.test.ts`, with cloud credentials.
