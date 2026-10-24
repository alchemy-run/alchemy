import * as Anthropic from "@alchemy.run/anthropic";
import { WORKSPACE } from "./Sandbox.ts";

/**
 * The toolchain the repository needs (Node, pnpm and Bun), for every host's
 * image. The checkout itself is prepared at runtime (see Agent.ts).
 *
 * The base is pinned by digest (node 26.12.0, bookworm): a moving tag would
 * rebuild every layer whenever Docker Hub republishes it. Bump it on purpose.
 */
export const TOOLCHAIN = `
FROM node:26-bookworm@sha256:a856ae5e25d498bbe5ec85fde88f00f5ed99908fda803ba39d7735ab8574f58c
# Node 25+ doesn't bundle Corepack, which runs the repository's pinned pnpm.
RUN npm install -g corepack@0.36.0 bun@1.3.13 && corepack enable
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
