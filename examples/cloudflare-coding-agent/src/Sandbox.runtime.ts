import * as AI from "alchemy/AI";
import * as Anthropic from "alchemy/Anthropic";
import { Dockerfile } from "alchemy/Docker";
import * as Effect from "effect/Effect";
import { Sandbox, WORKSPACE } from "./Sandbox.ts";

/**
 * The program a session's container runs: Claude Code, working in a checkout
 * of Alchemy. The image only holds the toolchain; the checkout is prepared
 * at runtime (see Agent.ts). It holds no credentials — the Durable Object
 * that owns the container adds them to its requests.
 */
export default Sandbox.make(
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
    schedulingPolicy: "durable_object",
  },
  Effect.gen(function* () {
    const claude = yield* Anthropic.ClaudeCodeServer("Claude", {
      model: "claude-haiku-4-5-20251001",
      // Stream the model's thinking (shown in the UI as reasoning).
      thinking: { type: "enabled", budgetTokens: 4000 },
      cwd: WORKSPACE,
    });
    return { fetch: yield* AI.serveHarnessHttp(claude) };
  }),
);
