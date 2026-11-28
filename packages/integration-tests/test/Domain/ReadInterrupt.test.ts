import * as Domain from "@alchemy.run/domain";
import * as DurableObjects from "@alchemy.run/domain/DurableObjects";
import * as DomainHttp from "@alchemy.run/domain/Http";
import * as InMemoryPlatform from "@alchemy.run/domain/InMemory";
import { Platform } from "@alchemy.run/domain/Platform";
import { describe, expect, it } from "@alchemy.run/test";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import type * as RpcClient from "effect/rpc/RpcClient";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import { simHost } from "./sim-host.ts";

// A read with `atLeast` waits on the server: it polls the view's (or the
// stream's writers') checkpoints until the write arrives. These tests give up
// on such a read from the client and check, on the server, that the wait
// stopped: its polls end, and the read's handler is interrupted.

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

/** How each server-side read ended, by key: interrupted or not. */
const ended = new Map<string, { readonly interrupted: boolean }>();
/** The server's reads of each key's checkpoints: its polls while a read waits. */
const polls = new Map<string, number>();
const poll = (key: string) => Effect.sync(() => polls.set(key, (polls.get(key) ?? 0) + 1));

/** Records, on the server, how each read's handler ended. */
class Observed extends RpcMiddleware.Service<Observed>()("Test/ReadInterrupt/Observed") {}
const ObservedLive = Layer.succeed(Observed, (effect, { payload }) => {
  const key = (payload as { readonly key: string }).key;
  return effect.pipe(
    Effect.onExit((exit) =>
      Effect.sync(() => {
        ended.set(key, {
          interrupted: Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause),
        });
      }),
    ),
  );
});

class Totals extends Domain.View("Totals", {
  from: [Counter],
  key: Counter,
  middleware: [Observed],
  state: Schema.Struct({ total: Schema.Number }),
  initial: { total: 0 },
  evolve: { Incremented: (s, e) => ({ total: s.total + e.by }) },
}) {}

// A view no caller may read: its reads with `atLeast` wait out the refused pad.
class Hidden extends Domain.Rejection("Hidden") {}
class HiddenTotals extends Domain.View("HiddenTotals", {
  from: [Counter],
  key: Counter,
  middleware: [Observed],
  rejects: [Hidden],
  state: Schema.Struct({ total: Schema.Number }),
  initial: { total: 0 },
  evolve: { Incremented: (s, e) => ({ total: s.total + e.by }) },
}) {}

class Bumped extends Domain.Event("Bumped", { by: Schema.Number }) {}
class Bumps extends Domain.Stream("Bumps", {
  key: Counter,
  middleware: [Observed],
  entries: [Bumped],
}) {}
class BumpWriter extends Domain.Projection("BumpWriter", {
  from: [Counter],
  key: Counter,
  on: [Incremented],
  writes: [Bumps],
}) {}

class Counters extends Domain.Model("ReadInterrupt", {
  aggregates: [Counter],
  views: [Totals, HiddenTotals],
  projections: [BumpWriter],
  streams: [Bumps],
}) {}
class CounterApi extends Domain.Api("CounterApi", {
  model: Counters,
  commands: ["Increment"],
  views: ["Totals", "HiddenTotals"],
  streams: ["Bumps"],
}) {}

const allow = Effect.succeed(() => Effect.void);
const Implementations = Layer.mergeAll(
  Totals.toLayer(allow),
  Bumps.toLayer(allow),
  BumpWriter.toLayer(
    Effect.gen(function* () {
      const bumps = yield* Bumps;
      return Effect.fn(function* (batch) {
        for (const input of batch) yield* bumps.append(input, new Bumped({ by: input.event.by }));
      });
    }),
  ),
  HiddenTotals.toLayer(
    Effect.succeed(
      Effect.fn(function* () {
        return yield* new Hidden();
      }),
    ),
  ),
);

/**
 * A platform that delivers nothing until `settle` runs, so a write's view
 * never catches up and a read `atLeast` it waits the whole 10 seconds. Every
 * read of a view's snapshot and of a projection's checkpoints is counted.
 */
const held = () => {
  const hosted = InMemoryPlatform.make({ manual: true });
  const counting = Layer.effect(
    Platform,
    Effect.map(Effect.service(Platform), (platform) =>
      Platform.of({
        ...platform,
        model: (model) =>
          Effect.map(platform.model(model), (host) => ({
            ...host,
            view: (view, kit) =>
              Effect.map(host.view(view, kit), (store) => ({
                ...store,
                read: (key: string) => Effect.andThen(poll(key), store.read(key)),
              })),
            projection: (projection, kit) =>
              Effect.map(host.projection(projection, kit), (store) => ({
                ...store,
                checkpoints: (key: string, sources?: ReadonlyArray<string>) =>
                  Effect.andThen(poll(key), store.checkpoints(key, sources)),
              })),
          })),
      }),
    ),
  );
  const settle: Effect.Effect<void> = Effect.gen(function* () {
    while (true) {
      yield* hosted.control.drain;
      if (yield* hosted.control.idle) return;
      yield* Effect.sleep("1 millis");
    }
  });
  const layer = Counters.layer(Implementations).pipe(
    Layer.provide(counting),
    Layer.provideMerge(hosted.layer),
    Layer.provideMerge(ObservedLive),
  );
  return { layer, settle };
};

type Client = Effect.Success<typeof CounterApi.client>;
type Receipt = { readonly stream: string; readonly version: number };

/** The reads whose wait the client gives up on, by what they read. */
const reads: ReadonlyArray<{
  readonly name: string;
  readonly read: (api: Client, key: string, atLeast: Receipt) => Effect.Effect<unknown, unknown>;
}> = [
  { name: "view get", read: (api, key, atLeast) => api.Totals.get(key, { atLeast }) },
  { name: "view snapshot", read: (api, key, atLeast) => api.Totals.snapshot(key, { atLeast }) },
  { name: "stream peek", read: (api, key, atLeast) => api.Bumps.peek(key, { atLeast }) },
  // Refused now, the read waits for its write at most a second, then pads to it.
  { name: "refused view get", read: (api, key, atLeast) => api.HiddenTotals.get(key, { atLeast }) },
];

/**
 * Commit a write the platform never delivers, read `atLeast` it, give up
 * after 200ms, and check on the server that the read's wait stopped.
 */
const givesUp = Effect.fn(function* (
  key: string,
  settle: Effect.Effect<void>,
  read: (atLeast: Receipt) => Effect.Effect<unknown, unknown>,
) {
  yield* settle;
  const api = yield* CounterApi.Client;
  const receipt = yield* api.Increment({ id: key, by: 1 });
  const atLeast = { stream: receipt.stream, version: receipt.version };
  const before = polls.get(key) ?? 0;
  const result = yield* read(atLeast).pipe(Effect.timeout("200 millis"), Effect.flip);
  expect(result).toMatchObject({ _tag: "TimeoutError" });
  const atGiveUp = polls.get(key) ?? 0;
  // The server was waiting: it polled the key while the client did.
  expect(atGiveUp - before).toBeGreaterThan(2);
  yield* Effect.sleep("600 millis");
  // A poll may be in flight as the client gives up; none start after.
  expect((polls.get(key) ?? 0) - atGiveUp).toBeLessThanOrEqual(1);
  expect(ended.get(key)).toEqual({ interrupted: true });
});

const InProcess = (platform: ReturnType<typeof held>["layer"]) =>
  Layer.effect(CounterApi.Client, CounterApi.clientInProcess).pipe(Layer.provideMerge(platform));

/** The Api's `fetch` on a Bun server. */
const served = (platform: ReturnType<typeof held>["layer"]) =>
  Layer.unwrap(Effect.map(CounterApi, (api) => HttpServer.serve()(api.fetch))).pipe(
    Layer.provideMerge(BunHttpServer.layer({ port: 0, gracefulShutdownTimeout: "200 millis" })),
    Layer.provideMerge(platform),
  );

/** A client protocol pointed at the test's server. */
const clientOf = (protocol: (url: string) => Layer.Layer<RpcClient.Protocol, never, never>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      const port = "port" in server.address ? server.address.port : 0;
      return CounterApi.layerClient.pipe(Layer.provide(protocol(`http://127.0.0.1:${port}`)));
    }),
  );

// Not `NodeHttpServer`: under Bun's `node:http`, a client abort never closes the
// response, which is what `NodeHttpServer` interrupts the request on.
const Http = (platform: ReturnType<typeof held>["layer"]) =>
  clientOf((url) => Domain.protocolHttp(url).pipe(Layer.provide(FetchHttpClient.layer))).pipe(
    Layer.provideMerge(served(platform)),
  );

const WebSocket = (platform: ReturnType<typeof held>["layer"]) =>
  clientOf((url) =>
    Domain.protocolWebSocket(url).pipe(
      Layer.provide(Layer.mergeAll(FetchHttpClient.layer, Socket.layerWebSocketConstructorGlobal)),
    ),
  ).pipe(Layer.provideMerge(served(platform)));

for (const [transport, over] of [
  ["in process", InProcess],
  ["over HTTP", Http],
  ["over WebSockets", WebSocket],
] as const) {
  describe(`Domain reads a client gives up on, ${transport}`, { tags: ["unit", "local"] }, () => {
    for (const { name, read } of reads) {
      it.live(`a ${name} stops waiting on the server`, () => {
        const platform = held();
        const key = `${transport}/${name}`.replaceAll(" ", "-");
        return Effect.gen(function* () {
          const api = yield* CounterApi.Client;
          yield* givesUp(key, platform.settle, (atLeast) => read(api, key, atLeast));
        }).pipe(Effect.scoped, Effect.provide(over(platform.layer)));
      });
    }
  });
}

// ---------------------------------------------------------------- the published HttpApi

const CounterHttp = DomainHttp.toHttpApi(CounterApi, {
  expose: ["Totals.get", "HiddenTotals.get", "Bumps.peek"],
});

const HttpApiOver = (platform: ReturnType<typeof held>["layer"]) =>
  Layer.effect(CounterApi.Client, CounterApi.clientInProcess).pipe(
    Layer.provideMerge(
      HttpRouter.serve(HttpApiBuilder.layer(CounterHttp.api), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.provide(CounterHttp.layer), Layer.provideMerge(BunHttpServer.layerTest)),
    ),
    Layer.provideMerge(platform),
  );

describe(
  "Domain reads a client gives up on, over the published HttpApi",
  { tags: ["unit", "local"] },
  () => {
    for (const [name, path] of [
      ["view get", "Totals"],
      ["stream peek", "Bumps"],
      ["refused view get", "HiddenTotals"],
    ] as const) {
      it.live(`a ${name} stops waiting on the server`, () => {
        const platform = held();
        const key = `http-api/${name}`.replaceAll(" ", "-");
        return Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          yield* givesUp(key, platform.settle, (atLeast) =>
            client.get(
              `/${path}/${encodeURIComponent(key)}?stream=${encodeURIComponent(atLeast.stream)}&version=${atLeast.version}`,
            ),
          );
        }).pipe(Effect.scoped, Effect.provide(HttpApiOver(platform.layer)));
      });
    }
  },
);

// ---------------------------------------------------------------- on Durable Objects

/** The objects a read waits on: a view's, and the projection that writes the stream. */
const waitedOn = /\.(TotalsView|HiddenTotalsView|BumpWriterProjection)$/;
/** The calls that only look at an object: everything a read's wait calls. */
const looks = new Set(["read", "checkpoints", "after", "list", "tail"]);

/**
 * Objects in this process whose views and projection take nothing in until
 * `open`, so a read `atLeast` a write waits for it. Every call the Worker
 * makes to look at them counts as a poll of `key`.
 */
const heldObjects = (key: string) => {
  const open = Deferred.makeUnsafe<void>();
  const host = simHost(
    { rowsRead: 0 },
    {
      intercept: ({ cls, method }, run) =>
        !waitedOn.test(cls)
          ? run
          : looks.has(method)
            ? Effect.andThen(poll(key), run)
            : Effect.andThen(Deferred.await(open), run),
    },
  ).host;
  const layer = Layer.effect(CounterApi.Client, CounterApi.clientInProcess).pipe(
    Layer.provideMerge(Counters.layer(Implementations)),
    Layer.provideMerge(ObservedLive),
    Layer.provideMerge(DurableObjects.makePlatform(host)),
    Layer.provideMerge(SecureRandom.layerWebCrypto),
  );
  return { layer, open: Deferred.succeed(open, undefined) };
};

describe("Domain reads a client gives up on, on Durable Objects", { tags: ["unit"] }, () => {
  for (const { name, read } of reads) {
    it.live(`a ${name} stops polling the object it waits on`, () => {
      const key = `objects/${name}`.replaceAll(" ", "-");
      const objects = heldObjects(key);
      return Effect.gen(function* () {
        const api = yield* CounterApi.Client;
        yield* givesUp(key, Effect.void, (atLeast) => read(api, key, atLeast));
      }).pipe(Effect.ensuring(objects.open), Effect.scoped, Effect.provide(objects.layer));
    });
  }
});
