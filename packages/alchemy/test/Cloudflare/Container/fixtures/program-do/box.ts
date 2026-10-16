import * as AI from "@/AI/index.ts";

/** A bundled program in a sandbox, scheduled by its Durable Object (so it can be snapshotted). */
export class ProgramBox extends AI.Sandbox<ProgramBox, { size: "small" | "large" }>()(
  "ProgramBox",
) {}
