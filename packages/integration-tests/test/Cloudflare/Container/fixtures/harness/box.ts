import * as Anthropic from "@alchemy.run/anthropic";
import * as Sandbox from "@alchemy.run/sandbox";

/** A sandbox serving Claude Code, kept working across restarts by its Durable Object. */
export class HarnessBox extends Sandbox.Sandbox<
  HarnessBox,
  { size: "standard"; egress: Anthropic.Egress }
>()("HarnessBox", { egress: [Anthropic.Egress] }) {}
