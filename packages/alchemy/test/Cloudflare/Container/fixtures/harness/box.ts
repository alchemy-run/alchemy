import * as AI from "@/AI/index.ts";
import * as Anthropic from "@/Anthropic/index.ts";

/** A sandbox serving Claude Code, kept working across restarts by its Durable Object. */
export class HarnessBox extends AI.Sandbox<
  HarnessBox,
  { size: "standard"; egress: Anthropic.Egress }
>()("HarnessBox", { egress: [Anthropic.Egress] }) {}
