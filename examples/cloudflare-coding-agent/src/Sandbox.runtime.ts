import * as AI from "alchemy/AI";
import * as Anthropic from "alchemy/Anthropic";
import { Dockerfile } from "alchemy/Docker";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import { Sandbox } from "./Sandbox.ts";

/**
 * The program a session's container runs: Claude Code in a checkout of
 * Alchemy. It holds no credentials — the Durable Object that owns the
 * container adds them to its requests (see Agent.ts).
 */
export default Sandbox.make(
  {
    main: import.meta.url,
    runtime: "node",
    // The toolchain the repository needs (it pins Node 24, pnpm and Bun).
    dockerfile: Dockerfile.inline`
      FROM node:24-bookworm
      RUN corepack enable && npm install -g bun@1.3.13
    `,
    // Scheduled by its Durable Object, which snapshots and restores it.
    schedulingPolicy: "durable_object",
  },
  Effect.gen(function* () {
    // Alchemy itself, ready to work in. The repository is prepared once per
    // commit on the deploying machine (checkout + submodule, install,
    // TypeScript build); the image reinstalls dependencies for Linux.
    const repo = yield* GitHub.MountRepository("alchemy-run/alchemy", {
      path: "/workspace/alchemy",
      ref: "main",
      depth: 50,
      submodules: ["submodules/distilled"],
      install: "pnpm install --frozen-lockfile",
      build: "pnpm exec tsc -b",
      access: "write",
      // git authenticates through the Durable Object's GitHub egress.
      egress: true,
    });
    const claude = yield* Anthropic.ClaudeCodeServer("Claude", {
      model: "claude-haiku-4-5-20251001",
      // Stream the model's thinking (shown in the UI as reasoning).
      thinking: { type: "enabled", budgetTokens: 4000 },
      cwd: repo.path,
    });
    return { fetch: yield* AI.serveHarnessHttp(claude) };
  }),
);
