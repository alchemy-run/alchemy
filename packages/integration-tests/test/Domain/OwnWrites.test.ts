import * as Domain from "@alchemy.run/domain";
import * as InMemoryPlatform from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

// ---------------------------------------------------------------- a counter with a view, a stream and a watch-only view

class Incremented extends Domain.Event("Incremented", { by: Schema.Number }) {}
class Increment extends Domain.Command("Increment", {
  input: { id: Schema.String, by: Schema.Number },
  events: [Incremented],
}) {}
class Counter extends Domain.Aggregate("Counter", {
  id: Schema.String,
  state: Schema.Struct({ total: Schema.Number }),
  initial: { total: 0 },
  commands: [Increment],
  keyOf: (command) => command.id,
  decide: { Increment: (_, { by }) => [new Incremented({ by })] },
  evolve: { Incremented: (s, e) => ({ total: s.total + e.by }) },
}) {}

class Totals extends Domain.View("Totals", {
  from: [Counter],
  key: Counter,
  state: Schema.Struct({ total: Schema.Number }),
  initial: { total: 0 },
  evolve: { Incremented: (s, e) => ({ total: s.total + e.by }) },
}) {}

class NotNow extends Domain.Rejection("NotNow") {}
/** A view its Layer lets a caller watch, never `get`. */
class Ticker extends Domain.View("Ticker", {
  from: [Counter],
  key: Counter,
  state: Schema.Struct({ total: Schema.Number }),
  initial: { total: 0 },
  evolve: { Incremented: (s, e) => ({ total: s.total + e.by }) },
  rejects: [NotNow],
}) {}
const TickerLive = Ticker.toLayer(
  Effect.succeed(({ mode }) => (mode === "watch" ? Effect.void : Effect.fail(new NotNow()))),
);

class Logged extends Domain.Event("Logged", { by: Schema.Number }) {}
class Log extends Domain.Stream("Log", { key: Counter, entries: [Logged] }) {}
class LogWriter extends Domain.Projection("LogWriter", {
  from: [Counter],
  key: Counter,
  on: [Incremented],
  writes: [Log],
}) {}
const LogWriterLive = LogWriter.toLayer(
  Effect.gen(function* () {
    const log = yield* Log;
    return Effect.fn(function* (batch) {
      for (const input of batch) yield* log.append(input, new Logged({ by: input.event.by }));
    });
  }),
);

class Counters extends Domain.Model("OwnWriteCounters", {
  aggregates: [Counter],
  views: [Totals, Ticker],
  projections: [LogWriter],
  streams: [Log],
}) {}
class CounterApi extends Domain.Api("OwnWriteApi", { model: Counters }) {}

/** A platform that delivers nothing until `settle` runs, and a client over it. */
const held = () => {
  const hosted = InMemoryPlatform.make({ manual: true });
  const settle: Effect.Effect<void> = Effect.gen(function* () {
    while (true) {
      yield* hosted.control.drain;
      if (yield* hosted.control.idle) return;
      yield* Effect.sleep("1 millis");
    }
  });
  const layer = Layer.effect(CounterApi.Client, CounterApi.clientInProcess).pipe(
    Layer.provideMerge(
      Counters.layer(Layer.merge(TickerLive, LogWriterLive)).pipe(Layer.provide(hosted.layer)),
    ),
  );
  return { layer, settle };
};

/** Drain the platform until `fiber` answers. */
const joinSettling = <A, E>(settle: Effect.Effect<void>, fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    while (fiber.pollUnsafe() === undefined) {
      yield* settle;
      yield* Effect.sleep("5 millis");
    }
    return yield* Fiber.join(fiber);
  });

/** Answers within `limit`, or the test fails: a read that waits for a write never applied would hang. */
const atOnce = <A, E, R>(read: Effect.Effect<A, E, R>) =>
  read.pipe(
    Effect.timeoutOrElse({
      duration: "2 seconds",
      orElse: () => Effect.die(new Error("the read waited for a write")),
    }),
  );

describe("Domain Api client: reading its own writes", { tags: ["unit", "local"] }, () => {
  it.live("a stream's peek and watch wait for the commands the client sent", () => {
    const { layer, settle } = held();
    return Effect.gen(function* () {
      const api = yield* CounterApi.Client;
      yield* settle;
      yield* api.Increment({ id: "c-1", by: 3 });
      expect(yield* api.Log.peek("c-1", { atLeast: [] })).toBeNull();
      const reads = yield* Effect.all(
        [api.Log.peek("c-1"), api.Log.watch("c-1").pipe(Stream.take(1), Stream.runCollect)],
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* Effect.sleep("100 millis");
      expect(reads.pollUnsafe()).toBeUndefined();
      const [peeked, watched] = yield* joinSettling(settle, reads);
      expect(peeked?.event).toMatchObject({ by: 3 });
      expect(watched.map((frame) => frame.state?.event)).toMatchObject([{ by: 3 }]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.live("a watch whose wait is refused opens at once, and shows the write as it lands", () => {
    const { layer, settle } = held();
    return Effect.gen(function* () {
      const api = yield* CounterApi.Client;
      yield* settle;
      yield* api.Increment({ id: "c-1", by: 2 });
      // `Ticker` refuses every `get`, so the wait before the watch fails; the watch is let through.
      const frames = yield* api.Ticker.watch("c-1").pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.sleep("100 millis");
      yield* settle;
      expect((yield* joinSettling(settle, frames)).map((frame) => frame.state)).toEqual([
        null,
        { total: 2 },
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.live("keeps the receipts of the last 32 commands", () => {
    const { layer, settle } = held();
    return Effect.gen(function* () {
      const api = yield* CounterApi.Client;
      yield* settle;
      for (let i = 0; i <= 32; i++) yield* api.Increment({ id: `c-${i}`, by: 1 });
      // The first of 33 commands was dropped: a read of its key does not wait.
      expect(yield* atOnce(api.Totals.get("c-0"))).toBeNull();
      const last = yield* api.Totals.get("c-32").pipe(Effect.forkChild);
      yield* Effect.sleep("100 millis");
      expect(last.pollUnsafe()).toBeUndefined();
      expect(yield* joinSettling(settle, last)).toEqual({ total: 1 });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("keeps a receipt for 30 seconds", () => {
    const { layer } = held();
    return Effect.gen(function* () {
      const api = yield* CounterApi.Client;
      yield* api.Increment({ id: "c-1", by: 1 });
      yield* TestClock.adjust("29 seconds");
      const waiting = yield* api.Totals.get("c-1").pipe(Effect.forkChild);
      // Each step lets the read run: it still holds the receipt, so it keeps waiting.
      for (let i = 0; i < 20; i++) yield* TestClock.adjust("25 millis");
      expect(waiting.pollUnsafe()).toBeUndefined();
      yield* Fiber.interrupt(waiting);
      yield* TestClock.adjust("1 second");
      // Nothing was delivered: with the receipt gone, the read answers at once.
      expect(yield* api.Totals.get("c-1")).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.live("a client built with ReadOwnWrites off waits only for what atLeast names", () => {
    const { layer, settle } = held();
    return Effect.gen(function* () {
      const shared = yield* CounterApi.clientInProcess.pipe(
        Effect.provideService(Domain.ReadOwnWrites, false),
      );
      yield* settle;
      const receipt = yield* shared.Increment({ id: "c-1", by: 4 });
      expect(yield* atOnce(shared.Totals.get("c-1"))).toBeNull();
      const read = yield* shared.Totals.get("c-1", { atLeast: receipt }).pipe(Effect.forkChild);
      expect(yield* joinSettling(settle, read)).toEqual({ total: 4 });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });
});
