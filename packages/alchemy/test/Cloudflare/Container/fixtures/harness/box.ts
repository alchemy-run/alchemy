import * as AI from "@/AI/index.ts";

/** A sandbox serving Claude Code, kept working across restarts by its Durable Object. */
export class HarnessBox extends AI.Sandbox<HarnessBox, { size: "standard" }>()("HarnessBox") {}
