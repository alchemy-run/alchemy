import * as AI from "@alchemy.run/ai";
import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Layer from "effect/Layer";

/** The model the bot runs on. Which LLM answers is the Layer behind it. */
export class Fast extends AI.Model<Fast>()("fast") {}

/** Llama 3.3 70B on Workers AI, through the Worker's own `AI` binding. */
export const FastLive = AICloudflare.Model(Fast, {
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  parameters: { temperature: 0, maxTokens: 1024 },
});
