import * as AI from "@alchemy.run/ai";

/** Llama 3.3 70B reliably returns OpenAI-shaped tool calls on Workers AI. */
export class Fast extends AI.Model<Fast>()("fast") {}
