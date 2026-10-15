import * as Anthropic from "alchemy/Anthropic";
import * as Cloudflare from "alchemy/Cloudflare";
import { Dockerfile } from "alchemy/Docker";
import { INSTANCE } from "./Machine.ts";
import { Sandbox, WORKSPACE } from "./Sandbox.ts";

/**
 * The program a session's container runs: Claude Code, working in a checkout
 * of Alchemy. The image only holds the toolchain; the checkout is prepared
 * at runtime (see Agent.ts). It holds no credentials — the egress gateway
 * (Gateway.aws.ts) adds them to its requests.
 */
export default Cloudflare.Containers.Sandbox(
  Sandbox,
  {
    main: import.meta.url,
    runtime: "node",
    // The toolchain the repository needs (it pins Node 24, pnpm and Bun).
    dockerfile: Dockerfile.inline`
      FROM node:24-bookworm
      RUN corepack enable && npm install -g bun@1.3.13
      RUN mkdir -p ${WORKSPACE}
    `,
    // Scheduled by its Durable Object, which snapshots and restores it.
    sizes: { large: INSTANCE },
  },
  Anthropic.ClaudeCodeServer("Claude", {
    model: "claude-haiku-4-5-20251001",
    // Stream the model's thinking (shown in the UI as reasoning).
    thinking: { type: "enabled", budgetTokens: 4000 },
    cwd: WORKSPACE,
  }),
);
