import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type { DurableObject } from "../Workers/DurableObject.ts";

/**
 * Options accepted by {@link warmPool}.
 */
export interface WarmPoolOptions {
  /**
   * The Durable Object names to warm on this pass. Alchemy has no way to
   * know which DOs you expect traffic for — this is your own prediction,
   * recent-activity list, or fixed roster. Pass a plain iterable when the
   * list is already in hand, or an `Effect` to resolve it fresh on every
   * pass (a KV read, a query, …).
   */
  names: Iterable<string> | Effect.Effect<Iterable<string>>;
  /**
   * Maximum number of DOs woken concurrently.
   * @default 10
   */
  concurrency?: number;
}

/**
 * Proactively wake a set of Durable Objects by name — one pass per call —
 * so their containers start booting before the first real request arrives,
 * instead of paying a cold start on that request's critical path.
 *
 * Cloudflare binds a container 1:1 to the Durable Object that owns it, so
 * there is no platform concept of an anonymous, pre-warmed spare that could
 * be handed to a *different* DO. `warmPool` doesn't try to invent one —
 * it simply fires a lightweight `fetch` at each named DO's stub and waits
 * for the fan-out to finish. Waking a DO this way is enough on its own: any
 * inbound call forces the DO to construct if it isn't already resident in
 * memory, which is exactly where `Cloudflare.Containers.layer(...)`'s
 * existing eager start fires as a side effect. `warmPool` only needs to
 * know how to wake a DO by name; it doesn't need to know anything about the
 * container inside it.
 *
 * `warmPool` does **one pass and returns** — it has no schedule of its own.
 * Call it from a recurring trigger (a Cron Trigger is the natural fit; its
 * once-a-minute floor is plenty for pre-boot warming) rather than wrapping
 * it in your own `Effect.repeat`: a self-repeating `warmPool` combined with
 * a handler that's invoked repeatedly by its own trigger would fork one
 * forever-running fan-out loop *per invocation*, piling up duplicate loops
 * in any isolate that survives across fires.
 *
 * This complements {@link ContainerLayerOptions.keepWarm} rather than
 * replacing it: `warmPool` gets a DO (and its container) booting *before*
 * anyone has ever touched it; `keepWarm` keeps that same container warm
 * for the rest of the DO's life once it has.
 *
 * @example Warm the last few active agents every minute from a Cron Trigger
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export default Cloudflare.Worker(
 *   "PoolWorker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const agents = yield* Agent;
 *
 *     yield* Cloudflare.Workers.cron("* * * * *", () =>
 *       Cloudflare.Containers.warmPool(agents, {
 *         names: recentlyActiveAgentIds(), // your own prediction/heuristic
 *         concurrency: 10,
 *       }),
 *     );
 *
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("ok")),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.Workers.CronEventSourceLive)),
 * );
 * ```
 */
export const warmPool = <Shape>(
  namespace: DurableObject<Shape>,
  options: WarmPoolOptions,
) =>
  Effect.gen(function* () {
    const names = Effect.isEffect(options.names)
      ? yield* options.names
      : options.names;
    yield* Effect.forEach(
      names,
      (name) =>
        namespace
          .getByName(name)
          .fetch(
            HttpServerRequest.fromClientRequest(
              HttpClientRequest.get("http://warm-pool-ping"),
            ),
          )
          .pipe(Effect.ignore),
      { concurrency: options.concurrency ?? 10 },
    );
  });
