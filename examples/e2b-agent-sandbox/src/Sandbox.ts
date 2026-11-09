// src/Sandbox.ts
import * as Dockerfile from "@alchemy.run/docker/Dockerfile";
import * as E2B from "@alchemy.run/e2b";

/** The image: Node 22 with git and pnpm, built by E2B at deploy. */
export const MyTemplate = E2B.Template("MyTemplate", {
  dockerfile: Dockerfile.inline`
    FROM node:22-bookworm
    RUN apt-get update && apt-get install -y git
    RUN npm install -g pnpm
  `,
  cpuCount: 2,
  memoryMB: 2048,
});

/** The snapshot every sandbox starts from: the repository cloned into the image, snapshotted at deploy. */
export const Warm = E2B.Snapshot("Warm", {
  template: MyTemplate,
  run: ["git clone --depth 1 https://github.com/sindresorhus/is repo"],
});
