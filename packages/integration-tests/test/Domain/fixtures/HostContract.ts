/**
 * The contract every Domain host keeps, as one suite: run it on a host with
 * `hostContract(name, layer)`. `layer` builds a fresh, empty host each time
 * it is provided.
 */
import * as Domain from "@alchemy.run/domain";
import { Internals } from "@alchemy.run/domain/Model";
import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { WorkflowEngine } from "effect/workflow";
import {
  Insufficient,
  Increment,
  Withdraw,
  Counter,
  Totals,
  Bumped,
  Bumps,
  BumpWriter,
  runs,
  ExpireHold,
  Hold,
  Wallet,
  TooLarge,
  Approval,
  Pay,
  attempts,
  Retry,
  Contract,
  ContractApi,
  Handlers,
} from "./ContractModel.ts";

export * from "./ContractModel.ts";

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
          const feed = yield* Queue.unbounded<Frame>();
          yield* api.Totals.events("c-1").pipe(
            Stream.runForEach((frame) => Queue.offer(feed, frame)),
            Effect.forkChild,
          );
          // Commit only once the feed has caught up, so the commit is live.
          const history = [];
          for (let i = 0; i < 4; i++) history.push(yield* Queue.take(feed));
          yield* api.Increment("c-1", { by: 4 });
          history.push(yield* Queue.take(feed).pipe(Effect.timeout("10 seconds")));
          expect(frames(history)).toEqual([1, 2, 3, "caught up at 3", 4]);
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
          const watched = yield* Queue.unbounded<{ readonly cursor: number }>();
          yield* api.Counter.watch("c-1").pipe(
            Stream.runForEach((state) => Queue.offer(watched, state)),
            Effect.forkChild,
          );
          // Commit only once the watch has its first state, so the commit is live.
          const first = yield* Queue.take(watched);
          yield* api.Increment("c-1", { by: 2 });
          const second = yield* Queue.take(watched).pipe(Effect.timeout("10 seconds"));
          expect([first.cursor, second.cursor]).toEqual([1, 2]);
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
          // h-2 is due later than h-3, so a slow machine still cancels it in time.
          const h2 = yield* holds.schedule("h-2", new ExpireHold(), {
            after: "1 second",
            commandId: "x",
          });
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
          // Past h-2's due time, and then some.
          const left = DateTime.toEpochMillis(h2.at) + 500 - (yield* Effect.sync(() => Date.now()));
          yield* Effect.sleep(Math.max(0, left));
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
    it.live("a step that runs again sends the same commands", () =>
      provide(
        Effect.gen(function* () {
          const retries = yield* Retry;
          const wallets = yield* Wallet;
          // `attempts` is shared by every host in the process: one key per host.
          const key = `retry-${name.replace(/\W+/g, "-")}`;
          attempts.delete(key);
          const run = yield* retries.start(key, { wallet: "w-9" });
          yield* run.result;
          expect(attempts.get(key)).toBe(2);
          // Two attempts, one debit: the retry's command had the same id.
          expect(yield* wallets.state("w-9")).toEqual({ balance: 90 });
        }),
      ),
    );

    it.live("a projection input with nothing to append still moves its stream's checkpoints", () =>
      provide(
        Effect.gen(function* () {
          const counters = yield* Counter;
          const internals = yield* Internals;
          const bumps = internals.streams.get("Bumps")!;
          const changes = yield* bumps
            .changes("c-0")
            .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
          yield* Effect.sleep("50 millis");
          const receipt = yield* counters.send("c-0", new Increment({ by: 0 }));
          yield* BumpWriter.caughtUp(receipt);
          const [before, after] = yield* Fiber.join(changes).pipe(Effect.timeout("5 seconds"));
          expect(before!.checkpoints).toEqual({});
          expect(after).toEqual({ seq: 0, checkpoints: { "Counter/c-0": 1 }, origin: [0, 0] });
          expect(yield* bumps.read("c-0")).toEqual(after);
        }),
      ),
    );
  });
