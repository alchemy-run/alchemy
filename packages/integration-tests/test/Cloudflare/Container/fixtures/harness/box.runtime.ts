import * as Anthropic from "@alchemy.run/anthropic";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Dockerfile } from "@alchemy.run/docker";
import { HarnessBox } from "./box.ts";

/** Claude Code in /workspace/repo. It holds no API key: the gateway adds it. */
export default Cloudflare.Containers.Sandbox(
  HarnessBox,
  {
    main: import.meta.url,
    runtime: "node",
    dockerfile: Dockerfile.inline`
      FROM node:22-bookworm-slim
      RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
      RUN mkdir -p /workspace/repo
    `,
    sizes: { standard: "standard-1" },
  },
  Anthropic.ClaudeCodeServer("Claude", {
    model: "claude-haiku-4-5-20251001",
    cwd: "/workspace/repo",
  }),
);
