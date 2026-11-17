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
 * A client reads right after its own command, before the view has applied
 * it: a plain read waits for the write, `atLeast: []` reads what is there,
 * and a client that sent nothing doesn't wait.
 */
const readsItsOwnWrites = (
  settle: Effect.Effect<void>,
  another: typeof CounterApi.clientInProcess,
) =>
  Effect.gen(function* () {
    const api = yield* CounterApi.Client;
    const other = yield* another;
    yield* api.Increment({ id: "c-1", by: 1 });
    yield* settle;
    expect(yield* api.Totals.get("c-1")).toEqual({ total: 1 });
    yield* api.Increment({ id: "c-1", by: 2 });
    // The view hasn't applied the second command yet.
    expect(yield* api.Totals.get("c-1", { atLeast: [] })).toEqual({ total: 1 });
    expect(yield* other.Totals.get("c-1")).toEqual({ total: 1 });
    const reads = yield* Effect.all(
      [
        api.Totals.get("c-1"),
        Effect.map(api.Totals.snapshot("c-1"), (snapshot) => snapshot.state),
        Effect.map(api.Totals.list("c-1"), (page) => page.entries.at(-1)?.state ?? null),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.forkChild);
    yield* Effect.sleep("100 millis");
    expect(reads.pollUnsafe()).toBeUndefined();
    yield* settle;
    expect(yield* Fiber.join(reads)).toEqual([{ total: 3 }, { total: 3 }, { total: 3 }]);
    // A command to another instance doesn't reach this key: nothing to wait for.
    yield* api.Increment({ id: "c-2", by: 5 });
    expect(yield* api.Totals.get("c-1")).toEqual({ total: 3 });
    const elsewhere = yield* api.Totals.get("c-2").pipe(Effect.forkChild);
    yield* settle;
    expect(yield* Fiber.join(elsewhere)).toEqual({ total: 5 });
  });

/** Each read that waits for a write, on a view that never applies it. */
const neverCaughtUp = (another: typeof CounterApi.clientInProcess) =>
  Effect.gen(function* () {
    const api = yield* CounterApi.Client;
    const other = yield* another;
    const receipt = yield* api.Increment({ id: "c-3", by: 1 });
    const atLeast = { stream: receipt.stream, version: receipt.version };
    return yield* Effect.all(
      [
        // The client's own write, and a receipt another client was handed.
        Effect.flip(api.Totals.snapshot("c-3")),
        Effect.flip(api.Totals.get("c-3")),
        Effect.flip(api.Totals.list("c-3")),
        Effect.flip(other.Totals.get("c-3", { atLeast })),
      ],
      { concurrency: "unbounded" },
    );
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
      expect(snapshot).toEqual({ state: { total: 4 }, cursor: 1 });
      expect(page.entries[0]!.envelope.seq).toBe(snapshot.cursor);
    }).pipe(Effect.provide(InProcess)),
  );

  it.live("writes between the snapshot and the feed arrive once each", () =>
    Effect.gen(function* () {
      const { snapshot, entries, now } = yield* snapshotThenFeed;
      expect(snapshot).toEqual({ state: { total: 1 }, cursor: 1 });
      expect(entries.map((entry) => entry.envelope.seq)).toEqual([2, 3]);
      // The snapshot's state plus the feed is the current state: no gap, nothing twice.
      expect(entries.at(-1)!.state).toEqual(now);
      expect(snapshot.state!.total + entries.reduce((sum, e) => sum + e.event.by, 0)).toBe(
        now!.total,
      );
    }).pipe(Effect.provide(InProcess)),
  );

  it.live("works over the wire", () =>
    Effect.gen(function* () {
      const { snapshot, entries } = yield* snapshotThenFeed;
      expect(snapshot).toEqual({ state: { total: 1 }, cursor: 1 });
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

  it.live("a read whose write is never applied fails with ConsistencyTimeout", () =>
    Effect.gen(function* () {
      const [inProcess, wire] = yield* Effect.all(
        [
          neverCaughtUp(CounterApi.clientInProcess).pipe(
            Effect.scoped,
            Effect.provide(inProcessOver(held().layer)),
          ),
          neverCaughtUp(overTheWire).pipe(Effect.scoped, Effect.provide(wireOver(held().layer))),
        ],
        { concurrency: "unbounded" },
      );
      for (const error of [...inProcess, ...wire]) {
        expect(error).toMatchObject({
          _tag: "ConsistencyTimeout",
          view: "Totals",
          key: "c-3",
          version: 1,
        });
      }
    }),
  );

  it.live("a client's reads wait for the commands it sent, in process", () => {
    const platform = held();
    return readsItsOwnWrites(platform.settle, CounterApi.clientInProcess).pipe(
      Effect.scoped,
      Effect.provide(inProcessOver(platform.layer)),
    );
  });

  it.live("a client's reads wait for the commands it sent, over the wire", () => {
    const platform = held();
    return readsItsOwnWrites(platform.settle, overTheWire).pipe(
      Effect.scoped,
      Effect.provide(wireOver(platform.layer)),
    );
  });
});
