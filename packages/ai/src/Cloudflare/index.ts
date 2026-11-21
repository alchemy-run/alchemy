/**
 * `AI.Model` Layers on Cloudflare.
 *
 * @module
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ModelClass } from "../Model.ts";

/** Which of Cloudflare's hosted models answers, and with what parameters. */
export type ModelOptions<E = never, R = never> = Parameters<
  Cloudflare.Workers.AIClient["model"]
>[0] & {
  /**
   * An AI Gateway to send each request through, which logs, caches and
   * rate-limits it. Without one, requests go straight to the model through
   * the Worker's AI binding.
   */
  gateway?: Effect.Effect<Cloudflare.AI.Gateway, E, R>;
};

/**
 * Back a model with one of the models Cloudflare hosts (the `@cf/...` ids).
 * It needs nothing beyond your Cloudflare account: no provider key.
 *
 * **Example:** Llama 3.3
 * ```typescript
 * import * as AI from "@alchemy.run/ai";
 * import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
 *
 * export class Fast extends AI.Model<Fast>()("fast") {}
 *
 * export const FastLive = AICloudflare.Model(Fast, {
 *   model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
 * });
 * ```
 *
 * **Example:** Through an AI Gateway
 * ```typescript
 * import * as AI from "@alchemy.run/ai";
 * import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 *
 * export const Gateway = Cloudflare.AI.Gateway("Gateway", { collectLogs: true });
 *
 * export class Fast extends AI.Model<Fast>()("fast") {}
 *
 * export const FastLive = AICloudflare.Model(Fast, {
 *   model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
 *   gateway: Gateway,
 * });
 * ```
 *
 * @layer
 * @provides AI.Model
 * @peer @alchemy.run/cloudflare
 */
export const Model = <Self, E = never, R = never>(
  model: ModelClass<Self, string>,
  { gateway, ...options }: ModelOptions<E, R>,
) =>
  gateway === undefined
    ? Layer.unwrap(
        Effect.gen(function* () {
          const ai = yield* Cloudflare.Workers.AI();
          return model.layer(ai.model(options));
        }),
      ).pipe(Layer.provide(Cloudflare.Workers.AIBinding))
    : Layer.unwrap(
        Effect.gen(function* () {
          const client = yield* Cloudflare.AI.QueryGateway(yield* gateway);
          return model.layer(client.model(options));
        }),
      ).pipe(Layer.provide(Cloudflare.AI.QueryGatewayBinding));
