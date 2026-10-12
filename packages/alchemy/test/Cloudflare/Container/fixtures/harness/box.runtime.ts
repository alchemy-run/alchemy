import * as Effect from "effect/Effect";
import * as AI from "@/AI/index.ts";
import * as Anthropic from "@/Anthropic/index.ts";
import { Dockerfile } from "@/Docker/index.ts";
import { HarnessBox } from "./box.ts";

/** Claude Code in /workspace/repo. It holds no API key: the Durable Object's egress adds it. */
export default HarnessBox.make(
  {
    main: import.meta.url,
    runtime: "node",
    dockerfile: Dockerfile.inline`
      FROM node:22-bookworm-slim
      RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
      RUN mkdir -p /workspace/repo
    `,
    schedulingPolicy: "durable_object",
  },
  Effect.gen(function* () {
    const claude = yield* Anthropic.ClaudeCodeServer("Claude", {
      model: "claude-haiku-4-5-20251001",
      cwd: "/workspace/repo",
    });
    return { fetch: yield* AI.serveHarnessHttp(claude) };
  }),
);
