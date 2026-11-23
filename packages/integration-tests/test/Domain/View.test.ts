import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import * as InMemoryPlatform from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

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

class Counters extends Domain.Model("Counters", { aggregates: [Counter], views: [Totals] }) {}
class CounterApi extends Domain.Api("CounterApi", {
  model: Counters,
  commands: ["Increment"],
  views: ["Totals"],
}) {}

const hostedOn = (platform: typeof InMemory) =>
  Counters.layer(Layer.empty).pipe(Layer.provide(platform));
const inProcessOver = (platform: typeof InMemory) =>
  Layer.effect(CounterApi.Client, CounterApi.clientInProcess).pipe(
    Layer.provideMerge(hostedOn(platform)),
  );
// The Api's `fetch` on a real HTTP server, and a client over the wire protocol.
const wireOver = (platform: typeof InMemory) =>
  CounterApi.layerClient.pipe(
    Layer.provide(Domain.protocolHttp("")),
    Layer.provideMerge(
      Layer.unwrap(Effect.map(CounterApi, (api) => HttpServer.serve()(api.fetch))).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
      ),
    ),
    Layer.provideMerge(hostedOn(platform)),
  );
/** A second client of the test's HTTP server. */
const overTheWire = CounterApi.clientHttp("") as unknown as typeof CounterApi.clientInProcess;
const InProcess = inProcessOver(InMemory);
const Wire = wireOver(InMemory);

/** A platform that delivers nothing to a view until `settle` runs. */
const held = () => {
  const hosted = InMemoryPlatform.make({ manual: true });
  const settle: Effect.Effect<void> = Effect.gen(function* () {
    while (true) {
      yield* hosted.control.drain;
      if (yield* hosted.control.idle) return;
      yield* Effect.sleep("1 millis");
    }
  });
  return { layer: hosted.layer, settle };
};

/**
 * Drain the platform until `fiber` answers. One drain is not enough: on a
 * busy machine the command may not have committed when the first one runs.
 */
const joinSettling = <A, E>(settle: Effect.Effect<void>, fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    while (fiber.pollUnsafe() === undefined) {
      yield* settle;
      yield* Effect.sleep("5 millis");
    }
    return yield* Fiber.join(fiber);
  });

/**
 * A command answers at the commit, before the view has it. With
 * `consistency: "strong"` it answers once the view has applied it, so a
 * read by any client after the answer includes it. A client built with
 * `Domain.DefaultConsistency` set to `"strong"` waits on every command.
 */
const answersOnceApplied = (
  settle: Effect.Effect<void>,
  another: typeof CounterApi.clientInProcess,
) =>
  Effect.gen(function* () {
    const api = yield* CounterApi.Client;
    const other = yield* another;
    const strong = yield* another.pipe(Effect.provideService(Domain.DefaultConsistency, "strong"));
    // The deploy is done: the view has its (empty) history.
    yield* settle;
    // Unless asked to wait, the command answers before the view has it.
    const eventual = yield* api.Increment({ id: "c-1", by: 2 });
    expect(eventual.version).toBe(1);
    expect(yield* other.Totals.get("c-1")).toBeNull();
    // A read can still wait for that write by its receipt.
    const read = yield* other.Totals.get("c-1", { atLeast: eventual }).pipe(Effect.forkChild);
    expect(yield* joinSettling(settle, read)).toEqual({ total: 2 });
    const sent = yield* api
      .Increment({ id: "c-1", by: 1 }, { consistency: "strong" })
      .pipe(Effect.forkChild);
    yield* Effect.sleep("100 millis");
    // Nothing is delivered until the platform drains: the command is still waiting.
    expect(sent.pollUnsafe()).toBeUndefined();
    expect((yield* joinSettling(settle, sent)).version).toBe(2);
    // Another client, with no receipt, reads it.
    expect(yield* other.Totals.get("c-1")).toEqual({ total: 3 });
    // A client that is strong by default waits with nothing passed.
    const byDefault = yield* strong.Increment({ id: "c-1", by: 4 }).pipe(Effect.forkChild);
    yield* Effect.sleep("100 millis");
    expect(byDefault.pollUnsafe()).toBeUndefined();
    expect((yield* joinSettling(settle, byDefault)).version).toBe(3);
    expect(yield* other.Totals.get("c-1")).toEqual({ total: 7 });
    // A call on it can still answer at the commit.
    const fast = yield* strong.Increment({ id: "c-1", by: 8 }, { consistency: "eventual" });
    expect(fast.version).toBe(4);
    expect(yield* other.Totals.get("c-1")).toEqual({ total: 7 });
  });

/** A command, and each read that waits for it, on a view that never applies it. */
const neverCaughtUp = (settle: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const api = yield* CounterApi.Client;
    // The deploy is done: the view has its (empty) history.
    yield* settle;
    // The command is committed, and says the view is behind.
    const command = yield* Effect.flip(
      api.Increment({ id: "c-3", by: 1 }, { commandId: "i-1", consistency: "strong" }),
    );
    // Sent again under its id, without waiting, it answers with its receipt.
    const receipt = yield* api.Increment({ id: "c-3", by: 1 }, { commandId: "i-1" });
    expect(receipt.version).toBe(1);
    const atLeast = { stream: receipt.stream, version: receipt.version };
    const reads = yield* Effect.all(
      [
        Effect.flip(api.Totals.snapshot("c-3", { atLeast })),
        Effect.flip(api.Totals.get("c-3", { atLeast })),
        Effect.flip(api.Totals.list("c-3", { atLeast })),
      ],
      { concurrency: "unbounded" },
    );
    return [command, ...reads];
  });

/**
 * A snapshot says the last fact it reflects: the source stream and seq of the
 * latest write it applied, per key, and none for a key that applied nothing.
 */
const positionOfTheLastFact = Effect.gen(function* () {
  const api = yield* CounterApi.Client;
  const reflecting = (receipt: { readonly stream: string; readonly version: number }) =>
    api.Totals.snapshot(receipt.stream.slice("Counter/".length), {
      atLeast: { stream: receipt.stream, version: receipt.version },
    });
  expect(yield* api.Totals.snapshot("p-none")).toEqual({ state: null, cursor: 0 });
  yield* api.Increment({ id: "p-1", by: 1 });
  yield* api.Increment({ id: "p-1", by: 2 });
  const third = yield* api.Increment({ id: "p-1", by: 3 });
  const other = yield* api.Increment({ id: "p-2", by: 5 });
  // After the third write, the view reflects fact 3 of Counter/p-1, whatever its cursor.
  const first = yield* reflecting(third);
  expect(first).toEqual({
    state: { total: 6 },
    cursor: 3,
    position: { stream: "Counter/p-1", seq: 3 },
  });
  // Each key reflects its own source.
  expect((yield* reflecting(other)).position).toEqual({ stream: "Counter/p-2", seq: 1 });
  // A later write moves it; reading again without a write does not.
  const fourth = yield* api.Increment({ id: "p-1", by: 4 });
  expect((yield* reflecting(fourth)).position).toEqual({ stream: "Counter/p-1", seq: 4 });
  expect((yield* api.Totals.snapshot("p-1")).position).toEqual({ stream: "Counter/p-1", seq: 4 });
  // A filter that hides the state still says where the key is.
  const hidden = yield* api.Totals.snapshot("p-1", { where: { total: { gt: 1000 } } });
  expect(hidden).toEqual({
    state: null,
    cursor: 4,
    position: { stream: "Counter/p-1", seq: 4 },
  });
});

/** A snapshot, two writes, then a feed that resumes after the snapshot's cursor. */
const snapshotThenFeed = Effect.gen(function* () {
  const api = yield* CounterApi.Client;
  const first = yield* api.Increment({ id: "c-1", by: 1 });
  const snapshot = yield* api.Totals.snapshot("c-1", {
    atLeast: { stream: first.stream, version: first.version },
  });
  // Written after the snapshot, before the feed starts.
  yield* api.Increment({ id: "c-1", by: 2 });
  const last = yield* api.Increment({ id: "c-1", by: 3 });
  const entries = yield* api.Totals.events("c-1", { after: snapshot.cursor }).pipe(
    Stream.filter(Domain.Read.isEvent),
    Stream.take(2),
    Stream.runCollect,
  );
  const now = yield* api.Totals.get("c-1", {
    atLeast: { stream: last.stream, version: last.version },
  });
  return { snapshot, entries, now };
});

describe("Domain View reads", { tags: ["unit", "local"] }, () => {
  it.live("gives the state and the cursor it is valid at", () =>
    Effect.gen(function* () {
      const api = yield* CounterApi.Client;
      expect(yield* api.Totals.snapshot("c-0")).toEqual({ state: null, cursor: 0 });
      const receipt = yield* api.Increment({ id: "c-1", by: 4 });
      const snapshot = yield* api.Totals.snapshot("c-1", {
        atLeast: { stream: receipt.stream, version: receipt.version },
      });
      const page = yield* api.Totals.list("c-1", { order: "desc", take: 1 });
      expect(snapshot).toEqual({
        state: { total: 4 },
        cursor: 1,
        position: { stream: "Counter/c-1", seq: 1 },
      });
      expect(page.entries[0]!.envelope.seq).toBe(snapshot.cursor);
    }).pipe(Effect.provide(InProcess)),
  );

  it.live("a snapshot says which fact it reflects", () =>
    positionOfTheLastFact.pipe(Effect.provide(InProcess)),
  );

  it.live("writes between the snapshot and the feed arrive once each", () =>
    Effect.gen(function* () {
      const { snapshot, entries, now } = yield* snapshotThenFeed;
      expect(snapshot).toEqual({
        state: { total: 1 },
        cursor: 1,
        position: { stream: "Counter/c-1", seq: 1 },
      });
      expect(entries.map((entry) => entry.envelope.seq)).toEqual([2, 3]);
      // The snapshot's state plus the feed is the current state: no gap, nothing twice.
      expect(entries.at(-1)!.state).toEqual(now);
      expect(snapshot.state!.total + entries.reduce((sum, e) => sum + e.event.by, 0)).toBe(
        now!.total,
      );
    }).pipe(Effect.provide(InProcess)),
  );

  it.live("a snapshot says which fact it reflects, over the wire", () =>
    positionOfTheLastFact.pipe(Effect.scoped, Effect.provide(Wire)),
  );

  it.live("works over the wire", () =>
    Effect.gen(function* () {
      const { snapshot, entries } = yield* snapshotThenFeed;
      expect(snapshot).toEqual({
        state: { total: 1 },
        cursor: 1,
        position: { stream: "Counter/c-1", seq: 1 },
      });
      expect(entries.map((entry) => entry.envelope.seq)).toEqual([2, 3]);
    }).pipe(Effect.scoped, Effect.provide(Wire)),
  );

  it.live("list waits for a write with atLeast, like get", () =>
    Effect.gen(function* () {
      const api = yield* CounterApi.Client;
      const receipt = yield* api.Increment({ id: "c-2", by: 5 });
      const page = yield* api.Totals.list("c-2", {
        atLeast: { stream: receipt.stream, version: receipt.version },
      });
      expect(page.entries.map((entry) => entry.state)).toEqual([{ total: 5 }]);
    }).pipe(Effect.provide(InProcess)),
  );

  it.live(
    "a strong command and a read whose write is never applied fail with ConsistencyTimeout",
    () =>
      Effect.gen(function* () {
        const [inProcess, wire] = yield* Effect.all(
          [inProcessOver, wireOver].map((over) => {
            const platform = held();
            return neverCaughtUp(platform.settle).pipe(
              Effect.scoped,
              Effect.provide(over(platform.layer)),
            );
          }),
          { concurrency: "unbounded" },
        );
        for (const error of [...inProcess, ...wire]) {
          expect(error).toMatchObject({
            _tag: "ConsistencyTimeout",
            view: "Totals",
            key: "c-3",
            stream: "Counter/c-3",
            version: 1,
          });
        }
      }),
    { timeout: 60_000 },
  );

  it.live("a strong command does not wait for a view still receiving its history", () => {
    // Never drained: the deploy's backfill of the view has not finished.
    const platform = held();
    return Effect.gen(function* () {
      const api = yield* CounterApi.Client;
      const receipt = yield* api.Increment({ id: "c-9", by: 1 }, { consistency: "strong" }).pipe(
        Effect.timeoutOrElse({
          duration: "2 seconds",
          orElse: () => Effect.die(new Error("the command waited for a view being filled")),
        }),
      );
      expect(receipt.version).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(inProcessOver(platform.layer)));
  });

  it.live("a strong command answers once its views have applied it, in process", () => {
    const platform = held();
    return answersOnceApplied(platform.settle, CounterApi.clientInProcess).pipe(
      Effect.scoped,
      Effect.provide(inProcessOver(platform.layer)),
    );
  });

  it.live("a strong command answers once its views have applied it, over the wire", () => {
    const platform = held();
    return answersOnceApplied(platform.settle, overTheWire).pipe(
      Effect.scoped,
      Effect.provide(wireOver(platform.layer)),
    );
  });
});
