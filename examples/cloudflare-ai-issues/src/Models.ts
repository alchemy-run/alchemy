import * as AI from "@alchemy.run/ai";
import * as AICloudflare from "@alchemy.run/ai/Cloudflare";

/** The model sessions run on. Which LLM answers is the Layer behind it. */
export class Smart extends AI.Model<Smart>()("smart") {}

/** Llama 3.3 70B on Workers AI, through the Worker's own `AI` binding. */
export const SmartLlama = AICloudflare.Model(Smart, {
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  parameters: { temperature: 0, maxTokens: 2048 },
});
