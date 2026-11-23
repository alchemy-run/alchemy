import * as AI from "@alchemy.run/ai";
import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
import * as Layer from "effect/Layer";

/** For work that needs care. */
export class Smart extends AI.Model<Smart>()("smart") {}
/** For looking things up. */
export class Fast extends AI.Model<Fast>()("fast") {}

/** Both on Workers AI, through the Worker's own `AI` binding. */
export const ModelsLive = Layer.mergeAll(
  AICloudflare.Model(Smart, {
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    parameters: { temperature: 0, maxTokens: 2048 },
  }),
  AICloudflare.Model(Fast, {
    model: "@cf/meta/llama-3.1-8b-instruct-fast",
    parameters: { temperature: 0, maxTokens: 1024 },
  }),
);
