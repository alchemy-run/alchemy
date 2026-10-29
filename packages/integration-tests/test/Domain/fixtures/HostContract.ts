/**
 * The contract every Domain host keeps, as one suite: run it on a host with
 * `hostContract(name, layer)`. `layer` builds a fresh, empty host each time
 * it is provided.
 */
import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Activity, DurableClock, DurableDeferred, type WorkflowEngine } from "effect/workflow";

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
      for (const input of batch) yield* bumps.append(input, new Bumped({ by: input.event.by }));
    });
  }),
  { batch: { size: 3, wait: "200 millis" } },
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

// ---------------------------------------------------------------- the model

export class Contract extends Domain.Model("Contract", {
  aggregates: [Counter, Hold, Wallet],
  views: [Totals],
  policies: [Mirror],
  projections: [BumpWriter],
  streams: [Bumps],
  sagas: [Pay],
}) {}
export class ContractApi extends Domain.Api("ContractApi", Increment, Counter, Totals, Bumps) {}

export const Handlers = Layer.mergeAll(BumpWriterLive, MirrorLive, PayLive);

/** What a host gives a model. */
export type HostLayer<A = never> = Layer.Layer<
  Domain.Platform | WorkflowEngine.WorkflowEngine | A,
  unknown
>;

/** The model on `host`, with an in-process Api client. */
export const hosted = <A>(host: HostLayer<A>) =>
  Layer.effect(ContractApi.Client, ContractApi.clientInProcess).pipe(
    Layer.provideMerge(Contract.layer(Handlers)),
    Layer.provideMerge(host),
  );

/** Retry `check` until it passes, every 50ms for up to `seconds`. */
export const eventually = <A, E, R>(check: Effect.Effect<A, E, R>, seconds = 10) =>
  check.pipe(Effect.retry({ schedule: Schedule.spaced("50 millis"), times: seconds * 20 }));

type Frame = { readonly envelope: { readonly seq: number } } | Domain.Read.CaughtUp;
const frames = (items: ReadonlyArray<Frame>) =>
  items.map((item) =>
    Domain.Read.isCaughtUp(item) ? `caught up at ${item.cursor}` : item.envelope.seq,
  );

/** Register the contract suite for one host. */
export const hostContract = (name: string, host: () => HostLayer) =>
  describe(`Domain host contract: ${name}`, () => {
    const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.scoped, Effect.provide(hosted(host())));

    it.live("a send commits once and returns its receipt; a replay returns the same receipt", () =>
      provide(
        Effect.gen(function* () {
          const counters = yield* Counter;
          const first = yield* counters.send("c-1", new Increment({ by: 2 }), { commandId: "x" });
          const again = yield* counters.send("c-1", new Increment({ by: 2 }), { commandId: "x" });
          expect(again).toEqual(first);
          expect(first.version).toBe(1);
          expect(yield* counters.state("c-1")).toEqual({ total: 2 });
        }),
      ),
    );

    it.live("a replay of a rejected command id decides again", () =>
      provide(
        Effect.gen(function* () {
          const counters = yield* Counter;
          const refused = yield* Effect.flip(
            counters.send("c-1", new Withdraw({ amount: 5 }), { commandId: "w" }),
          );
          expect(refused).toEqual(new Insufficient({ total: 0 }));
          yield* counters.send("c-1", new Increment({ by: 10 }));
          const accepted = yield* counters.send("c-1", new Withdraw({ amount: 5 }), {
            commandId: "w",
          });
          expect(accepted.version).toBe(2);
          expect(yield* counters.state("c-1")).toEqual({ total: 5 });
        }),
      ),
    );

    it.live("concurrent sends with one command id commit once", () =>
      provide(
        Effect.gen(function* () {
          const counters = yield* Counter;
          const receipts = yield* Effect.all(
            Array.from({ length: 8 }, () =>
              counters.send("c-1", new Increment({ by: 1 }), { commandId: "same" }),
            ),
            { concurrency: "unbounded" },
          );
          expect(new Set(receipts.map((r) => r.version))).toEqual(new Set([1]));
          expect(yield* counters.state("c-1")).toEqual({ total: 1 });
        }),
      ),
    );

    it.live("commands to one instance run one at a time", () =>
      provide(
        Effect.gen(function* () {
          const counters = yield* Counter;
          const receipts = yield* Effect.all(
            Array.from({ length: 20 }, () => counters.send("c-1", new Increment({ by: 1 }))),
            { concurrency: "unbounded" },
          );
          expect(receipts.map((r) => r.version).sort((a, b) => a - b)).toEqual(
            Array.from({ length: 20 }, (_, i) => i + 1),
          );
          expect(yield* counters.state("c-1")).toEqual({ total: 20 });
        }),
      ),
    );

    it.live("a view catches up in order, and lists and tails its entries", () =>
      provide(
        Effect.gen(function* () {
          const api = yield* ContractApi.Client;
          for (const by of [1, 2, 3]) yield* api.Increment("c-1", { by });
          const total = yield* api.Totals.get("c-1", {
            atLeast: { stream: "Counter/c-1", version: 3 },
          });
          expect(total).toEqual({ total: 6 });
          const feed = yield* api.Totals.events("c-1").pipe(
            Stream.take(5),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Effect.sleep("50 millis");
          yield* api.Increment("c-1", { by: 4 });
          expect(frames(yield* Fiber.join(feed))).toEqual([1, 2, 3, "caught up at 3", 4]);
          const resumed = yield* api.Totals.events("c-1", { after: 2 }).pipe(
            Stream.take(3),
            Stream.runCollect,
          );
          expect(frames(resumed)).toEqual([3, 4, "caught up at 4"]);
        }),
      ),
    );

    it.live("aggregate watch and events follow new commits", () =>
      provide(
        Effect.gen(function* () {
          const api = yield* ContractApi.Client;
          yield* api.Increment("c-1", { by: 1 });
          const watched = yield* api.Counter.watch("c-1").pipe(
            Stream.take(2),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Effect.sleep("50 millis");
          yield* api.Increment("c-1", { by: 2 });
          const [first, second] = yield* Fiber.join(watched);
          expect([first!.cursor, second!.cursor]).toEqual([1, 2]);
          const events = yield* api.Counter.events("c-1").pipe(Stream.take(3), Stream.runCollect);
          expect(frames(events)).toEqual([1, 2, "caught up at 2"]);
        }),
      ),
    );

    it.live("a policy reacts to every event", () =>
      provide(
        Effect.gen(function* () {
          const counters = yield* Counter;
          for (const by of [1, 2, 3]) yield* counters.send("c-1", new Increment({ by }));
          yield* eventually(
            counters.state("mirror-c-1").pipe(
              Effect.filterOrFail(
                (s) => s.total === 6,
                () => "not yet" as const,
              ),
            ),
          );
        }),
      ),
    );

    it.live("a projection runs inputs in batches and writes its stream once per input", () =>
      provide(
        Effect.gen(function* () {
          const api = yield* ContractApi.Client;
          // `runs` is shared by every host in the process: one key per host.
          const key = `c-9-${name.replace(/\W+/g, "-")}`;
          runs.delete(`Counter/${key}`);
          const counters = yield* Counter;
          let receipt = yield* counters.send(key, new Increment({ by: 1 }));
          for (const by of [2, 3, 4]) receipt = yield* counters.send(key, new Increment({ by }));
          // Read your own write: the projection has handled the last command.
          yield* BumpWriter.caughtUp(receipt);
          const latest = yield* api.Bumps.peek(key, {
            atLeast: { stream: `Counter/${key}`, version: 4 },
          });
          expect(latest?.event).toEqual(new Bumped({ by: 4 }));
          const listed = yield* api.Bumps.list(key);
          expect(listed.entries.map((entry) => entry.event)).toEqual(
            [1, 2, 3, 4].map((by) => new Bumped({ by })),
          );
          // Four inputs, batches of up to three: fewer runs than inputs.
          expect(runs.get(`Counter/${key}`)!).toBeLessThan(4);
        }),
      ),
    );

    it.live("a scheduled command fires once when it is due, and returns its due time", () =>
      provide(
        Effect.gen(function* () {
          const holds = yield* Hold;
          const before = yield* Effect.sync(() => Date.now());
          const scheduled = yield* holds.schedule("h-1", new ExpireHold(), {
            after: "100 millis",
            commandId: "expire",
          });
          const at = DateTime.toEpochMillis(scheduled.at);
          expect(at).toBeGreaterThanOrEqual(before + 100);
          expect(at).toBeLessThan(before + 1_100);
          // Scheduled again before it is due: it replaces, and fires once.
          yield* holds.schedule("h-1", new ExpireHold(), {
            after: "150 millis",
            commandId: "expire",
          });
          yield* eventually(
            holds.state("h-1").pipe(
              Effect.filterOrFail(
                (s) => s.status === "expired",
                () => "not yet" as const,
              ),
            ),
          );
          yield* Effect.sleep("300 millis");
          expect(yield* holds.state("h-1")).toEqual({ status: "expired", expiries: 1 });
          const ran = yield* Effect.flip(holds.unschedule("h-1", "expire"));
          expect(ran).toEqual(
            new Domain.AlreadyExecuted({ aggregate: "Hold", id: "h-1", commandId: "expire" }),
          );
          const again = yield* Effect.flip(
            holds.schedule("h-1", new ExpireHold(), { after: "1 hour", commandId: "expire" }),
          );
          expect(again._tag).toBe("AlreadyExecuted");
        }),
      ),
    );

    it.live("an unscheduled command never fires; unschedule answers each case", () =>
      provide(
        Effect.gen(function* () {
          const holds = yield* Hold;
          yield* holds.schedule("h-2", new ExpireHold(), { after: "100 millis", commandId: "x" });
          yield* holds.schedule("h-3", new ExpireHold(), { after: "100 millis", commandId: "x" });
          yield* holds.unschedule("h-2", "x");
          const twice = yield* Effect.flip(holds.unschedule("h-2", "x"));
          expect(twice._tag).toBe("AlreadyCancelled");
          const never = yield* Effect.flip(holds.unschedule("h-2", "never"));
          expect(never).toEqual(
            new Domain.NotScheduled({ aggregate: "Hold", id: "h-2", commandId: "never" }),
          );
          yield* eventually(
            holds.state("h-3").pipe(
              Effect.filterOrFail(
                (s) => s.status === "expired",
                () => "not yet" as const,
              ),
            ),
          );
          yield* Effect.sleep("300 millis");
          expect((yield* holds.state("h-2")).status).toBe("none");
          // Scheduled again after a cancel: it can be cancelled again.
          yield* holds.schedule("h-2", new ExpireHold(), { after: "1 hour", commandId: "x" });
          yield* holds.unschedule("h-2", "x");
        }),
      ),
    );

    it.live("a saga runs once for one key and returns its result", () =>
      provide(
        Effect.gen(function* () {
          const pays = yield* Pay;
          const wallets = yield* Wallet;
          const input = { wallet: "w-1", amount: 30, approval: false, napMillis: 0 };
          const first = yield* pays.start("p-1", input);
          const second = yield* pays.start("p-1", input);
          expect(second.executionId).toBe(first.executionId);
          expect(yield* first.result).toEqual({ approvedBy: null });
          expect(yield* wallets.state("w-1")).toEqual({ balance: 70 });
        }),
      ),
    );

    it.live("a saga sleeps durably, waits for a signal, and undoes a step on a rejection", () =>
      provide(
        Effect.gen(function* () {
          const pays = yield* Pay;
          const wallets = yield* Wallet;
          const approved = yield* pays.start("p-2", {
            wallet: "w-2",
            amount: 20,
            approval: true,
            napMillis: 100,
          });
          yield* eventually(
            approved.status.pipe(
              Effect.filterOrFail(
                (s) => s._tag === "Running",
                () => "not yet" as const,
              ),
            ),
          );
          yield* approved.signal(Approval, "agent-7");
          expect(yield* approved.result).toEqual({ approvedBy: "agent-7" });
          expect(yield* wallets.state("w-2")).toEqual({ balance: 80 });

          const refused = yield* pays.start("p-3", {
            wallet: "w-3",
            amount: 60,
            approval: false,
            napMillis: 0,
          });
          expect(yield* Effect.flip(refused.result)).toEqual(new TooLarge());
          yield* eventually(
            wallets.state("w-3").pipe(
              Effect.filterOrFail(
                (s) => s.balance === 100,
                () => "not yet" as const,
              ),
            ),
          );
        }),
      ),
    );
  });
