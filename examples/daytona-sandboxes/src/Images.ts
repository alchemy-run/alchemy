// src/Images.ts
import * as Daytona from "@alchemy.run/daytona";

/** The image: Node 24 with git, and the size every sandbox gets. */
export const Base = Daytona.Snapshot("Base", {
  image: "node:24-bookworm",
  cpu: 1,
  memory: 1,
  disk: 3,
});

/** The warm snapshot every sandbox starts from: Base with the repository cloned, captured at deploy. */
export const Warm = Daytona.Snapshot("Warm", {
  from: Base,
  run: ["git clone --depth 1 https://github.com/sindresorhus/is /home/daytona/repo"],
});
