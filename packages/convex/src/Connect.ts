import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Deployment } from "./Deployment.ts";

/** A deployment's URLs. Resolving them makes no request. */
export interface ConnectClient {
  /** The URL clients connect to, such as `https://happy-otter-123.convex.cloud`. */
  url: Effect.Effect<string, never, RuntimeContext>;
  /** The URL that serves HTTP actions. */
  siteUrl: Effect.Effect<string, never, RuntimeContext>;
}

/**
 * Give a Worker, Lambda or other host a deployment's URLs, for the `convex`
 * client. No credentials are involved: public functions need none.
 *
 * ### Connecting
 * **Example:** Call a query with the `convex` client from a Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const convex = yield* Convex.Connect(Backend);
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const client = new ConvexHttpClient(yield* convex.url);
 *       const rows = yield* Effect.tryPromise(() => client.query(api.messages.list, {}));
 *       return yield* HttpServerResponse.json(rows);
 *     }),
 *   };
 * }).pipe(Effect.provide(Convex.ConnectHttp));
 * ```
 *
 * @binding
 * @product Functions
 */
export interface Connect extends Binding.Service<
  Connect,
  "Convex.Connect",
  (deployment: Deployment) => Effect.Effect<ConnectClient>
> {}

export const Connect = Binding.Service<Connect>("Convex.Connect");

/** Host-independent implementation: the URLs are bound as environment values. */
export const ConnectHttp = Layer.effect(
  Connect,
  Effect.succeed(
    Effect.fn(function* (deployment: Deployment) {
      return {
        url: yield* deployment.url,
        siteUrl: yield* deployment.siteUrl,
      } satisfies ConnectClient;
    }),
  ),
);
