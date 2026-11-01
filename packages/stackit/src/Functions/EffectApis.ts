import * as Effect from "effect/Effect";
import type * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { type Rpc, type RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

/**
 * Build `server` once, on the first request, in a scope that lives as long as the
 * process, and hand every request to it. Its handlers can then use bindings, whose
 * calls need `RuntimeContext`, which only exists while a request runs.
 */
const servedOnce = <E, R, RIn>(
  server: Effect.Effect<
    Effect.Effect<HttpServerResponse.HttpServerResponse, E, RIn>,
    never,
    R | Scope.Scope
  >,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, RIn | Exclude<R, Scope.Scope>> => {
  let built: Effect.Effect<HttpServerResponse.HttpServerResponse, E, RIn> | undefined;
  const lock = Semaphore.makeUnsafe(1);
  const build = lock.withPermits(1)(
    Effect.suspend(() =>
      built !== undefined
        ? Effect.succeed(built)
        : server.pipe(
            Scope.provide(Scope.makeUnsafe()),
            Effect.tap((handler) => Effect.sync(() => (built = handler))),
          ),
    ),
  );
  return Effect.flatMap(
    Effect.suspend(() => (built !== undefined ? Effect.succeed(built) : build)),
    (handler) => handler,
  );
};

/**
 * Serve an Effect RPC group as a host's `fetch`. It speaks NDJSON, so value and
 * streaming procedures both work. Use it on a host that runs as one long-lived
 * process, such as a STACKIT Function, not on a Cloudflare Worker.
 *
 * ### Serving Effect RPC
 * **Example:** A Function that serves an RpcGroup
 * ```typescript
 * export default class Api extends Stackit.Functions.Function<Api>()(
 *   "Api",
 *   { image: "registry.onstackit.cloud/my-project/api:v1.0.0" },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Stackit.Functions.ServeRpc(
 *         TaskRpcs,
 *         TaskRpcs.toLayer({
 *           getTask: ({ id }) => Effect.succeed(new Task({ id, title: "write docs" })),
 *         }),
 *       ),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * @primitive
 * @category Functions
 */
export const ServeRpc = <Rpcs extends Rpc.Any, R>(
  group: RpcGroup.RpcGroup<Rpcs>,
  handlers: Layer.Layer<Rpc.ToHandler<Rpcs>, never, R>,
) =>
  servedOnce(
    RpcServer.toHttpEffect(group).pipe(
      Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerNdjson)),
    ),
  );
