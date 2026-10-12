import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import type * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import type * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { HttpEffect } from "../Http.ts";
import type * as Aggregate from "./Aggregate.ts";
import type * as Command from "./Command.ts";
import * as Domain from "./Domain.ts";
import { captureContext } from "./internal.ts";
import type * as Operation from "./Operation.ts";

/** What an Api exposes: commands (writes), queries and subscriptions (reads). */
export type Entry = Command.Any | Operation.Any;

type RpcsOf<Entries extends ReadonlyArray<Entry>> = Entries[number]["rpc"];

/** Queries and subscriptions need a handler Layer; commands are implemented by their aggregate. */
type Handlers<E extends Entry> = E extends Operation.Any ? Operation.Identifier<E> : never;

/** Shown when an Api-wide middleware provides services. */
type ProvidesOnEntries =
  "Middleware that provides services must be attached to each command or operation with `.middleware(...)`";

/**
 * The class type returned by {@link make}.
 */
export interface ApiClass<Entries extends ReadonlyArray<Entry>, Rpcs extends Rpc.Any> {
  new (_: never): {};
  readonly kind: "Api";
  /** The commands, queries and subscriptions this Api exposes. */
  readonly entries: Entries;
  /** The underlying Effect RPC group. */
  readonly group: RpcGroup.RpcGroup<Rpcs>;
  /**
   * Apply an `RpcMiddleware` to every entry (logging, rate limits).
   * Middleware that provides services, such as a session, is attached to each
   * command or operation instead, so what they may use stays typed.
   */
  middleware<M extends RpcMiddleware.AnyService>(
    middleware: [RpcMiddleware.Provides<M["Identifier"]>] extends [never] ? M : ProvidesOnEntries,
  ): ApiClass<Entries, Rpc.AddMiddleware<Rpcs, M>>;
  /**
   * Serve the Api over HTTP (Effect RPC, NDJSON), returning an `HttpEffect`
   * to use as a Worker's `fetch`. Requires the Domain (commands are sent to
   * its aggregates), every query and subscription handler, and every
   * middleware's Layer.
   */
  readonly httpEffect: Effect.Effect<
    HttpEffect,
    never,
    Domain.Internals | Handlers<Entries[number]> | Rpc.Middleware<Rpcs> | Rpc.ServicesServer<Rpcs>
  >;
  /** A typed client. Provide a protocol with {@link protocolHttp}. */
  readonly client: Effect.Effect<
    RpcClient.RpcClient<Rpcs>,
    never,
    Scope.Scope | RpcClient.Protocol | Rpc.MiddlewareClient<Rpcs>
  >;
  /**
   * An in-process client wired straight to the handlers, for tests. Server
   * middleware runs, so principals are provided by swapping middleware Layers.
   */
  readonly testClient: Effect.Effect<
    RpcClient.RpcClient<Rpcs>,
    never,
    | Scope.Scope
    | Domain.Internals
    | Handlers<Entries[number]>
    | Rpc.Middleware<Rpcs>
    | Rpc.MiddlewareClient<Rpcs>
  >;
}

/**
 * Only an entry's declared errors are public. Anything else a handler fails
 * with (an infrastructure error, an undeclared rejection) becomes a defect,
 * so it never leaks as a typed error the client cannot decode.
 */
const declaredOnly = (entry: Entry) => {
  const rpc = entry.rpc as Rpc.AnyWithProps;
  const isDeclared = Schema.is(rpc.errorSchema);
  const success = rpc.successSchema as Schema.Top & { readonly error?: Schema.Top };
  const isDeclaredInStream = success.error ? Schema.is(success.error) : isDeclared;
  return {
    effect: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.catchIf(
        effect,
        (e) => !isDeclared(e),
        (e) => Effect.die(e),
      ),
    stream: <A, E, R>(stream: Stream.Stream<A, E, R>) =>
      Stream.catchIf(
        stream,
        (e) => !isDeclaredInStream(e),
        (e) => Stream.die(e),
      ),
  };
};

/** The wire payload of a command: its target, an optional command id, and its input. */
interface CommandPayload {
  readonly target: string;
  readonly commandId?: string;
  readonly [field: string]: unknown;
}

/**
 * The endpoint of an exposed command. It runs inside the command's
 * middleware, so the context the middleware provides (the session's actor)
 * travels with the command to its aggregate.
 */
const commandHandler =
  (command: Command.Any, aggregate: Aggregate.ClientImpl) =>
  ({ target, commandId, ...input }: CommandPayload) =>
    aggregate.send(target, new command(input), { commandId }).pipe(
      Effect.map((receipt) => ({
        reply: receipt.reply,
        stream: receipt.stream,
        version: receipt.version,
      })),
    );

type Handler = (input: never) => unknown;

const handlersOf = (entries: ReadonlyArray<Entry>): Effect.Effect<Record<string, Handler>> =>
  Effect.gen(function* () {
    const internals = yield* Domain.Internals;
    const handlers: Record<string, Handler> = {};
    for (const entry of entries) {
      const declared = declaredOnly(entry);
      if (entry.kind === "Command") {
        const aggregate = internals.commands.get(entry.tag);
        if (!aggregate) {
          return yield* Effect.die(new Error(`No aggregate in the Domain handles ${entry.tag}`));
        }
        const handle = commandHandler(entry, aggregate);
        handlers[entry.tag] = (input: CommandPayload) => declared.effect(handle(input));
        continue;
      }
      const handler = yield* entry as unknown as Context.Key<never, Operation.HandlerImpl>;
      handlers[entry.rpc._tag] =
        entry.kind === "Subscription"
          ? (input: unknown) =>
              declared.stream(
                Stream.unwrap(
                  handler(input) as Effect.Effect<Stream.Stream<unknown, unknown>, unknown>,
                ),
              )
          : (input: unknown) => declared.effect(handler(input));
    }
    return handlers;
  }) as Effect.Effect<Record<string, Handler>>;

// A class so `class CustomerApi extends Api.make(...) {}` works.
const build = (entries: ReadonlyArray<Entry>, group: RpcGroup.RpcGroup<Rpc.Any>): unknown =>
  Object.assign(class {}, {
    kind: "Api" as const,
    entries,
    group,
    middleware: (middleware: RpcMiddleware.AnyService) =>
      build(entries, group.middleware(middleware) as unknown as RpcGroup.RpcGroup<Rpc.Any>),
    httpEffect: Effect.gen(function* () {
      const handlers = yield* handlersOf(entries);
      // The middleware services (declared in `httpEffect`'s requirements), for every request.
      const middleware = yield* captureContext();
      const layer = Layer.mergeAll(
        group.toLayer(handlers as never),
        RpcSerialization.layerNdjson,
        Layer.succeedContext(middleware),
      );
      // One server per request: Workers forbid sharing I/O objects across requests.
      return RpcServer.toHttpEffect(group).pipe(
        Effect.flatten,
        Effect.provide(layer),
      ) as unknown as HttpEffect;
    }),
    client: RpcClient.make(group),
    testClient: Effect.gen(function* () {
      const handlers = yield* handlersOf(entries);
      return yield* RpcTest.makeClient(group).pipe(
        Effect.provide(group.toLayer(handlers as never)),
      );
    }),
  });

/**
 * Declare an Api: the public surface of a Domain for one audience. Commands
 * are writes, sent to their aggregate after their middleware runs; queries
 * and subscriptions are reads, implemented with `toLayer`. Only the listed
 * entries are reachable.
 *
 * The Api is built from contracts only, so it is safe to import in a
 * browser; the server provides the Domain and the read handlers.
 *
 * **Example:** Declaring and serving an Api
 * ```typescript
 * export class CustomerApi extends Api.make(WithdrawMoney, StatementHistory, AccountWatch) {}
 *
 * export default class BankWorker extends Cloudflare.Worker<BankWorker>()(
 *   "BankWorker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const api = yield* CustomerApi.httpEffect;
 *     return { fetch: api };
 *   }).pipe(Effect.provide(BankLive)),
 * ) {}
 * ```
 */
export const make = <const Entries extends ReadonlyArray<Entry>>(
  ...entries: Entries
): ApiClass<Entries, RpcsOf<Entries>> =>
  build(
    entries,
    RpcGroup.make(...entries.map((entry) => entry.rpc)) as unknown as RpcGroup.RpcGroup<Rpc.Any>,
  ) as ApiClass<Entries, RpcsOf<Entries>>;

/**
 * The HTTP protocol for an Api client (NDJSON, to stream subscriptions).
 * Requires an `HttpClient`, e.g. `FetchHttpClient.layer`.
 */
export const protocolHttp = (
  url: string,
): Layer.Layer<RpcClient.Protocol, never, HttpClient.HttpClient> =>
  RpcClient.layerProtocolHttp({ url }).pipe(Layer.provide(RpcSerialization.layerNdjson));
