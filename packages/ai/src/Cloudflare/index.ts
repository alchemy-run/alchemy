/**
 * `AI.Model` Layers on Cloudflare: Workers AI, direct or through an AI Gateway.
 *
 * @module
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ModelClass } from "../Model.ts";

/** Which Workers AI model answers, and with what parameters. */
export type ModelOptions = Parameters<Cloudflare.Workers.AIClient["model"]>[0];

/**
 * Back a model with Workers AI, through the Worker's own AI binding. It
 * needs nothing beyond your Cloudflare account.
 *
 * **Example:** Llama 3.3 on Workers AI
 * ```typescript
 * import * as AI from "@alchemy.run/ai";
 * import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
 *
 * export class Fast extends AI.Model<Fast>()("fast") {}
 *
 * export const FastLive = AICloudflare.WorkersAI(Fast, {
 *   model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
 * });
 * ```
 *
 * @layer
 * @provides AI.Model
 * @peer @alchemy.run/cloudflare
 */
export const WorkersAI = <Self>(model: ModelClass<Self, string>, options: ModelOptions) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const ai = yield* Cloudflare.Workers.AI();
      return model.layer(ai.model(options));
    }),
  ).pipe(Layer.provide(Cloudflare.Workers.AIBinding));

/**
 * Back a model with a Workers AI model reached through an AI Gateway, which
 * logs, caches and rate-limits each request.
 *
 * **Example:** Llama 3.3 through a gateway
 * ```typescript
 * import * as AI from "@alchemy.run/ai";
 * import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 *
 * export const Gateway = Cloudflare.AI.Gateway("Gateway", { collectLogs: true });
 *
 * export class Fast extends AI.Model<Fast>()("fast") {}
 *
 * export const FastLive = AICloudflare.Gateway(Fast, Gateway, {
 *   model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
 * });
 * ```
 *
 * @layer
 * @provides AI.Model
 * @peer @alchemy.run/cloudflare
 */
export const Gateway = <Self, E, R>(
  model: ModelClass<Self, string>,
  gateway: Effect.Effect<Cloudflare.AI.Gateway, E, R>,
  options: ModelOptions,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const client = yield* Cloudflare.AI.QueryGateway(yield* gateway);
      return model.layer(client.model(options));
    }),
  ).pipe(Layer.provide(Cloudflare.AI.QueryGatewayBinding));
