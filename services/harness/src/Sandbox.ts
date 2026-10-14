import * as AI from "alchemy/AI";
import * as Anthropic from "alchemy/Anthropic";
import * as GitHub from "alchemy/GitHub";

/**
 * The machine Claude Code runs in. Declared bare (no host, no program) so
 * the Durable Object that yields it stays small; Sandbox.runtime.ts hosts it.
 * It accepts the model and GitHub egresses (`git` and `gh` are installed).
 */
export class Sandbox extends AI.Sandbox<
  Sandbox,
  { size: "large"; egress: Anthropic.Egress | GitHub.Egress }
>()("Sandbox", { egress: [Anthropic.Egress, GitHub.Egress] }) {}

/** Where each session's checkout of Alchemy lives. */
export const WORKSPACE = "/workspace/alchemy";
