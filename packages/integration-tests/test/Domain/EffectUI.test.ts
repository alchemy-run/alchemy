import * as Domain from "@alchemy.run/domain";
import * as DomainEffectUI from "@alchemy.run/domain/EffectUI";
import { describe, expect, it } from "@alchemy.run/test";
import { Command, Query, Subscription, UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { HtmlLocator, HtmlPlay } from "@effect/ui/html/testing";
import { TestHost } from "@effect/ui/testing";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcClientError from "effect/rpc/RpcClientError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  Client,
  Counter as CounterAggregate,
  CounterApi,
  CounterId,
  Limit,
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
class QueryModel extends Domain.Model("EffectUIQueries", {
  aggregates: [CounterAggregate],
  queries: [Count],
}) {}
class QueryApi extends Domain.Api("EffectUIQueryApi", {
  model: QueryModel,
  commands: [],
  views: [],
  streams: [],
  queries: ["Count"],
}) {}
const Queries = DomainEffectUI.make(QueryApi);
const QueryClient = QueryApi.layerClientInProcess.pipe(
  Layer.provide(QueryModel.layer(CountLive).pipe(Layer.provide(Domain.InMemory))),
);

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
      const uncertain = Layer.succeed(CounterApi.Client, {
        ...client,
        // The server applies the command; its reply is lost on the way back.
        Increment: (...args: Parameters<typeof client.Increment>) =>
          client.Increment(...args).pipe(
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
          ),
      });
      const headers = Layer.succeed(DomainEffectUI.CommandHeaders, {
        get: () =>
          Effect.sync(() => {
            calls += 1;
            return { "x-mfa-code": "secret" };
          }),
      });
      const command = Counter.Increment.make({
        input: { counterId: target, amount: 1 },
        commandId: "page:4",
      });
      expect(calls).toBe(0);
      const layer = Counter.layer.pipe(Layer.provide(Layer.merge(uncertain, headers)));
      const failure = yield* command.effect.pipe(Effect.scoped, Effect.provide(layer), Effect.flip);
      expect(calls).toBe(1);
      expect(failure).toEqual({ _tag: "Unknown", commandId: "page:4" });
      expect(command.args).toEqual({
        input: { counterId: target, amount: 1 },
        commandId: "page:4",
      });
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

  it("allocates ids without changing the prior state", () => {
    const ids = DomainEffectUI.CommandIds.make({ session: "page", sent: 0 });
    expect(DomainEffectUI.next(ids)).toEqual({
      commandId: "page:0",
      commandIds: { session: "page", sent: 1 },
    });
    expect(ids.sent).toBe(0);
  });

  it.live("serves a query through the Effect UI cache and keeps a typed refusal", () =>
    Effect.gen(function* () {
      expect(yield* Queries.Count.get({ input: { counterId: target } })).toBe(3);
      const refused = yield* Queries.Count.get({
        input: { counterId: CounterId.make("over") },
      }).pipe(Effect.flip);
      expect(refused).toEqual({ _tag: "Rejected", rejection: new Limit({ amount: 11 }) });
    }).pipe(
      Effect.provide(Layer.merge(Queries.layer, Query.layer()).pipe(Layer.provide(QueryClient))),
    ),
  );

  type TotalMessage =
    | {
        readonly _tag: "ReceivedTotal";
        readonly snapshot: DomainEffectUI.Snapshot<{ total: number }>;
      }
    | { readonly _tag: "FailedTotal"; readonly reason: string };
  const watched = (key: typeof CounterId.Type) =>
    Counter.Total.watch<TotalMessage>(key, {
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
      commandIds: DomainEffectUI.CommandIds,
      error: Schema.optional(Schema.String),
    }),
    message: PanelMessage,
  }).make({
    init: () => ({ total: 0, commandIds: { session: "play", sent: 0 } }),
    update: {
      ClickedAdd: ($) => {
        const { commandId, commandIds } = DomainEffectUI.next($.model.commandIds);
        return $.evolve({ commandIds }).run(
          Counter.Increment.make({ input: { counterId: target, amount: 2 }, commandId }).pipe(
            Command.match({
              onSuccess: ({ receipt }) => PanelMessage.SucceededAdd({ version: receipt.version }),
              onFailure: (failure) => PanelMessage.FailedAdd({ reason: failure._tag }),
            }),
          ),
        );
      },
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

  it.live("runs a command from a component and shows the watched View", () =>
    Effect.gen(function* () {
      const play = yield* HtmlPlay.make(Panel, {});
      yield* play.expect(HtmlLocator.label("Total")).toHaveText("0");
      yield* play.click(HtmlLocator.role("button", { name: "Add 2" }));
      yield* play.expect(HtmlLocator.label("Total")).toHaveText("2");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(TestHost.layer(), Counter.layer).pipe(Layer.provideMerge(Client)),
      ),
    ),
  );

  it("types Commands, queries and reads from the Api", () => {
    // @ts-expect-error command input keys preserve their brand
    Counter.Increment.make({ input: { counterId: "one", amount: 1 }, commandId: "x" });
    // @ts-expect-error a command needs an id
    Counter.Increment.make({ input: { counterId: target, amount: 1 } });
    // @ts-expect-error a query input keeps its brand
    Queries.Count.get({ input: { counterId: "one" } });
    const sub: Subscription.Subscription<number, typeof CounterApi.Client.Identifier> =
      Counter.Total.watch(target, {
        onSnapshot: ({ cursor }) => cursor,
        onFailure: () => -1,
        onDefect: () => -1,
      });
    expect(sub.name).toBe("CounterApi/Total/watch");
  });
});
