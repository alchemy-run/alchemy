import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as AI from "@/AI/index.ts";
import * as Anthropic from "@/Anthropic/index.ts";
import { AgentSandbox } from "./sandbox.ts";

/**
 * Claude Code inside a Cloudflare Container: the harness server installs the
 * Agent SDK into the image and serves `AI.HarnessRpcs` on the container port.
 */
export default AgentSandbox.make(
  {
    main: import.meta.url,
    runtime: "node",
    environment: AI.Environment({
      base: "node:22-bookworm-slim",
      workdir: "/workspace",
      setup: "RUN mkdir -p /workspace",
    }),
    instanceType: "standard-1",
  },
  Effect.gen(function* () {
    const claude = yield* Anthropic.ClaudeCodeServer("Claude", {
      apiKey: yield* Config.Redacted("ANTHROPIC_API_KEY"),
      model: "claude-haiku-4-5-20251001",
    });
    return { fetch: yield* AI.serveHarnessHttp(claude) };
  }),
);
