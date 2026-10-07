import * as AI from "alchemy/AI";
import * as Anthropic from "alchemy/Anthropic";
import { Dockerfile } from "alchemy/Docker";
import * as GitHub from "alchemy/GitHub";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { Sandbox } from "./Sandbox.ts";

/**
 * The program a session's harness runs: in a container per session when
 * deployed (`Cloudflare.ContainerHarness`), or on this machine under
 * `alchemy dev` (`AI.LocalHarness`), with a git worktree per session.
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
    instanceType: "standard-4",
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
      token: yield* Config.Redacted("GITHUB_TOKEN"),
    });
    const claude = yield* Anthropic.ClaudeCodeServer("Claude", {
      apiKey: yield* Config.Redacted("ANTHROPIC_API_KEY"),
      model: "claude-haiku-4-5-20251001",
      cwd: repo.path,
    });
    return { fetch: yield* AI.serveHarnessHttp(claude) };
  }),
);
