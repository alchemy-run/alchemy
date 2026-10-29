/**
 * The model the host contract runs: counters with a view, a policy, a
 * batched projection and a stream; holds with timers; wallets with sagas.
 * No test imports, so a child process can host it too.
 */
import * as Domain from "@alchemy.run/domain";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Activity, DurableClock, DurableDeferred } from "effect/workflow";

// ---------------------------------------------------------------- counters

export class Incremented extends Domain.Event("Incremented", { by: Schema.Number }) {}
export class Withdrawn extends Domain.Event("Withdrawn", { amount: Schema.Number }) {}
export class Insufficient extends Domain.Rejection("Insufficient", { total: Schema.Number }) {}

export class Increment extends Domain.Command("Increment", {
  target: Schema.String,
  input: { by: Schema.Number },
  events: [Incremented],
}) {}
export class Withdraw extends Domain.Command("Withdraw", {
  target: Schema.String,
  input: { amount: Schema.Number },
  events: [Withdrawn],
  rejects: [Insufficient],
}) {}

export class Counter extends Domain.Aggregate("Counter", {
  id: Schema.String,
  state: Schema.Struct({ total: Schema.Number }),
  initial: { total: 0 },
  commands: [Increment, Withdraw],
  decide: {
    Increment: (_, { by }) => [new Incremented({ by })],
    Withdraw: (s, { amount }) =>
      s.total < amount ? new Insufficient({ total: s.total }) : [new Withdrawn({ amount })],
  },
  evolve: {
    Incremented: (s, e) => ({ total: s.total + e.by }),
    Withdrawn: (s, e) => ({ total: s.total - e.amount }),
  },
  read: {},
}) {}

export class Totals extends Domain.View("Totals", {
  from: [Counter],
  key: Counter,
  state: Schema.Struct({ total: Schema.Number }),
  initial: { total: 0 },
  evolve: {
    Incremented: (s, e) => ({ total: s.total + e.by }),
    Withdrawn: (s, e) => ({ total: s.total - e.amount }),
  },
}) {}

export class Bumped extends Domain.Event("Bumped", { by: Schema.Number }) {}
export class Bumps extends Domain.Stream("Bumps", { key: Counter, entries: [Bumped] }) {}
export class BumpWriter extends Domain.Projection("BumpWriter", {
  from: [Counter],
  key: Counter,
  on: [Incremented],
  writes: [Bumps],
}) {}

/** How many runs the projection handler made, by source stream. */
export const runs = new Map<string, number>();
const BumpWriterLive = BumpWriter.toLayer(
  Effect.gen(function* () {
    const bumps = yield* Bumps;
    return Effect.fn(function* (batch) {
      const stream = batch[0]!.envelope.stream;
      yield* Effect.sync(() => runs.set(stream, (runs.get(stream) ?? 0) + 1));
      for (const input of batch) {
        // An increment by 0 is handled without an entry: only the checkpoints move.
        if (input.event.by === 0) continue;
        yield* bumps.append(input, new Bumped({ by: input.event.by }));
      }
    });
  }),
  // Long enough that four quick sends land in one wait, even on a slow machine.
  { batch: { size: 3, wait: "2 seconds" } },
);

/** Copies every increment of `c-*` onto `mirror-c-*`, at least once. */
export class Mirror extends Domain.Policy("Mirror", { from: Counter, on: [Incremented] }) {}
const MirrorLive = Mirror.toLayer(
  Effect.gen(function* () {
    const counters = yield* Counter;
    return Effect.fn(function* ({ source, event }) {
      if (source.id.startsWith("mirror-")) return;
      yield* counters.send(`mirror-${source.id}`, new Increment({ by: event.by }));
    });
  }),
);

// ---------------------------------------------------------------- holds

export class HoldPlaced extends Domain.Event("HoldPlaced") {}
export class HoldExpired extends Domain.Event("HoldExpired") {}
export class PlaceHold extends Domain.Command("PlaceHold", {
  target: Schema.String,
  events: [HoldPlaced],
}) {}
export class ExpireHold extends Domain.Command("ExpireHold", {
  target: Schema.String,
  events: [HoldExpired],
}) {}
export class Hold extends Domain.Aggregate("Hold", {
  id: Schema.String,
  state: Schema.Struct({
    status: Schema.Literals(["none", "held", "expired"]),
    expiries: Schema.Number,
  }),
  initial: { status: "none", expiries: 0 },
  commands: [PlaceHold, ExpireHold],
  decide: {
    PlaceHold: () => [new HoldPlaced()],
    ExpireHold: () => [new HoldExpired()],
  },
  evolve: {
    HoldPlaced: (s) => ({ ...s, status: "held" as const }),
    HoldExpired: (s) => ({ status: "expired" as const, expiries: s.expiries + 1 }),
  },
}) {}

// ---------------------------------------------------------------- sagas

export class Debited extends Domain.Event("Debited", { amount: Schema.Number }) {}
export class Refunded extends Domain.Event("Refunded", { amount: Schema.Number }) {}
export class Debit extends Domain.Command("Debit", {
  target: Schema.String,
  input: { amount: Schema.Number },
  events: [Debited],
}) {}
export class Refund extends Domain.Command("Refund", {
  target: Schema.String,
  input: { amount: Schema.Number },
  events: [Refunded],
}) {}
export class Wallet extends Domain.Aggregate("Wallet", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Number }),
  initial: { balance: 100 },
  commands: [Debit, Refund],
  decide: {
    Debit: (_, { amount }) => [new Debited({ amount })],
    Refund: (_, { amount }) => [new Refunded({ amount })],
  },
  evolve: {
    Debited: (s, e) => ({ balance: s.balance - e.amount }),
    Refunded: (s, e) => ({ balance: s.balance + e.amount }),
  },
}) {}

export class TooLarge extends Domain.Rejection("TooLarge") {}
export const Approval = DurableDeferred.make("approval", { success: Schema.String });

/** Debit a wallet; above 50 the payment is refused after the debit, which undoes it. */
export class Pay extends Domain.Saga("Pay", {
  key: Schema.String,
  input: {
    wallet: Schema.String,
    amount: Schema.Number,
    approval: Schema.Boolean,
    napMillis: Schema.Number,
  },
  result: { approvedBy: Schema.NullOr(Schema.String) },
  rejects: [TooLarge],
}) {}
const PayLive = Pay.toLayer(
  Effect.gen(function* () {
    const wallets = yield* Wallet;
    return Effect.fn(function* ({ wallet, amount, approval, napMillis }) {
      if (napMillis > 0) yield* DurableClock.sleep({ name: "nap", duration: napMillis });
      const approvedBy = approval ? yield* DurableDeferred.await(Approval) : null;
      yield* Activity.make({
        name: "debit",
        execute: wallets.send(wallet, new Debit({ amount })).pipe(Effect.orDie),
      }).pipe(
        Pay.withCompensation(() =>
          Activity.make({
            name: "refund",
            execute: wallets.send(wallet, new Refund({ amount })).pipe(Effect.orDie),
          }),
        ),
      );
      if (amount > 50) return yield* new TooLarge();
      return { approvedBy };
    });
  }),
);

/** Attempts of the `debit` step of `Retry`, by run key. */
export const attempts = new Map<string, number>();

/** Debit a wallet in a step that fails after its command on the first attempt, then retries. */
export class Retry extends Domain.Saga("Retry", {
  key: Schema.String,
  input: { wallet: Schema.String },
  result: {},
}) {}
const RetryLive = Retry.toLayer(
  Effect.gen(function* () {
    const wallets = yield* Wallet;
    return Effect.fn(function* ({ key, wallet }) {
      yield* Activity.make({
        name: "debit",
        error: Schema.String,
        execute: Effect.gen(function* () {
          yield* wallets.send(wallet, new Debit({ amount: 10 })).pipe(Effect.orDie);
          const attempt = (attempts.get(key) ?? 0) + 1;
          attempts.set(key, attempt);
          if (attempt === 1) return yield* Effect.fail("after the debit");
        }),
      }).pipe(Activity.retry({ times: 1 }), Effect.orDie);
      return {};
    });
  }),
);

/** Set by a process a test kills: `Hang`'s step then stops after its command. */
export const hang = { value: false };

/** Debit a wallet in a step; in a process that hangs, the step never ends after its command. */
export class Hang extends Domain.Saga("Hang", {
  key: Schema.String,
  input: { wallet: Schema.String },
  result: {},
}) {}
const HangLive = Hang.toLayer(
  Effect.gen(function* () {
    const wallets = yield* Wallet;
    return Effect.fn(function* ({ wallet }) {
      yield* Activity.make({
        name: "debit",
        execute: Effect.gen(function* () {
          yield* wallets.send(wallet, new Debit({ amount: 10 })).pipe(Effect.orDie);
          if (hang.value) {
            yield* Console.log("debited");
            return yield* Effect.never;
          }
        }),
      });
      return {};
    });
  }),
);

// ---------------------------------------------------------------- the model

export class Contract extends Domain.Model("Contract", {
  aggregates: [Counter, Hold, Wallet],
  views: [Totals],
  policies: [Mirror],
  projections: [BumpWriter],
  streams: [Bumps],
  sagas: [Pay, Retry, Hang],
}) {}
export class ContractApi extends Domain.Api("ContractApi", Increment, Counter, Totals, Bumps) {}

export const Handlers = Layer.mergeAll(BumpWriterLive, MirrorLive, PayLive, RetryLive, HangLive);
