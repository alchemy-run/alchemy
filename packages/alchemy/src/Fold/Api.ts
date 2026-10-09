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
import { captureContext } from "./internal.ts";
import type * as Operation from "./Operation.ts";

type RpcsOf<Ops extends ReadonlyArray<Operation.Any>> = Ops[number]["rpc"];

/** Shown when an Api-wide middleware provides services. */
type ProvidesOnOperations =
  "Middleware that provides services must be attached to each operation with `.middleware(...)`";

/**
 * The class type returned by {@link make}.
 */
export interface ApiClass<Ops extends ReadonlyArray<Operation.Any>, Rpcs extends Rpc.Any> {
  new (_: never): {};
  readonly kind: "Api";
  /** The operations this Api exposes. */
  readonly operations: Ops;
  /** The underlying Effect RPC group. */
  readonly group: RpcGroup.RpcGroup<Rpcs>;
  /**
   * Apply an `RpcMiddleware` to every operation (logging, rate limits).
   * Middleware that provides services to handlers, such as a session, is
   * attached to each operation instead, so handlers' requirements stay typed.
   */
  middleware<M extends RpcMiddleware.AnyService>(
    middleware: [RpcMiddleware.Provides<M["Identifier"]>] extends [never]
      ? M
      : ProvidesOnOperations,
  ): ApiClass<Ops, Rpc.AddMiddleware<Rpcs, M>>;
  /**
   * Serve the Api over HTTP (Effect RPC, NDJSON), returning an `HttpEffect`
   * to use as a Worker's `fetch`. Requires every operation's Layer and every
   * middleware's Layer.
   */
  readonly httpEffect: Effect.Effect<
    HttpEffect,
    never,
    Operation.Identifier<Ops[number]> | Rpc.Middleware<Rpcs> | Rpc.ServicesServer<Rpcs>
  >;
  /** A typed client. Provide a protocol with {@link protocolHttp}. */
  readonly client: Effect.Effect<
    RpcClient.RpcClient<Rpcs>,
    never,
    Scope.Scope | RpcClient.Protocol | Rpc.MiddlewareClient<Rpcs>
  >;
  /**
   * An in-process client wired straight to the operations' handlers, for
   * tests. Server middleware runs, so principals are provided by swapping
   * middleware Layers.
   */
  readonly testClient: Effect.Effect<
    RpcClient.RpcClient<Rpcs>,
    never,
    | Scope.Scope
    | Operation.Identifier<Ops[number]>
    | Rpc.Middleware<Rpcs>
    | Rpc.MiddlewareClient<Rpcs>
  >;
}

/**
 * Only an operation's declared errors are public. Anything else a handler
 * fails with (an infrastructure error, an undeclared rejection) becomes a
 * defect, so it never leaks as a typed error the client cannot decode.
 */
const declaredOnly = (operation: Operation.Any) => {
  const rpc = operation.rpc as Rpc.AnyWithProps;
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

type Handlers = Record<string, (input: unknown) => unknown>;

const handlersOf = (operations: ReadonlyArray<Operation.Any>): Effect.Effect<Handlers> =>
  Effect.gen(function* () {
    const handlers: Handlers = {};
    for (const operation of operations) {
      const handler = yield* operation as unknown as Context.Key<never, Operation.HandlerImpl>;
      const declared = declaredOnly(operation);
      handlers[operation.rpc._tag] =
        operation.kind === "Subscription"
          ? (input) =>
              declared.stream(
                Stream.unwrap(
                  handler(input) as Effect.Effect<Stream.Stream<unknown, unknown>, unknown>,
                ),
              )
          : (input) => declared.effect(handler(input));
    }
    return handlers;
  }) as Effect.Effect<Handlers>;

// A class so `class CustomerApi extends Api.make(...) {}` works.
const build = (
  operations: ReadonlyArray<Operation.Any>,
  group: RpcGroup.RpcGroup<Rpc.Any>,
): unknown =>
  Object.assign(class {}, {
    kind: "Api" as const,
    operations,
    group,
    middleware: (middleware: RpcMiddleware.AnyService) =>
      build(operations, group.middleware(middleware) as unknown as RpcGroup.RpcGroup<Rpc.Any>),
    httpEffect: Effect.gen(function* () {
      const handlers = yield* handlersOf(operations);
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
      const handlers = yield* handlersOf(operations);
      return yield* RpcTest.makeClient(group).pipe(
        Effect.provide(group.toLayer(handlers as never)),
      );
    }),
  });

/**
 * Declare an Api: the public surface of a Domain for one audience. Only the
 * listed operations are reachable, and middleware (authentication, the
 * principal, MFA) applies to every one of them.
 *
 * The Api is built from contracts only, so it is safe to import in a
 * browser; the server provides each operation's Layer.
 *
 * **Example:** Declaring and serving an Api
 * ```typescript
 * export class CustomerApi extends Api.make(RegisterCustomer, WithdrawFunds, AccountWatch)
 *   .middleware(CustomerSession) {}
 *
 * // Worker init
 * const fetch = yield* CustomerApi.httpEffect;
 *
 * // browser
 * const client = yield* CustomerApi.client;
 * yield* client.withdraw({ accountId, amount: 30 });
 * ```
 */
export const make = <const Ops extends ReadonlyArray<Operation.Any>>(
  ...operations: Ops
): ApiClass<Ops, RpcsOf<Ops>> =>
  build(
    operations,
    RpcGroup.make(
      ...operations.map((operation) => operation.rpc),
    ) as unknown as RpcGroup.RpcGroup<Rpc.Any>,
  ) as ApiClass<Ops, RpcsOf<Ops>>;

/**
 * The HTTP protocol for an Api client (NDJSON, to stream subscriptions).
 * Requires an `HttpClient`, e.g. `FetchHttpClient.layer`.
 */
export const protocolHttp = (
  url: string,
): Layer.Layer<RpcClient.Protocol, never, HttpClient.HttpClient> =>
  RpcClient.layerProtocolHttp({ url }).pipe(Layer.provide(RpcSerialization.layerNdjson));
