import * as Sandbox from "@alchemy.run/sandbox";

/** A bundled program in a sandbox, scheduled by its Durable Object (so it can be snapshotted). */
export class ProgramBox extends Sandbox.Sandbox<ProgramBox, { size: "small" | "large" }>()(
  "ProgramBox",
) {}
