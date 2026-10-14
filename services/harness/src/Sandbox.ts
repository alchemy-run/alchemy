import * as AI from "alchemy/AI";

/**
 * The machine Claude Code runs in. Declared bare (no host, no program) so
 * the Durable Object that yields it stays small; Sandbox.runtime.ts hosts it.
 */
export class Sandbox extends AI.Sandbox<Sandbox, { size: "large" }>()("Sandbox") {}

/** Where each session's checkout of Alchemy lives. */
export const WORKSPACE = "/workspace/alchemy";
