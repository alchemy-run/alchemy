import * as AI from "@alchemy.run/ai";
import * as Anthropic from "@alchemy.run/anthropic";
import * as GitHub from "@alchemy.run/github";

/**
 * The machine Claude Code runs in. Declared bare (no host, no program) so
 * the Durable Object that yields it stays small; Sandbox.cf.ts (Cloudflare)
 * or Sandbox.aws.ts (AWS) hosts it.
 * It accepts the model and GitHub egresses (`git` and `gh` are installed).
 */
export class Sandbox extends AI.Sandbox<
  Sandbox,
  { size: "large"; egress: Anthropic.Egress | GitHub.Egress }
>()("Sandbox", { egress: [Anthropic.Egress, GitHub.Egress] }) {}

/** Where each session's checkout of Alchemy lives. */
export const WORKSPACE = "/workspace/alchemy";
