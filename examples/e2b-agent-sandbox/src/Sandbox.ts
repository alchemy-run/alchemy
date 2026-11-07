// src/Sandbox.ts
import * as Dockerfile from "@alchemy.run/docker/Dockerfile";
import * as E2B from "@alchemy.run/e2b";

/** Every sandbox boots from this image: Node 22 with git and ripgrep. */
export const Agent = E2B.Template("Agent", {
  dockerfile: Dockerfile.inline`
    FROM node:22-bookworm
    RUN apt-get update && apt-get install -y git ripgrep
  `,
  cpuCount: 2,
  memoryMB: 2048,
});
