import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Pi from "@alchemy.run/pi";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** The model conversations run on. Which LLM answers is the Layer behind it. */
export class Fast extends Pi.Model<Fast>()("fast") {}

/** Llama 3.3 70B on Workers AI, through the Worker's own `AI` binding. */
export const FastLive = Layer.unwrap(
  Effect.gen(function* () {
    const ai = yield* Cloudflare.Workers.AI();
    return Fast.layer(
      ai.model({
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        parameters: { temperature: 0, maxTokens: 1024 },
      }),
    );
  }),
).pipe(Layer.provide(Cloudflare.Workers.AIBinding));
