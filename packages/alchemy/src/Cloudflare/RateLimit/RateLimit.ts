import type * as Effect from "effect/Effect";
import { SingleShotGen } from "effect/Utils";
import * as Binding from "../../Binding.ts";
import { taggedFunction } from "../../Util/effect.ts";
import { type RateLimitClient } from "./RateLimitBinding.ts";

type RateLimitTypeId = typeof RateLimitTypeId;
const RateLimitTypeId = "Cloudflare.RateLimit" as const;

export type RateLimitPeriod = 10 | 60;

export type RateLimitProps = {
  /**
   * Binding name used when `RateLimit` is bound from inside a Worker init
   * phase (`yield* Cloudflare.RateLimit(...)`). When passed through
   * `Worker({ env: { ... } })`, the object key remains the binding name.
   *
   * @default "RATE_LIMIT"
   */
  name?: string;
  /**
   * Positive integer or string that uniquely identifies this rate limit
   * configuration.
   */
  namespaceId: number | string;
  /**
   * Simple rate limiting configuration.
   */
  simple: {
    /**
     * The number of requests allowed within the period.
     */
    limit: number;
    /**
     * The period, in seconds, over which requests are counted.
     */
    period: RateLimitPeriod;
  };
};

/**
 * The Effect yielded when a {@link RateLimitMarker} is used inside a Worker
 * init phase: it attaches the `ratelimit` binding to the surrounding Worker and
 * resolves to the runtime {@link RateLimitClient}.
 */
type BindEffect = Effect.Effect<RateLimitClient, never, RateLimit>;

/**
 * The plain data marker produced by calling {@link RateLimit}.
 *
 * It is a plain data structure (so it can be declared directly on a Worker's
 * `env`) that is **also** yieldable inside an Effect-native Worker. Yielding it
 * (`yield* Cloudflare.RateLimit(...)`) attaches the binding to the surrounding
 * Worker and returns the runtime {@link RateLimitClient} — no separate
 * `.bind(...)` step required.
 *
 * The divergence is achieved via `[Symbol.iterator]`: the object is
 * deliberately not an `Effect` (so `InferEnv` and the Worker `env` resolver
 * keep it as the native `cf.RateLimit` rather than `yield*`-ing it), but it is
 * iterable as one when `yield*`-ed.
 */
export interface RateLimitMarker {
  kind: RateLimitTypeId;
  name: string;
  namespaceId: string;
  simple: {
    limit: number;
    period: RateLimitPeriod;
  };
  asEffect(): BindEffect;
  [Symbol.iterator](): SingleShotGen<BindEffect, RateLimitClient>;
}

/**
 * The combined tag + callable form of the Rate Limit binding.
 *
 * `RateLimit` is a single identifier that is at once:
 *
 * - the Context tag (used by {@link RateLimitBinding} / `Effect.provide`),
 * - the callable that produces a {@link RateLimitMarker} (`Cloudflare.RateLimit(props)`),
 *   which can be declared directly on a Worker's `env` **or** `yield*`-ed inside
 *   an Effect-native Worker to attach the binding and return the runtime
 *   {@link RateLimitClient},
 * - and the type.
 *
 * @binding
 * @product Rate Limiting
 * @category Application Security
 */
export interface RateLimit extends Binding.Service<
  RateLimit,
  "Cloudflare.RateLimit",
  (rateLimit: RateLimitMarker) => Effect.Effect<RateLimitClient>
> {
  (props: RateLimitProps): RateLimitMarker;
}

const RateLimitTag = Binding.Service<RateLimit>("Cloudflare.RateLimit");

/**
 * `RateLimitTag` typed purely as its binding callable — `(marker) => BindEffect`
 * — so the marker's `asEffect`/iterator resolve to the binding Effect rather
 * than the ambiguous `(props) => RateLimitMarker` overload that `RateLimit` also
 * carries.
 */
const bindTag = RateLimitTag as unknown as (
  rateLimit: RateLimitMarker,
) => BindEffect;

/**
 * A Cloudflare Rate Limit binding for counting arbitrary keys inside Workers.
 *
 * Rate Limit bindings are configured directly on Workers and do not have a
 * standalone provisioning API. The Worker provider sees this object in
 * `env: { ... }` and emits the corresponding `{ type: "ratelimit" }` metadata
 * binding to the script.
 * @binding
 * @product Rate Limiting
 * @category Application Security
 * @section Declaring on a Worker's env
 * @example Async (non-Effect) Worker
 * ```typescript
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   env: {
 *     THROTTLE: Cloudflare.RateLimit({
 *       namespaceId: 1001,
 *       simple: { limit: 10, period: 60 },
 *     }),
 *   },
 * });
 *
 * export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;
 * //   { THROTTLE: RateLimit } — the native Cloudflare binding
 *
 * // worker.ts
 * export default {
 *   fetch: async (req: Request, env: WorkerEnv) => {
 *     const { success } = await env.THROTTLE.limit({ key: "ip" });
 *     return new Response(success ? "ok" : "rate limited");
 *   },
 * };
 * ```
 *
 * @section Binding inside an Effect-native Worker
 * @example yield* RateLimit does the binding
 * ```typescript
 * Cloudflare.Worker("Worker", { main: "./src/worker.ts" },
 *   Effect.gen(function* () {
 *     // Attaches the binding to this Worker AND returns the runtime client.
 *     const throttle = yield* Cloudflare.RateLimit({
 *       namespaceId: 1001,
 *       simple: { limit: 10, period: 60 },
 *     });
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { success } = yield* throttle.limit({ key: "ip" });
 *         return HttpServerResponse.text(success ? "ok" : "rate limited");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.RateLimitBinding)),
 * );
 * ```
 *
 * @see https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
 */
export const RateLimit: RateLimit = taggedFunction(
  RateLimitTag as any,
  (props: RateLimitProps): RateLimitMarker => {
    const self: RateLimitMarker = {
      kind: RateLimitTypeId,
      name: props.name ?? "RATE_LIMIT",
      namespaceId: String(props.namespaceId),
      simple: {
        limit: props.simple.limit,
        period: props.simple.period,
      },
      asEffect: () => bindTag(self),
      [Symbol.iterator]: () => new SingleShotGen(bindTag(self)),
    };
    return self;
  },
) as unknown as RateLimit;

export const isRateLimit = (value: unknown): value is RateLimitMarker =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  (value as RateLimitMarker).kind === RateLimitTypeId;
