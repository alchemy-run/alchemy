import * as Anthropic from "alchemy/Anthropic";
import { WORKSPACE } from "./Sandbox.ts";

/**
 * The toolchain the repository needs (it pins Node 24, pnpm and Bun), for
 * every host's image. The checkout itself is prepared at runtime (see
 * Agent.ts).
 */
export const TOOLCHAIN = `
FROM node:24-bookworm
RUN corepack enable && npm install -g bun@1.3.13
RUN mkdir -p ${WORKSPACE}
`;

/**
 * The program a session's machine runs, whichever host runs it
 * (Sandbox.cf.ts, Sandbox.aws.ts): Claude Code, working in a checkout of
 * Alchemy. It holds no credentials — the egress gateway adds them to its
 * requests.
 */
export const ClaudeProgram = Anthropic.ClaudeCodeServer("Claude", {
  model: "claude-haiku-4-5-20251001",
  // Stream the model's thinking (shown in the UI as reasoning).
  thinking: { type: "enabled", budgetTokens: 4000 },
  cwd: WORKSPACE,
});
