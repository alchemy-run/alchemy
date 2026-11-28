import * as Domain from "@alchemy.run/domain";
import * as DomainEffectUI from "@alchemy.run/domain/EffectUI";
import { describe, expect, it } from "@alchemy.run/test";
import { Command, Component, Query, Route, Subscription, UiSchema } from "@effect/ui";
import { Html, HtmlServer } from "@effect/ui/html";
import { layerHttp } from "@effect/ui/html/HtmlServerHttp";
import { HtmlLocator, HtmlPlay } from "@effect/ui/html/testing";
import { TestHost } from "@effect/ui/testing";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Redacted from "effect/Redacted";
import * as RpcClientError from "effect/rpc/RpcClientError";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  Client,
  Counter as CounterAggregate,
  CounterApi,
  CounterId,
  Limit,
  Session,
  Total,
  TotalLive,
  Unauthenticated,
} from "./FoldkitCounter.ts";

const Counter = DomainEffectUI.make(CounterApi);
const target = CounterId.make("one");

class Count extends Domain.Query("Count", {
  input: { counterId: CounterId },
  success: Schema.Number,
  rejects: [Limit],
}) {}
const CountLive = Count.toLayer(
  Effect.succeed(({ counterId }) =>
    counterId === "over" ? Effect.fail(new Limit({ amount: 11 })) : Effect.succeed(3),
  ),
);
class Guarded extends Domain.Query("Guarded", {
  input: { counterId: CounterId },
  success: Schema.Number,
  middleware: [Session],
}) {}
const GuardedLive = Guarded.toLayer(Effect.succeed(() => Effect.succeed(1)));
class Settled extends Domain.Query("Settled", {
  input: { counterId: CounterId },
  success: Schema.Number,
  waitsFor: [Total],
}) {}
const SettledLive = Settled.toLayer(Effect.succeed(() => Effect.succeed(1)));
/** A paged query over fixed rows; "b" repeats across the first two pages. */
class Rows extends Domain.Query("Rows", {
  input: { counterId: CounterId },
  success: Schema.String,
  paged: true,
}) {}
const rows = ["a", "b", "b", "c", "d"];
const RowsLive = Rows.toLayer(
  Effect.succeed((_, page) => {
    const from = page.after === undefined ? 0 : Number(page.after);
    const next = from + page.take;
    return Effect.succeed({
      entries: rows.slice(from, next),
      cursor: next < rows.length ? String(next) : null,
    });
  }),
  { take: { default: 2, max: 3 } },
);
class QueryModel extends Domain.Model("EffectUIQueries", {
  aggregates: [CounterAggregate],
  views: [Total],
  queries: [Count, Guarded, Settled, Rows],
}) {}
class QueryApi extends Domain.Api("EffectUIQueryApi", {
  model: QueryModel,
  commands: [],
  views: [],
  streams: [],
  queries: ["Count", "Guarded", "Settled"],
}) {}
const Queries = DomainEffectUI.make(QueryApi);
const QueryHosted = Layer.merge(
  QueryModel.layer(Layer.mergeAll(CountLive, GuardedLive, SettledLive, RowsLive, TotalLive)).pipe(
    Layer.provide(Domain.InMemory),
  ),
  Layer.succeed(Session, () => Effect.fail(Unauthenticated.make({}))),
);
const QueryClient = QueryApi.layerClientInProcess.pipe(Layer.provide(QueryHosted));
/** Commands and queries in one Api: what a command does to the query cache. */
class MixedApi extends Domain.Api("EffectUIMixedApi", {
  model: QueryModel,
  commands: ["Increment"],
  views: ["Total"],
  streams: [],
  queries: ["Count", "Settled", "Rows"],
}) {}
const Mixed = DomainEffectUI.make(MixedApi);
const MixedClient = MixedApi.layerClientInProcess.pipe(Layer.provide(QueryHosted));
/** Run against one build of `layer`, the Effect UI cache and `client`, so receipts are shared. */
const mixed = <A, E>(
  layer: Layer.Layer<any, never, typeof MixedApi.Client.Identifier>,
  effect: Effect.Effect<A, E, any>,
  client: Layer.Layer<typeof MixedApi.Client.Identifier> = MixedClient,
) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(Layer.merge(layer, Query.layer()).pipe(Layer.provide(client))),
  ) as Effect.Effect<A, E, never>;
/** Run query work against the adapter's Layer, the Effect UI cache and `client`. */
const ask = <A, E>(
  effect: Effect.Effect<A, E, any>,
  client: Layer.Layer<typeof QueryApi.Client.Identifier> = QueryClient,
) =>
  effect.pipe(
    Effect.provide(Layer.merge(Queries.layer, Query.layer()).pipe(Layer.provide(client))),
  ) as Effect.Effect<A, E, never>;

/** Run an issued Command's work against the adapter's Layer and the in-process client. */
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(Counter.layer)) as Effect.Effect<A, E, never>;

describe("Domain Effect UI", { tags: ["unit", "local"] }, () => {
  it.live("keeps reply, receipt and the caller's id on success", () =>
    Effect.gen(function* () {
      const command = Counter.Increment.make({
        input: { counterId: target, amount: 2 },
        commandId: "page:0",
      });
      const result = yield* run(command.effect);
      expect(result).toEqual({
        commandId: "page:0",
        reply: { total: 2 },
        receipt: { stream: "Counter/one", version: 1 },
        commits: [{ stream: "Counter/one", version: 1 }],
      });
      // The same id replays the same outcome.
      expect(yield* run(command.effect)).toEqual(result);
    }).pipe(Effect.provide(Client)),
  );

  it.live("fails with the declared rejection and its fields", () =>
    Effect.gen(function* () {
      const failure = yield* run(
        Counter.Increment.make({ input: { counterId: target, amount: 11 }, commandId: "page:1" })
          .effect,
      ).pipe(Effect.flip);
      expect(failure).toEqual({
        _tag: "Rejected",
        commandId: "page:1",
        rejection: new Limit({ amount: 11 }),
      });
    }).pipe(Effect.provide(Client)),
  );

  it.live("classifies a middleware refusal as Denied", () =>
    Effect.gen(function* () {
      const exit = yield* run(
        Counter.Reset.make({ input: { counterId: target }, commandId: "page:2" }).effect,
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.findErrorOption(exit.cause)).toMatchObject(
          Option.some({ _tag: "Denied", commandId: "page:2", error: { _tag: "Unauthenticated" } }),
        );
      }
    }).pipe(Effect.provide(Client)),
  );

  it.live("maps both channels at the issue site with Command.match", () =>
    Effect.gen(function* () {
      const matched = Counter.Increment.make({
        input: { counterId: target, amount: 11 },
        commandId: "page:3",
      }).pipe(
        Command.match({
          onSuccess: ({ reply }) => `total:${reply.total}`,
          onFailure: (failure) => `failed:${failure._tag}:${failure.commandId}`,
        }),
      );
      expect(yield* run(matched.effect)).toBe("failed:Rejected:page:3");
    }).pipe(Effect.provide(Client)),
  );

  it.live("keeps transport uncertainty and reads headers on each call", () =>
    Effect.gen(function* () {
      const client = yield* CounterApi.Client;
      let calls = 0;
      const sent: Array<unknown> = [];
      const uncertain = Layer.succeed(CounterApi.Client, {
        ...client,
        // The server applies the command; its reply is lost on the way back.
        Increment: (...args: Parameters<typeof client.Increment>) => {
          sent.push(args[1]?.headers);
          return client.Increment(...args).pipe(
            Effect.andThen(
              Effect.fail(
                new RpcClientError.RpcClientError({
                  reason: new RpcClientError.RpcClientDefect({
                    cause: "lost reply",
                    message: "lost reply",
                  }),
                }),
              ),
            ),
          );
        },
      });
      const headers = Layer.succeed(DomainEffectUI.CommandHeaders, {
        get: () =>
          Effect.sync(() => {
            calls += 1;
            return { "x-mfa-code": `code-${calls}` };
          }),
      });
      const command = Counter.Increment.make({
        input: { counterId: target, amount: 1 },
        commandId: "page:4",
      });
      expect(calls).toBe(0);
      const layer = Counter.layer.pipe(Layer.provide(Layer.merge(uncertain, headers)));
      for (const _ of [0, 1]) {
        const failure = yield* command.effect.pipe(
          Effect.scoped,
          Effect.provide(layer),
          Effect.flip,
        );
        expect(failure).toEqual({ _tag: "Unknown", commandId: "page:4" });
      }
      expect(calls).toBe(2);
      expect(sent).toEqual([{ "x-mfa-code": "code-1" }, { "x-mfa-code": "code-2" }]);
      expect(command.args).toEqual({
        input: { counterId: target, amount: 1 },
        commandId: "page:4",
      });
    }).pipe(Effect.provide(Client)),
  );

  it.live("reads headers provided beside the layer where the Command runs", () =>
    Effect.gen(function* () {
      const client = yield* CounterApi.Client;
      const sent: Array<unknown> = [];
      const spy = Layer.succeed(CounterApi.Client, {
        ...client,
        Increment: (...args: Parameters<typeof client.Increment>) => {
          sent.push(args[1]?.headers);
          return client.Increment(...args);
        },
      });
      const headers = Layer.succeed(DomainEffectUI.CommandHeaders, {
        get: (name) => Effect.succeed({ "x-command": name }),
      });
      yield* Counter.Increment.make({
        input: { counterId: target, amount: 1 },
        commandId: "page:sibling",
      }).effect.pipe(
        Effect.scoped,
        Effect.provide(Layer.merge(Counter.layer.pipe(Layer.provide(spy)), headers)),
      );
      expect(sent).toEqual([{ "x-command": "Increment" }]);
    }).pipe(Effect.provide(Client)),
  );

  it.live("turns a defect while reading headers into Unknown", () =>
    Effect.gen(function* () {
      const headers = Layer.succeed(DomainEffectUI.CommandHeaders, {
        get: () => Effect.die("storage unavailable"),
      });
      const failure = yield* Counter.Increment.make({
        input: { counterId: target, amount: 1 },
        commandId: "page:5",
      }).effect.pipe(
        Effect.scoped,
        Effect.provide(Counter.layer.pipe(Layer.provide(headers))),
        Effect.flip,
      );
      expect(failure).toEqual({ _tag: "Unknown", commandId: "page:5" });
    }).pipe(Effect.provide(Client)),
  );

  it.live("maps command defects to Unknown and preserves interruption", () =>
    Effect.gen(function* () {
      const client = yield* CounterApi.Client;
      const command = Counter.Increment.make({
        input: { counterId: target, amount: 1 },
        commandId: "page:die",
      });
      const dies = Layer.succeed(CounterApi.Client, {
        ...client,
        Increment: (...args: Parameters<typeof client.Increment>) =>
          client.Increment(...args).pipe(Effect.andThen(Effect.die("storage failed"))),
      });
      const died = yield* command.effect.pipe(
        Effect.scoped,
        Effect.provide(Counter.layer.pipe(Layer.provide(dies))),
        Effect.flip,
      );
      expect(died).toEqual({ _tag: "Unknown", commandId: "page:die" });
      const interrupts = Layer.succeed(CounterApi.Client, {
        ...client,
        Increment: (...args: Parameters<typeof client.Increment>) =>
          client.Increment(...args).pipe(Effect.andThen(Effect.interrupt)),
      });
      const interrupted = yield* command.effect.pipe(
        Effect.scoped,
        Effect.provide(Counter.layer.pipe(Layer.provide(interrupts))),
        Effect.exit,
      );
      expect(Exit.isFailure(interrupted) && Cause.hasInterrupts(interrupted.cause)).toBe(true);
    }).pipe(Effect.provide(Client)),
  );

  it.live("makes a fresh id for each Command sent without one", () =>
    Effect.gen(function* () {
      // Two Commands issued alike, as two hydrated instances or a history restore would issue them.
      const first = yield* run(
        Counter.Increment.make({ input: { counterId: target, amount: 1 } }).effect,
      );
      const second = yield* run(
        Counter.Increment.make({ input: { counterId: target, amount: 1 } }).effect,
      );
      expect(first.commandId).not.toBe(second.commandId);
      // Each one committed: a repeated id would have replayed the first receipt.
      expect([first.receipt.version, second.receipt.version]).toEqual([1, 2]);
      expect(second.reply).toEqual({ total: 2 });
    }).pipe(Effect.provide(Client)),
  );

  it.live("pins new ids with NewCommandId, and retries Unknown with the returned id", () =>
    Effect.gen(function* () {
      const client = yield* CounterApi.Client;
      const pinned = Layer.succeed(DomainEffectUI.NewCommandId, Effect.succeed("pinned:0"));
      const lossy = Layer.succeed(CounterApi.Client, {
        ...client,
        Increment: (...args: Parameters<typeof client.Increment>) =>
          client.Increment(...args).pipe(
            Effect.andThen(
              Effect.fail(
                new RpcClientError.RpcClientError({
                  reason: new RpcClientError.RpcClientDefect({ cause: "lost", message: "lost" }),
                }),
              ),
            ),
          ),
      });
      const input = { counterId: target, amount: 2 };
      const failure = yield* Counter.Increment.make({ input }).effect.pipe(
        Effect.scoped,
        Effect.provide(Counter.layer.pipe(Layer.provide(Layer.merge(lossy, pinned)))),
        Effect.flip,
      );
      expect(failure).toEqual({ _tag: "Unknown", commandId: "pinned:0" });
      // The retry sends the same id: Domain answers with the first receipt.
      const retried = yield* run(
        Counter.Increment.make({ input, commandId: failure.commandId }).effect,
      );
      expect(retried).toMatchObject({ commandId: "pinned:0", receipt: { version: 1 } });
    }).pipe(Effect.provide(Client)),
  );

  it.live("sends a per-call Redacted header beside CommandHeaders, hidden in the args", () =>
    Effect.gen(function* () {
      const client = yield* CounterApi.Client;
      const sent: Array<unknown> = [];
      const spy = Layer.succeed(CounterApi.Client, {
        ...client,
        Increment: (...args: Parameters<typeof client.Increment>) => {
          sent.push(args[1]?.headers);
          return client.Increment(...args);
        },
      });
      const headers = Layer.succeed(DomainEffectUI.CommandHeaders, {
        get: () => Effect.succeed({ "x-app": "web", "x-mfa-code": "stale" }),
      });
      const command = Counter.Increment.make({
        input: { counterId: target, amount: 1 },
        headers: Redacted.make({ "x-mfa-code": "123456" }),
      });
      yield* command.effect.pipe(
        Effect.scoped,
        Effect.provide(Counter.layer.pipe(Layer.provide(Layer.merge(spy, headers)))),
      );
      expect(sent).toEqual([{ "x-app": "web", "x-mfa-code": "123456" }]);
      expect(String((command.args as { headers?: unknown }).headers)).not.toContain("123456");
    }).pipe(Effect.provide(Client)),
  );

  it.live("passes consistency, and maps a late view to TimedOut only for a strong command", () =>
    Effect.gen(function* () {
      const client = yield* CounterApi.Client;
      const sent: Array<unknown> = [];
      const late = Layer.succeed(CounterApi.Client, {
        ...client,
        Increment: (...args: Parameters<typeof client.Increment>) => {
          sent.push(args[1]?.consistency);
          return client.Increment(...args).pipe(
            Effect.andThen((receipt) =>
              Effect.fail(
                new Domain.ConsistencyTimeout({
                  view: "Total",
                  key: "one",
                  stream: receipt.stream,
                  version: receipt.version,
                }),
              ),
            ),
          );
        },
      });
      const Strong = DomainEffectUI.make(CounterApi, {
        commands: { Increment: { consistency: "strong" } },
      });
      const input = { counterId: target, amount: 1 };
      const timedOut = yield* Strong.Increment.make({ input, commandId: "strong:0" }).effect.pipe(
        Effect.scoped,
        Effect.provide(Strong.layer.pipe(Layer.provide(late))),
        Effect.flip,
      );
      expect(timedOut).toEqual({
        _tag: "TimedOut",
        commandId: "strong:0",
        receipt: { stream: "Counter/one", version: 1 },
      });
      const unknown = yield* Counter.Increment.make({ input, commandId: "eventual:0" }).effect.pipe(
        Effect.scoped,
        Effect.provide(Counter.layer.pipe(Layer.provide(late))),
        Effect.flip,
      );
      expect(unknown).toEqual({ _tag: "Unknown", commandId: "eventual:0" });
      expect(sent).toEqual(["strong", undefined]);
      type StrongTags = Command.Failure<ReturnType<typeof Strong.Increment.make>>["_tag"];
      type EventualTags = Command.Failure<ReturnType<typeof Counter.Increment.make>>["_tag"];
      const strongTimesOut: "TimedOut" extends StrongTags ? true : false = true;
      const eventualTimesOut: "TimedOut" extends EventualTags ? true : false = false;
      expect([strongTimesOut, eventualTimesOut]).toEqual([true, false]);
    }).pipe(Effect.provide(Client)),
  );

  it("invalidates the queries whose waitsFor reads a command's events, by default", () => {
    const issued = Mixed.Increment.make({ input: { counterId: target, amount: 1 } });
    // Settled waits for Total, which applies Incremented. Count and Rows wait for nothing.
    expect(issued.invalidates).toEqual([Mixed.Settled]);
    expect(issued.optimistic).toEqual([]);
    expect(issued.writes).toBeUndefined();
  });

  it.live("declares invalidates, optimistic and writes per command from the Api's queries", () =>
    Effect.gen(function* () {
      const Declared = DomainEffectUI.make(MixedApi, {
        commands: {
          Increment: {
            invalidates: ({ input }, queries) => [
              queries.Count.entry({ input: { counterId: input.counterId } }),
            ],
            optimistic: ({ input }, queries) => [
              queries.Count.patch(
                { input: { counterId: input.counterId } },
                (n) => n + input.amount,
              ),
            ],
            writes: ({ reply }, { input }, queries) => [
              queries.Count.set({ input: { counterId: input.counterId } }, reply.total),
            ],
          },
        },
      });
      const args = { input: { counterId: target, amount: 2 } };
      const issued = Declared.Increment.make(args);
      expect(issued.invalidates).toEqual([Declared.Count.entry({ input: { counterId: target } })]);
      expect(
        Query.applyPatches(issued.optimistic, Declared.Count, { input: { counterId: target } }, 3),
      ).toBe(5);
      // The runtime stores what `writes` returns from the body's success.
      const success = yield* mixed(Declared.layer, issued.effect);
      expect(issued.writes?.(success)).toEqual([
        Declared.Count.set({ input: { counterId: target } }, 2),
      ]);
    }),
  );

  it.live("waits for this client's writes in queries with waitsFor, outside the cache key", () =>
    Effect.gen(function* () {
      const client = yield* MixedApi.Client;
      const sent: Array<readonly [string, unknown]> = [];
      const spy = Layer.succeed(MixedApi.Client, {
        ...client,
        Settled: (...args: Parameters<typeof client.Settled>) => {
          sent.push(["Settled", args[1]?.atLeast]);
          return client.Settled(...args);
        },
        Count: (...args: Parameters<typeof client.Count>) => {
          sent.push(["Count", args[1]?.atLeast]);
          return client.Count(...args);
        },
      } as typeof client);
      const input = { counterId: target };
      yield* mixed(
        Mixed.layer,
        Effect.gen(function* () {
          yield* Mixed.Settled.get({ input });
          yield* Mixed.Increment.make({ input: { counterId: target, amount: 1 } }).effect;
          yield* Mixed.Increment.make({ input: { counterId: target, amount: 1 } }).effect;
          // The same args, so the same entry, fetched again with this client's receipts.
          yield* Mixed.Settled.get({ input });
          yield* Mixed.Count.get({ input });
        }),
        spy,
      );
      expect(sent).toEqual([
        ["Settled", undefined],
        ["Settled", [{ stream: "Counter/one", version: 2 }]],
        ["Count", undefined],
      ]);
    }).pipe(Effect.provide(MixedClient)),
  );

  it.live("serves a paged query as an infinite query", () =>
    Effect.gen(function* () {
      const Keyed = DomainEffectUI.make(MixedApi, {
        queries: { Rows: { key: (row) => row, take: 3 } },
      });
      const input = { counterId: target };
      const [first, loaded] = yield* mixed(
        Mixed.layer,
        Effect.gen(function* () {
          const first = yield* Mixed.Rows.get({ input });
          return [first, yield* Mixed.Rows.loadMore({ input })] as const;
        }),
      );
      const keyed = yield* mixed(Keyed.layer, Keyed.Rows.get({ input }));
      expect(first).toEqual([{ entries: ["a", "b"], cursor: "2" }]);
      expect(loaded.hasMore).toBe(true);
      // Without a key every entry stays; with one, a repeat on a later page is left out.
      expect(Mixed.Rows.items(loaded.pages)).toEqual(["a", "b", "b", "c"]);
      expect(keyed).toEqual([{ entries: ["a", "b", "b"], cursor: "3" }]);
      expect(Keyed.Rows.items([...keyed, { entries: ["b", "c"], cursor: null }])).toEqual([
        "a",
        "b",
        "c",
      ]);
    }),
  );

  it("decodes a View snapshot for the first paint, falling back to None", () => {
    const encode = Schema.encodeSync(Counter.Total.SnapshotSchema);
    expect(encode({ state: Option.some({ total: 2 }), cursor: 1 })).toEqual({
      state: { total: 2 },
      cursor: 1,
    });
    expect(Counter.Total.decodeSnapshot({ state: null, cursor: 0 })).toEqual(
      Option.some({ state: Option.none(), cursor: 0 }),
    );
    expect(Counter.Total.decodeSnapshot({ state: { total: "2" }, cursor: 0 })).toEqual(
      Option.none(),
    );
    expect(Counter.Total.decodeSnapshot({ state: null, cursor: -1 })).toEqual(Option.none());
  });

  it.live("serves a query through the Effect UI cache and keeps a typed refusal", () =>
    Effect.gen(function* () {
      expect(yield* ask(Queries.Count.get({ input: { counterId: target } }))).toBe(3);
      const refused = yield* ask(
        Queries.Count.get({ input: { counterId: CounterId.make("over") } }).pipe(Effect.flip),
      );
      expect(refused).toEqual({ _tag: "Rejected", rejection: new Limit({ amount: 11 }) });
    }),
  );

  it.live("forwards a query's headers to the client", () =>
    Effect.gen(function* () {
      const client = yield* QueryApi.Client;
      const sent: Array<unknown> = [];
      const spy = Layer.succeed(QueryApi.Client, {
        ...client,
        Count: (...args: Parameters<typeof client.Count>) => {
          sent.push(args);
          return client.Count(...args);
        },
      });
      const headers = Layer.succeed(DomainEffectUI.CommandHeaders, {
        get: (name) => Effect.succeed({ "x-query": name }),
      });
      const result = yield* Queries.Count.get({ input: { counterId: target } }).pipe(
        Effect.provide(
          Layer.merge(Queries.layer.pipe(Layer.provide(Layer.merge(spy, headers))), Query.layer()),
        ),
      );
      expect(result).toBe(3);
      expect(sent).toEqual([[{ counterId: target }, { headers: { "x-query": "Count" } }]]);
    }).pipe(Effect.provide(QueryClient)),
  );

  it.live("classifies query middleware refusals, timeouts and transport loss", () =>
    Effect.gen(function* () {
      const denied = yield* ask(
        Queries.Guarded.get({ input: { counterId: target } }).pipe(Effect.flip),
      );
      expect(denied).toMatchObject({ _tag: "Denied", error: { _tag: "Unauthenticated" } });
      const client = yield* QueryApi.Client.pipe(Effect.provide(QueryClient));
      const broken = Layer.succeed(QueryApi.Client, {
        ...client,
        Settled: () =>
          Effect.fail(
            new Domain.ConsistencyTimeout({
              view: "Total",
              key: "one",
              stream: "Counter/one",
              version: 1,
            }),
          ),
        Count: () =>
          Effect.fail(
            new RpcClientError.RpcClientError({
              reason: new RpcClientError.RpcClientDefect({ cause: "lost", message: "lost" }),
            }),
          ),
        Guarded: () => Effect.die("socket closed"),
      } as typeof client);
      expect(
        yield* ask(Queries.Settled.get({ input: { counterId: target } }).pipe(Effect.flip), broken),
      ).toEqual({ _tag: "TimedOut" });
      expect(
        yield* ask(Queries.Count.get({ input: { counterId: target } }).pipe(Effect.flip), broken),
      ).toEqual({ _tag: "Unknown" });
      expect(
        yield* ask(Queries.Guarded.get({ input: { counterId: target } }).pipe(Effect.flip), broken),
      ).toEqual({ _tag: "Unknown" });
    }),
  );

  type TotalMessage =
    | {
        readonly _tag: "ReceivedTotal";
        readonly snapshot: DomainEffectUI.Snapshot<{ total: number }>;
      }
    | { readonly _tag: "FailedTotal"; readonly reason: string };
  const watched = (key: typeof CounterId.Type, restartKey?: number) =>
    Counter.Total.watch<TotalMessage>(key, {
      restartKey,
      onSnapshot: (snapshot) => ({ _tag: "ReceivedTotal" as const, snapshot }),
      onFailure: (error) => ({ _tag: "FailedTotal" as const, reason: error._tag }),
      onDefect: () => ({ _tag: "FailedTotal" as const, reason: "defect" }),
    });

  it.live("watches absent state as None and preserves the cursor", () =>
    watched(target).stream.pipe(
      Stream.take(1),
      Stream.runCollect,
      Effect.tap((messages) =>
        Effect.sync(() =>
          expect(messages).toEqual([
            { _tag: "ReceivedTotal", snapshot: { state: Option.none(), cursor: 0 } },
          ]),
        ),
      ),
      Effect.asVoid,
      Effect.provide(Client),
    ),
  );

  it.live("watches a fresh state and cursor after a write", () =>
    Effect.gen(function* () {
      const result = yield* run(
        Counter.Increment.make({ input: { counterId: target, amount: 2 }, commandId: "page:0" })
          .effect,
      );
      const client = yield* CounterApi.Client;
      yield* client.Total.snapshot(target, { atLeast: result.receipt });
      const messages = yield* watched(target).stream.pipe(Stream.take(1), Stream.runCollect);
      expect(messages).toEqual([
        { _tag: "ReceivedTotal", snapshot: { state: Option.some({ total: 2 }), cursor: 1 } },
      ]);
    }).pipe(Effect.provide(Client)),
  );

  it("keys a watch by its read key, so the runtime restarts it only for a new key", () => {
    expect(watched(target).key).toBe(watched(target).key);
    expect(watched(target).key).not.toBe(watched(CounterId.make("two")).key);
  });

  it("restarts a watch for a new restart key, as after a new sign-in", () => {
    expect(watched(target, 0).key).toBe(watched(target, 0).key);
    expect(watched(target, 0).key).not.toBe(watched(target, 1).key);
  });

  const feed = (after: Option.Option<number>, restartKey?: number) =>
    Counter.Total.events(target, {
      after,
      restartKey,
      onEntry: (entry) => `entry:${entry.envelope.seq}:${entry.envelope.commandId}`,
      onCaughtUp: (cursor) => `caught:${cursor}`,
      onFailure: (error) => `failed:${error._tag}`,
      onDefect: () => "defect",
    });

  it("keeps the event feed across cursor changes and restarts it for a restart key", () => {
    expect(feed(Option.none()).key).toBe(feed(Option.some(5)).key);
    expect(feed(Option.none(), 0).key).not.toBe(feed(Option.none(), 1).key);
  });

  it.live("resumes after the given cursor and preserves source command ids", () =>
    Effect.gen(function* () {
      const client = yield* CounterApi.Client;
      const receipt = yield* client.Increment(
        { counterId: target, amount: 2 },
        { commandId: "page:0" },
      );
      yield* client.Increment({ counterId: target, amount: 3 }, { commandId: "page:1" });
      yield* client.Total.snapshot(target, { atLeast: { stream: receipt.stream, version: 2 } });
      const messages = yield* feed(Option.some(1)).stream.pipe(Stream.take(2), Stream.runCollect);
      expect(messages).toEqual(["entry:2:page:1", "caught:2"]);
    }).pipe(Effect.provide(Client)),
  );

  it.live("drops duplicate entries while allowing gaps in filtered feeds", () =>
    Effect.gen(function* () {
      const client = yield* CounterApi.Client;
      const receipt = yield* client.Increment(
        { counterId: target, amount: 2 },
        { commandId: "page:0" },
      );
      yield* client.Total.snapshot(target, { atLeast: receipt });
      const frames = yield* client.Total.events(target).pipe(Stream.take(2), Stream.runCollect);
      const entries = frames.filter(Domain.Read.isEvent);
      const replay = entries.flatMap((entry) => [
        entry,
        entry,
        { ...entry, envelope: { ...entry.envelope, seq: 5 } },
      ]);
      const source = Layer.succeed(CounterApi.Client, {
        ...client,
        Total: { ...client.Total, events: () => Stream.fromIterable(replay) },
      });
      const messages = yield* feed(Option.none()).stream.pipe(
        Stream.runCollect,
        Effect.provide(source),
      );
      expect(messages).toEqual(["entry:1:page:0", "entry:5:page:0"]);
    }).pipe(Effect.provide(Client)),
  );

  it.live("turns watch and event defects into Messages and preserves interruption", () =>
    Effect.gen(function* () {
      const client = yield* CounterApi.Client;
      const dies = Layer.succeed(CounterApi.Client, {
        ...client,
        Total: {
          ...client.Total,
          watch: () => Stream.die("socket closed"),
          events: () => Stream.die("socket closed"),
        },
      });
      expect(yield* watched(target).stream.pipe(Stream.runCollect, Effect.provide(dies))).toEqual([
        { _tag: "FailedTotal", reason: "defect" },
      ]);
      expect(
        yield* feed(Option.none()).stream.pipe(Stream.runCollect, Effect.provide(dies)),
      ).toEqual(["defect"]);
      const interrupts = Layer.succeed(CounterApi.Client, {
        ...client,
        Total: { ...client.Total, watch: () => Stream.fromEffect(Effect.interrupt) },
      });
      const exit = yield* watched(target).stream.pipe(
        Stream.runCollect,
        Effect.provide(interrupts),
        Effect.exit,
      );
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
    }).pipe(Effect.provide(Client)),
  );

  it.live("turns a mid-stream validate refusal into an app Message", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const watch = yield* watched(target).stream.pipe(
        Stream.tap(() => Deferred.succeed(started, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* run(
        Counter.Increment.make({ input: { counterId: target, amount: 6 }, commandId: "page:0" })
          .effect,
      );
      expect(yield* Fiber.join(watch)).toEqual([
        { _tag: "ReceivedTotal", snapshot: { state: Option.none(), cursor: 0 } },
        { _tag: "FailedTotal", reason: "Limit" },
      ]);
      expect(yield* feed(Option.none()).stream.pipe(Stream.runCollect)).toEqual(["failed:Limit"]);
    }).pipe(Effect.scoped, Effect.provide(Client)),
  );

  it.live("preserves interruption in watch and event feeds", () =>
    Effect.gen(function* () {
      const client = yield* CounterApi.Client;
      const source = Layer.succeed(CounterApi.Client, {
        ...client,
        Total: {
          ...client.Total,
          watch: (...args: Parameters<typeof client.Total.watch>) =>
            client.Total.watch(...args).pipe(
              Stream.take(1),
              Stream.concat(Stream.fromEffect(Effect.interrupt)),
            ),
          events: (...args: Parameters<typeof client.Total.events>) =>
            client.Total.events(...args).pipe(
              Stream.take(1),
              Stream.concat(Stream.fromEffect(Effect.interrupt)),
            ),
        },
      });
      const reads = [
        watched(target).stream.pipe(Stream.runDrain),
        feed(Option.none()).stream.pipe(Stream.runDrain),
      ];
      for (const read of reads) {
        const exit = yield* read.pipe(Effect.provide(source), Effect.exit);
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      }
    }).pipe(Effect.provide(Client)),
  );

  it.live("watches Stream absence and reports CaughtUp", () =>
    Effect.gen(function* () {
      const snapshots = yield* Counter.Outputs.watch(target, {
        onSnapshot: (snapshot) => snapshot,
        onFailure: () => ({ state: Option.none(), cursor: -1 }),
        onDefect: () => ({ state: Option.none(), cursor: -1 }),
      }).stream.pipe(Stream.take(1), Stream.runCollect);
      expect(snapshots).toEqual([{ state: Option.none(), cursor: 0 }]);
      const events = yield* Counter.Outputs.events(target, {
        after: Option.none(),
        onEntry: (entry) => entry.event.amount,
        onCaughtUp: (cursor) => cursor,
        onFailure: () => -1,
        onDefect: () => -1,
      }).stream.pipe(Stream.take(1), Stream.runCollect);
      expect(events).toEqual([0]);
    }).pipe(Effect.provide(Client)),
  );

  it("reserves layer for the services' implementation", () => {
    // A model already refuses a command, aggregate or view named `layer`; a query is not refused.
    class LayerQuery extends Domain.Query("layer", { input: {}, success: Schema.Number }) {}
    class Collision extends Domain.Model("EffectUICollision", {
      aggregates: [CounterAggregate],
      queries: [LayerQuery],
    }) {}
    class CollisionApi extends Domain.Api("EffectUICollisionApi", {
      model: Collision,
      commands: ["Increment"],
      views: [],
      streams: [],
      queries: ["layer"],
    }) {}
    // @ts-expect-error layer is reserved for the services' implementation
    const collision = DomainEffectUI.make(CollisionApi);
    expect(Layer.isLayer(collision.layer)).toBe(true);
  });

  // A whole component: a click runs the Api command, the View watch shows the new total.
  const PanelMessage = UiSchema.TaggedEnum({
    ClickedAdd: {},
    ReceivedTotal: { total: Schema.Number },
    SucceededAdd: { version: Schema.Number },
    FailedAdd: { reason: Schema.String },
  });
  const Panel = Html.component({
    name: "CounterPanel",
    model: Schema.Struct({
      total: Schema.Number,
      // A View snapshot fits in a Model: the server render seeds it, hydration adopts it.
      seed: Schema.optional(Counter.Total.SnapshotSchema),
      error: Schema.optional(Schema.String),
    }),
    message: PanelMessage,
  }).make({
    init: () => ({ total: 0 }),
    update: {
      // No ids in the Model: the Command makes one.
      ClickedAdd: ($) =>
        $.run(
          Counter.Increment.make({ input: { counterId: target, amount: 2 } }).pipe(
            Command.match({
              onSuccess: ({ receipt }) => PanelMessage.SucceededAdd({ version: receipt.version }),
              onFailure: (failure) => PanelMessage.FailedAdd({ reason: failure._tag }),
            }),
          ),
        ),
      ReceivedTotal: ($, { total }) => $.evolve({ total }),
      SucceededAdd: ($) => $.model,
      FailedAdd: ($, { reason }) => $.evolve({ error: reason }),
    },
    subscriptions: () => [
      Counter.Total.watch<typeof PanelMessage.Type>(target, {
        onSnapshot: ({ state }) =>
          PanelMessage.ReceivedTotal({
            total: Option.match(state, { onNone: () => 0, onSome: ({ total }) => total }),
          }),
        onFailure: (error) => PanelMessage.FailedAdd({ reason: error._tag }),
        onDefect: () => PanelMessage.FailedAdd({ reason: "defect" }),
      }),
    ],
    view: (h, model) =>
      h.div.children(
        h.p.attr("aria-label", "Total").children(String(model.total)),
        h.button.on("click", PanelMessage.ClickedAdd()).children("Add 2"),
      ),
  });

  // The client is built inside the tree: `TestHost.settle` drains only the tree's fibers, so a
  // client provided beside `TestHost` leaves the View stale under the TestClock.
  it.effect("runs a command from a component and shows the watched View", () =>
    Effect.gen(function* () {
      const play = yield* HtmlPlay.make(
        Panel.pipe(Component.provide(Counter.layer.pipe(Layer.provideMerge(Client)))),
        {},
      );
      yield* play.expect(HtmlLocator.label("Total")).toHaveText("0");
      yield* play.click(HtmlLocator.role("button", { name: "Add 2" }));
      yield* play.expect(HtmlLocator.label("Total")).toHaveText("2");
    }).pipe(Effect.scoped, Effect.provide(TestHost.layer())),
  );

  // A server render: each request's fetch reads that request in CommandHeaders.
  it.live("reads the request's cookie in CommandHeaders during a server render", () =>
    Effect.gen(function* () {
      const client = yield* QueryApi.Client;
      const sent: Array<unknown> = [];
      const spy = Layer.succeed(QueryApi.Client, {
        ...client,
        Count: (...args: Parameters<typeof client.Count>) => {
          sent.push(args[1]?.headers);
          return client.Count(...args);
        },
      });
      const RequestHeaders = Layer.succeed(DomainEffectUI.CommandHeaders, {
        get: () =>
          Effect.serviceOption(HttpServerRequest.HttpServerRequest).pipe(
            Effect.map(
              Option.match({
                onNone: () => ({}),
                onSome: (request) => ({ cookie: request.headers.cookie ?? "" }),
              }),
            ),
          ),
      });
      const PageRoute = Route.union({ Home: Route.make("/"), NotFound: Route.make("/*") });
      const Page = Html.component({
        name: "CountPage",
        props: Schema.Struct({ route: PageRoute }),
        model: Schema.Struct({}),
        message: Schema.Never,
        queries: {
          count: { query: Queries.Count, args: () => ({ input: { counterId: target } }) },
        },
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) =>
          h.p.children(
            AsyncResult.isSuccess(h.queries.count)
              ? `count:${h.queries.count.value}`
              : h.queries.count._tag,
          ),
      });
      const Pages = layerHttp(Page, {
        routes: PageRoute,
        budget: "2 seconds",
        document: (page) => page.html,
      }).pipe(
        Layer.provide(
          Layer.merge(
            Queries.layer.pipe(Layer.provide(Layer.merge(spy, RequestHeaders))),
            Query.layer(),
          ),
        ),
      );
      const { dispose, handler } = HttpRouter.toWebHandler(Pages, { disableLogger: true });
      const bodies: Array<string> = [];
      for (const who of ["alice", "bob"]) {
        const response = yield* Effect.promise(() =>
          handler(new Request("http://localhost/", { headers: { cookie: `session=${who}` } })),
        );
        bodies.push(yield* Effect.promise(() => response.text()));
      }
      yield* Effect.promise(() => dispose());
      // Each request has its own cache, so bob's render fetches again with his own cookie.
      expect(sent).toEqual([{ cookie: "session=alice" }, { cookie: "session=bob" }]);
      expect(bodies.map((body) => body.includes("count:3"))).toEqual([true, true]);
    }).pipe(Effect.provide(QueryClient)),
  );

  // A View as a stream query: a component declares it in `queries` and reads `h.queries`.
  const totalText = (
    result: AsyncResult.AsyncResult<DomainEffectUI.Snapshot<{ total: number }>, any>,
  ) =>
    Option.match(AsyncResult.value(result), {
      onNone: () => result._tag,
      onSome: ({ state, cursor }) =>
        `${Option.match(state, { onNone: () => 0, onSome: ({ total }) => total })}@${cursor}`,
    });
  // What `HtmlHydrate` does to the cache, without a DOM: `Query.internals` is `@internal`, so
  // its type is not published.
  const cacheInternals = (
    Query as unknown as {
      readonly internals: (cache: Query.Cache["Service"]) => {
        readonly hydrate: (raw: unknown) => void;
        readonly closeWindow: () => void;
      };
    }
  ).internals;
  const failureText = (cause: Cause.Cause<DomainEffectUI.ViewFailure<typeof Total>>) =>
    Option.match(Cause.findErrorOption(cause), {
      onNone: () => "defect",
      onSome: (failure) =>
        failure._tag === "Rejected" ? `Rejected:${failure.rejection.amount}` : failure._tag,
    });
  const TotalView = Html.component({
    name: "TotalView",
    model: Schema.Struct({}),
    message: Schema.Never,
    queries: { total: { query: Counter.Total, args: () => ({ key: target }) } },
  }).make({
    init: () => ({}),
    update: ($) => $.model,
    view: (h) => h.p.attr("aria-label", "Total").children(totalText(h.queries.total)),
  });

  it.live("renders a View's stream entry on the server, and the client hydrates it", () =>
    Effect.gen(function* () {
      const client = yield* CounterApi.Client;
      const receipt = yield* client.Increment({ counterId: target, amount: 2 });
      yield* client.Total.snapshot(target, { atLeast: receipt });
      let opened = 0;
      let watched = 0;
      const counted = Layer.succeed(CounterApi.Client, {
        ...client,
        Total: {
          ...client.Total,
          snapshot: (...args: Parameters<typeof client.Total.snapshot>) => {
            opened++;
            return client.Total.snapshot(...args);
          },
          watch: (...args: Parameters<typeof client.Total.watch>) => {
            watched++;
            return client.Total.watch(...args);
          },
        },
      });
      const rendered = yield* HtmlServer.renderToHtml(
        TotalView.pipe(Component.provide(Counter.layer.pipe(Layer.provide(counted)))),
        {},
      );
      expect(rendered.html).toContain(">2@1<");
      // The server stored the first element and closed the stream.
      const shipped = JSON.parse(HtmlServer.serializeState(rendered.state))["~query"];
      expect(Object.keys(shipped)).toEqual(["CounterApi/Total"]);
      expect([opened, watched]).toEqual([1, 0]);
      // The browser adopts the entry: no stream opens in the fetch-free window.
      const seen: Array<string> = [];
      yield* Effect.gen(function* () {
        const cache = cacheInternals(yield* Query.Cache);
        cache.hydrate(shipped);
        yield* Counter.Total.changes({ key: target }).pipe(
          Stream.runForEach((result) =>
            Effect.sync(() => seen.push(totalText(result) + (result.waiting ? "~" : ""))),
          ),
          Effect.forkScoped,
        );
        yield* Effect.sleep("20 millis");
        expect([seen, opened]).toEqual([["2@1"], 1]);
        // Once the window closes the stream opens, and a later write arrives live.
        cache.closeWindow();
        yield* client.Increment({ counterId: target, amount: 3 });
        while (seen.at(-1) !== "5@2") yield* Effect.sleep("5 millis");
      }).pipe(
        Effect.timeout("2 seconds"),
        Effect.scoped,
        Effect.provide(Layer.merge(Counter.layer, Query.layer()).pipe(Layer.provide(counted))),
      );
      expect(opened).toBe(2);
      // The new stream's first element ends `waiting`; then the write.
      expect(seen).toEqual(["2@1", "2@1~", "2@1", "5@2"]);
    }).pipe(Effect.provide(Client)),
  );

  it.live("fails a View's stream entry with a typed rejection, and opens it again", () =>
    Effect.gen(function* () {
      const client = yield* CounterApi.Client;
      const results: Array<string> = [];
      const layer = Layer.merge(Counter.layer, Query.layer()).pipe(
        Layer.provide(Layer.succeed(CounterApi.Client, client)),
      );
      yield* Effect.gen(function* () {
        yield* Counter.Total.changes({ key: target }).pipe(
          Stream.runForEach((result) =>
            Effect.sync(() =>
              results.push(
                (AsyncResult.isFailure(result)
                  ? `failed:${failureText(result.cause)}`
                  : totalText(result)) + (result.waiting ? "~" : ""),
              ),
            ),
          ),
          Effect.forkScoped,
        );
        const settle = (expected: string) =>
          Effect.gen(function* () {
            while (results.at(-1) !== expected) yield* Effect.sleep("5 millis");
          }).pipe(Effect.timeout("2 seconds"));
        yield* settle("0@0");
        // Over 5, the View's `validate` refuses the read: the stream ends with the rejection.
        yield* client.Increment({ counterId: target, amount: 6 });
        yield* settle("failed:Rejected:6");
        // Back under the limit, the entry opens again only when asked: as after a new sign-in.
        yield* client.Increment({ counterId: target, amount: -6 });
        // A read is judged before it waits for `atLeast`, so wait for the View to apply it first.
        yield* client.Total.get(target, { atLeast: [] }).pipe(
          Effect.retry({ schedule: Schedule.spaced("5 millis"), times: 100 }),
        );
        yield* Counter.Total.invalidate({ key: target });
        yield* settle("0@2");
      }).pipe(Effect.scoped, Effect.provide(layer));
      // `invalidate` keeps the failure, waiting, until the new stream's first element.
      expect(results).toEqual(["0@0", "failed:Rejected:6", "failed:Rejected:6~", "0@2"]);
    }).pipe(Effect.provide(Client)),
  );

  // A command's optimistic patch on the stream entry, recorded as each result arrives.
  const Optimistic = DomainEffectUI.make(CounterApi, {
    commands: {
      Increment: {
        optimistic: ({ input }, queries) => [
          queries.Total.patch({ key: input.counterId }, (snapshot) => ({
            ...snapshot,
            state: Option.some({
              total:
                Option.match(snapshot.state, { onNone: () => 0, onSome: ({ total }) => total }) +
                input.amount,
            }),
          })),
        ],
      },
    },
  });
  const LiveMessage = UiSchema.TaggedEnum({
    ClickedAdd: {},
    Saw: { total: Schema.String },
    Done: {},
  });
  const LivePanel = Html.component({
    name: "LivePanel",
    model: Schema.Struct({ seen: Schema.Array(Schema.String) }),
    message: LiveMessage,
    queries: {
      total: {
        query: Optimistic.Total,
        args: () => ({ key: target }),
        onChange: (result) => LiveMessage.Saw({ total: totalText(result) }),
      },
    },
  }).make({
    init: () => ({ seen: [] }),
    update: {
      ClickedAdd: ($) =>
        $.run(
          Optimistic.Increment.make({ input: { counterId: target, amount: 2 } }).pipe(
            Command.match({
              onSuccess: () => LiveMessage.Done(),
              onFailure: () => LiveMessage.Done(),
            }),
          ),
        ),
      Saw: ($, { total }) =>
        $.model.seen.at(-1) === total ? $.model : $.evolve({ seen: [...$.model.seen, total] }),
      Done: ($) => $.model,
    },
    view: (h, model) =>
      h.div.children(
        h.p.attr("aria-label", "Total").children(totalText(h.queries.total)),
        h.p.attr("aria-label", "Seen").children(model.seen.join(" ")),
        h.button.on("click", LiveMessage.ClickedAdd()).children("Add 2"),
      ),
  });

  it.effect("shows a command's write in the View's stream entry, with no step back", () =>
    Effect.gen(function* () {
      // A View that lags: a snapshot that names no receipt still shows the state before them.
      const lagging = Layer.effect(
        CounterApi.Client,
        Effect.map(CounterApi.Client, (client) => ({
          ...client,
          Total: {
            ...client.Total,
            snapshot: (...args: Parameters<typeof client.Total.snapshot>) =>
              args[1]?.atLeast === undefined
                ? Effect.succeed({ state: null, cursor: 0 })
                : client.Total.snapshot(...args),
          },
        })),
      ).pipe(Layer.provide(Client));
      const play = yield* HtmlPlay.make(
        LivePanel.pipe(Component.provide(Optimistic.layer.pipe(Layer.provideMerge(lagging)))),
        {},
      );
      yield* play.expect(HtmlLocator.label("Total")).toHaveText("0@0");
      yield* play.click(HtmlLocator.role("button", { name: "Add 2" }));
      yield* play.expect(HtmlLocator.label("Total")).toHaveText("2@1");
      // The patch shows 2 at the old cursor. The run's end reopens the stream, and its first
      // element waits for the run's receipt, so the total never steps back to 0.
      yield* play.expect(HtmlLocator.label("Seen")).toHaveText("0@0 2@0 2@1");
    }).pipe(Effect.scoped, Effect.provide(TestHost.layer())),
  );

  it("types Commands, queries and reads from the Api", () => {
    // @ts-expect-error command input keys preserve their brand
    Counter.Increment.make({ input: { counterId: "one", amount: 1 }, commandId: "x" });
    // A command id is optional.
    Counter.Increment.make({ input: { counterId: target, amount: 1 } });
    // @ts-expect-error a query input keeps its brand
    Queries.Count.get({ input: { counterId: "one" } });
    // @ts-expect-error a receipt is not part of a query's args, so not of its cache key
    Queries.Count.get({ input: { counterId: target }, atLeast: { stream: "s", version: 1 } });
    // @ts-expect-error a paged query's args have no cursor
    Mixed.Rows.get({ input: { counterId: target }, after: "2" });
    const sub: Subscription.Subscription<number, typeof CounterApi.Client.Identifier> =
      Counter.Total.watch(target, {
        onSnapshot: ({ cursor }) => cursor,
        onFailure: () => -1,
        onDefect: () => -1,
      });
    expect(sub.name).toBe("CounterApi/Total/watch");
    // A View is a stream query keyed by its read key, which keeps its brand.
    Counter.Total.get({ key: target });
    // @ts-expect-error a View key keeps its brand
    Counter.Total.get({ key: "one" });
    const failure: Effect.Effect<
      DomainEffectUI.Snapshot<{ total: number }>,
      DomainEffectUI.ViewFailure<typeof Total>,
      any
    > = Counter.Total.get({ key: target });
    expect(Effect.isEffect(failure)).toBe(true);
    // A Command's and a query's failure Schemas decode with no services, so a component's
    // Message or Model can hold them.
    const Panel = Html.component({
      name: "FailurePanel",
      model: Schema.Struct({ failure: Schema.NullOr(Counter.Increment.error) }),
      message: UiSchema.TaggedEnum({
        FailedAdd: { failure: Counter.Increment.error },
        FailedCount: { failure: Queries.Count.error },
        FailedTotal: { failure: Counter.Total.error },
      }),
    });
    expect(Panel).toBeDefined();
  });
});
