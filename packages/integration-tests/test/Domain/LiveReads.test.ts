import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import { liveFrame } from "./conformance/conformance.ts";

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

class Bumped extends Domain.Event("Bumped", { by: Schema.Number }) {}
class Bumps extends Domain.Stream("Bumps", { key: Counter, entries: [Bumped] }) {}

// A view and a stream no caller may read: `validate` refuses everyone.
class Hidden extends Domain.Rejection("Hidden") {}
class HiddenTotals extends Domain.View("HiddenTotals", {
  from: [Counter],
  key: Counter,
  rejects: [Hidden],
  state: Schema.Struct({ total: Schema.Number }),
  initial: { total: 0 },
  evolve: { Incremented: (s, e) => ({ total: s.total + e.by }) },
}) {}
class HiddenBumps extends Domain.Stream("HiddenBumps", {
  key: Counter,
  entries: [Bumped],
  rejects: [Hidden],
}) {}
const refuse = Effect.succeed(
  Effect.fn(function* () {
    return yield* new Hidden();
  }),
);

class BumpWriter extends Domain.Projection("BumpWriter", {
  from: [Counter],
  key: Counter,
  on: [Incremented],
  writes: [Bumps, HiddenBumps],
}) {}
const BumpWriterLive = BumpWriter.toLayer(
  Effect.gen(function* () {
    const bumps = yield* Bumps;
    const hidden = yield* HiddenBumps;
    return Effect.fn(function* (batch) {
      for (const input of batch) {
        yield* bumps.append(input, new Bumped({ by: input.event.by }));
        yield* hidden.append(input, new Bumped({ by: input.event.by }));
      }
    });
  }),
);

class Counters extends Domain.Model("Counters", {
  aggregates: [Counter],
  views: [Totals, HiddenTotals],
  projections: [BumpWriter],
  streams: [Bumps, HiddenBumps],
}) {}
class CounterApi extends Domain.Api("CounterApi", {
  model: Counters,
  commands: ["Increment"],
  views: ["Totals", "HiddenTotals"],
  streams: ["Bumps", "HiddenBumps"],
}) {}

const Hosted = Counters.layer(
  Layer.mergeAll(BumpWriterLive, HiddenTotals.toLayer(refuse), HiddenBumps.toLayer(refuse)),
).pipe(Layer.provideMerge(InMemory));
const InProcess = Layer.effect(CounterApi.Client, CounterApi.clientInProcess).pipe(
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

// Live reads over WebSockets to a real server, served from the process that holds the keys.
const SocketWire = Layer.unwrap(
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const port = "port" in server.address ? server.address.port : 0;
    return CounterApi.layerClient.pipe(
      Layer.provide(Domain.protocolWebSocket(`http://127.0.0.1:${port}`)),
      Layer.provide(Layer.mergeAll(FetchHttpClient.layer, Socket.layerWebSocketConstructorGlobal)),
    );
  }),
).pipe(
  Layer.provideMerge(
    Layer.unwrap(Effect.map(CounterApi, (api) => HttpServer.serve()(api.fetch))).pipe(
      // Bun's graceful stop stalls when it starts as a socket closes.
      Layer.provideMerge(BunHttpServer.layer({ port: 0, gracefulShutdownTimeout: "200 millis" })),
    ),
  ),
  Layer.provideMerge(Hosted),
);

type Client = Effect.Success<typeof CounterApi.client>;
type Frame = { readonly envelope: { readonly seq: number } } | Domain.Read.CaughtUp;

/** A key's live reads, the same for a view and a stream. */
interface LiveReads {
  readonly watch: (key: string) => Stream.Stream<{ readonly cursor: number }, unknown>;
  readonly events: (key: string, after?: number) => Stream.Stream<Frame, unknown>;
}

const readsOf = (api: Client): Record<"view" | "stream", LiveReads> => ({
  view: {
    watch: (key: string) => api.Totals.watch(key),
    events: (key: string, after?: number) => api.Totals.events(key, { after }),
  },
  stream: {
    watch: (key: string) => api.Bumps.watch(key),
    events: (key: string, after?: number) => api.Bumps.events(key, { after }),
  },
});

/** Wait until the view and the stream have caught up to `version` commits of c-1. */
const settled = (api: Client, version: number) =>
  Effect.all([
    api.Totals.get("c-1", { atLeast: { stream: "Counter/c-1", version } }),
    api.Bumps.peek("c-1", { atLeast: { stream: "Counter/c-1", version } }),
  ]);

/** Three increments of c-1, folded by the views and appended to the streams. */
const seed = Effect.gen(function* () {
  const api = yield* CounterApi.Client;
  for (const by of [1, 2, 3]) yield* api.Increment("c-1", { by });
  yield* settled(api, 3);
  // The hidden ones too, read server-side: no client may read them.
  const atLeast = { stream: "Counter/c-1", version: 3 };
  const hiddenTotals = yield* HiddenTotals;
  const hiddenBumps = yield* HiddenBumps;
  yield* hiddenTotals.get(Counter.ref("c-1"), { atLeast });
  yield* hiddenBumps.peek(Counter.ref("c-1"), { atLeast });
  return api;
});

/** What a feed shows: entries by seq, and each CaughtUp by its cursor. */
const frames = (items: ReadonlyArray<Frame>) =>
  items.map((item) =>
    Domain.Read.isCaughtUp(item) ? `caught up at ${item.cursor}` : item.envelope.seq,
  );

describe("Domain live reads over raw WebSockets", { tags: ["unit", "local"] }, () => {
  it.live("a refused live read carries nothing of the key's state", () =>
    Effect.gen(function* () {
      yield* seed;
      const server = yield* HttpServer.HttpServer;
      const port = "port" in server.address ? server.address.port : 0;
      const api = `http://127.0.0.1:${port}`;
      for (const name of ["HiddenTotals", "HiddenBumps"]) {
        for (const read of [
          { tag: `${name}.watch` },
          // A resume cursor is no shortcut past `validate`.
          { tag: `${name}.watch`, cursor: 0 },
          { tag: `${name}.events` },
          { tag: `${name}.events`, cursor: 9 },
        ]) {
          const withHistory = yield* liveFrame(api, { ...read, key: "c-1" });
          const withNone = yield* liveFrame(api, { ...read, key: "c-0" });
          expect(withHistory._tag).toBe("Exit");
          // The same refusal, and the cursor the caller sent: never the key's.
          expect(withHistory).toEqual(withNone);
        }
      }
    }).pipe(Effect.scoped, Effect.provide(SocketWire)),
  );
});

for (const [transport, layer] of [
  ["in process", InProcess],
  ["over the wire", Wire],
  ["over WebSockets", SocketWire],
] as const) {
  describe(`Domain live reads ${transport}`, { tags: ["unit", "local"] }, () => {
    for (const kind of ["view", "stream"] as const) {
      it.live(`${kind} events mark the end of their history`, () =>
        Effect.gen(function* () {
          const api = yield* seed;
          const read = readsOf(api)[kind];
          const feed = yield* read
            .events("c-1")
            .pipe(Stream.take(5), Stream.runCollect, Effect.forkChild);
          yield* Effect.sleep("30 millis");
          yield* api.Increment("c-1", { by: 4 });
          yield* settled(api, 4);
          expect(frames(yield* Fiber.join(feed))).toEqual([1, 2, 3, "caught up at 3", 4]);

          // Resuming after a cursor: the rest of the history, nothing twice, no gap.
          const resumed = yield* read.events("c-1", 2).pipe(Stream.take(3), Stream.runCollect);
          expect(frames(resumed)).toEqual([3, 4, "caught up at 4"]);

          const empty = yield* read.events("c-0").pipe(Stream.take(1), Stream.runCollect);
          expect(frames(empty)).toEqual(["caught up at 0"]);
        }).pipe(Effect.scoped, Effect.provide(layer)),
      );

      it.live(`${kind} watch gives a cursor that hands off to events`, () =>
        Effect.gen(function* () {
          const api = yield* seed;
          const read = readsOf(api)[kind];
          const watched = yield* read
            .watch("c-1")
            .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
          yield* Effect.sleep("30 millis");
          yield* api.Increment("c-1", { by: 4 });
          const [first, second] = yield* Fiber.join(watched);
          expect([first!.cursor, second!.cursor]).toEqual([3, 4]);

          // From the first state's cursor, events sends only what came after it.
          const after = yield* read
            .events("c-1", first!.cursor)
            .pipe(Stream.take(2), Stream.runCollect);
          expect(frames(after)).toEqual([4, "caught up at 4"]);
        }).pipe(Effect.scoped, Effect.provide(layer)),
      );
    }

    it.live("a filter that drops the last entries of the history still ends it", () =>
      Effect.gen(function* () {
        const api = yield* seed;
        const feed = yield* api.Totals.events("c-1", { where: { by: { lt: 3 } } }).pipe(
          Stream.take(3),
          Stream.runCollect,
        );
        expect(frames(feed)).toEqual([1, 2, "caught up at 3"]);
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );

    it.live("a refused read looks the same for a key with history and one without", () =>
      Effect.gen(function* () {
        const api = yield* seed;
        for (const key of ["c-1", "c-0"]) {
          // A version neither key has reached: the read is refused before it waits.
          const atLeast = { stream: `Counter/${key}`, version: 9 };
          const refusals = yield* Effect.all([
            api.HiddenTotals.get(key, { atLeast }).pipe(Effect.flip),
            api.HiddenTotals.snapshot(key, { atLeast }).pipe(Effect.flip),
            api.HiddenTotals.list(key, { atLeast }).pipe(Effect.flip),
            api.HiddenTotals.events(key).pipe(Stream.runHead, Effect.flip),
            api.HiddenTotals.events(key, { after: 9 }).pipe(Stream.runHead, Effect.flip),
            api.HiddenTotals.watch(key).pipe(Stream.runHead, Effect.flip),
            api.HiddenBumps.peek(key, { atLeast }).pipe(Effect.flip),
            api.HiddenBumps.list(key).pipe(Effect.flip),
            api.HiddenBumps.events(key).pipe(Stream.runHead, Effect.flip),
            api.HiddenBumps.events(key, { after: 9 }).pipe(Stream.runHead, Effect.flip),
            api.HiddenBumps.watch(key).pipe(Stream.runHead, Effect.flip),
          ]).pipe(Effect.timeout("3 seconds"));
          expect(refusals.map((refusal) => refusal._tag)).toEqual(Array(11).fill("Hidden"));
        }
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );

    it.live("watch sends the state with its cursor", () =>
      Effect.gen(function* () {
        const api = yield* seed;
        const [view] = yield* api.Totals.watch("c-1").pipe(Stream.take(1), Stream.runCollect);
        const [stream] = yield* api.Bumps.watch("c-1").pipe(Stream.take(1), Stream.runCollect);
        expect(view).toEqual({ state: { total: 6 }, cursor: 3 });
        expect(stream!.state?.event).toEqual(new Bumped({ by: 3 }));
        expect(stream!.cursor).toBe(3);
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
  });
}
