import * as AI from "@alchemy.run/ai";
import * as Anthropic from "@alchemy.run/anthropic";

/** A sandbox serving Claude Code, kept working across restarts by its Durable Object. */
export class HarnessBox extends AI.Sandbox<
  HarnessBox,
  { size: "standard"; egress: Anthropic.Egress }
>()("HarnessBox", { egress: [Anthropic.Egress] }) {}
