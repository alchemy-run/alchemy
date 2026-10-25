import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { Platform, type ViewKit, type ViewStore } from "@alchemy.run/domain/Platform";
import { describe, expect, it } from "@alchemy.run/test";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

class Incremented extends Domain.Event("Incremented", { by: Schema.Number }) {}
class Increment extends Domain.Command("Increment", {
  target: Schema.String,
  input: { by: Schema.Number },
  events: [Incremented],
}) {}
class Counter extends Domain.Aggregate("Counter", {
  id: Schema.String,
  state: Schema.Struct({ total: Schema.Number }),
  initial: { total: 0 },
  commands: [Increment],
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
class CounterApi extends Domain.Api("CounterApi", Increment, Totals) {}

// The platform the model is hosted on, keeping the view's kit and store for the push test.
class Captured extends Context.Service<Captured, { kit?: ViewKit; store?: ViewStore }>()(
  "Test/Captured",
) {}
const Capturing = Layer.unwrap(
  Effect.sync(() => {
    const captured: { kit?: ViewKit; store?: ViewStore } = {};
    const platform = Layer.effect(
      Platform,
      Effect.gen(function* () {
        const inner = yield* Platform;
        return Platform.of({
          ...inner,
          view: (view, kit) =>
            inner.view(view, kit).pipe(
              Effect.tap((store) =>
                Effect.sync(() => {
                  captured.kit = kit;
                  captured.store = store;
                }),
              ),
            ),
        });
      }),
    ).pipe(Layer.provide(InMemory));
    return Layer.merge(platform, Layer.succeed(Captured, captured));
  }),
);

const Hosted = Counters.layer(Layer.empty).pipe(Layer.provideMerge(Capturing));
const InProcess = Layer.effect(CounterApi.Client, CounterApi.testClient).pipe(
  Layer.provideMerge(Hosted),
);
const Wire = CounterApi.layerClient.pipe(
  Layer.provide(Domain.protocolHttp("")),
  Layer.provideMerge(
    Layer.unwrap(Effect.map(CounterApi, (api) => HttpServer.serve()(api.fetch))).pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
    ),
  ),
  Layer.provideMerge(Hosted),
);

/** Three increments of c-1, folded by the view. */
const seed = Effect.gen(function* () {
  const api = yield* CounterApi.Client;
  for (const by of [1, 2, 3]) yield* api.Increment({ target: "c-1", by });
  const last = yield* api.Increment({ target: "c-2", by: 0 });
  yield* api.Totals.get("c-1", { atLeast: { stream: "Counter/c-1", version: 3 } });
  yield* api.Totals.get("c-2", { atLeast: last });
  return api;
});

/** What a feed shows: entries by seq, and each CaughtUp by its cursor. */
const frames = (
  items: ReadonlyArray<{ readonly envelope: { readonly seq: number } } | Domain.View.CaughtUp>,
) =>
  items.map((item) =>
    Domain.View.isCaughtUp(item) ? `caught up at ${item.cursor}` : item.envelope.seq,
  );

const caughtUpFeed = Effect.gen(function* () {
  const api = yield* seed;
  const feed = yield* api.Totals.events("c-1", { caughtUp: true }).pipe(
    Stream.take(5),
    Stream.runCollect,
    Effect.forkChild,
  );
  yield* Effect.sleep("30 millis");
  yield* api.Increment({ target: "c-1", by: 4 });
  yield* api.Totals.get("c-1", { atLeast: { stream: "Counter/c-1", version: 4 } });
  const resumed = yield* api.Totals.events("c-1", { after: "2", caughtUp: true }).pipe(
    Stream.take(3),
    Stream.runCollect,
  );
  const empty = yield* api.Totals.events("c-0", { caughtUp: true }).pipe(
    Stream.take(1),
    Stream.runCollect,
  );
  return { live: frames(yield* Fiber.join(feed)), resumed: frames(resumed), empty: frames(empty) };
});

describe("Domain live reads", () => {
  it.live("events with caughtUp marks the end of the backlog", () =>
    Effect.gen(function* () {
      const { live, resumed, empty } = yield* caughtUpFeed;
      expect(live).toEqual([1, 2, 3, "caught up at 3", 4]);
      // Resuming after a cursor: the rest of the backlog, nothing twice, no gap.
      expect(resumed).toEqual([3, 4, "caught up at 4"]);
      expect(empty).toEqual(["caught up at 0"]);
    }).pipe(Effect.provide(InProcess)),
  );

  it.live("caughtUp lands after the backlog even when a filter drops its last entries", () =>
    Effect.gen(function* () {
      const api = yield* seed;
      const feed = yield* api.Totals.events("c-1", {
        caughtUp: true,
        where: { by: { lt: 3 } },
      }).pipe(Stream.take(3), Stream.runCollect);
      expect(frames(feed)).toEqual([1, 2, "caught up at 3"]);
    }).pipe(Effect.provide(InProcess)),
  );

  it.live("events without caughtUp is unchanged", () =>
    Effect.gen(function* () {
      const api = yield* seed;
      const feed = yield* api.Totals.events("c-1").pipe(Stream.take(3), Stream.runCollect);
      expect(feed.map((entry) => entry.envelope.seq)).toEqual([1, 2, 3]);
    }).pipe(Effect.provide(InProcess)),
  );

  it.live("watch with withCursor gives each state with its cursor", () =>
    Effect.gen(function* () {
      const api = yield* seed;
      const watched = yield* api.Totals.watch("c-1", { withCursor: true }).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.sleep("30 millis");
      yield* api.Increment({ target: "c-1", by: 4 });
      const [first, second] = yield* Fiber.join(watched);
      expect(first).toEqual({ state: { total: 6 }, cursor: "3" });
      expect(second).toEqual({ state: { total: 10 }, cursor: "4" });
      // The cursor resumes a feed with nothing missed and nothing twice.
      const after = yield* api.Totals.events("c-1", { after: first!.cursor }).pipe(
        Stream.take(1),
        Stream.runCollect,
      );
      expect(after.map((entry) => entry.envelope.seq)).toEqual([4]);
    }).pipe(Effect.provide(InProcess)),
  );

  it.live("both work over the wire", () =>
    Effect.gen(function* () {
      const { live, resumed, empty } = yield* caughtUpFeed;
      expect(live).toEqual([1, 2, 3, "caught up at 3", 4]);
      expect(resumed).toEqual([3, 4, "caught up at 4"]);
      expect(empty).toEqual(["caught up at 0"]);
      const api = yield* CounterApi.Client;
      const [state] = yield* api.Totals.watch("c-1", { withCursor: true }).pipe(
        Stream.take(1),
        Stream.runCollect,
      );
      expect(state).toEqual({ state: { total: 10 }, cursor: "4" });
    }).pipe(Effect.scoped, Effect.provide(Wire)),
  );

  // What a platform that pushes over WebSockets sends: the kit's `push`, on connect and on commit.
  it.live("a pushed events read sends caughtUp once, after the backlog it starts with", () =>
    Effect.gen(function* () {
      yield* seed;
      const { kit, store } = yield* Captured;
      if (!kit || !store) return expect.fail("the view's kit was not captured");
      const subscription = {
        requestId: 1,
        mode: "events" as const,
        context: {},
        cursor: 1,
        caughtUp: true,
      };
      // On connect: everything after the cursor, then CaughtUp.
      const connected = yield* kit.push(
        "c-1",
        subscription,
        yield* store.read("c-1"),
        yield* store.list("c-1"),
      );
      const values = (message: unknown) =>
        (message as { readonly values: ReadonlyArray<unknown> }).values;
      expect(connected.messages).toHaveLength(1);
      expect(
        values(connected.messages[0]).map(
          (v) =>
            (v as { _tag?: string; envelope?: { seq: number } })._tag ??
            (v as { envelope: { seq: number } }).envelope.seq,
        ),
      ).toEqual([2, 3, "CaughtUp"]);
      expect(values(connected.messages[0]).at(-1)).toEqual({ _tag: "CaughtUp", cursor: "3" });
      expect(connected.subscription.cursor).toBe(3);

      // A later commit pushes its entry only.
      const api = yield* CounterApi.Client;
      yield* api.Increment({ target: "c-1", by: 4 });
      yield* api.Totals.get("c-1", { atLeast: { stream: "Counter/c-1", version: 4 } });
      const next = yield* kit.push(
        "c-1",
        connected.subscription,
        yield* store.read("c-1"),
        yield* store.list("c-1"),
      );
      expect(
        values(next.messages[0]).map((v) => (v as { envelope: { seq: number } }).envelope.seq),
      ).toEqual([4]);

      // A pushed watch with withCursor carries the cursor with the state.
      const watched = yield* kit.push(
        "c-1",
        { requestId: 2, mode: "watch", context: {}, cursor: -1, withCursor: true },
        yield* store.read("c-1"),
        [],
      );
      expect(values(watched.messages[0])).toEqual([
        { _tag: "WithCursor", state: { total: 10 }, cursor: "4" },
      ]);
    }).pipe(Effect.provide(InProcess)),
  );
});
