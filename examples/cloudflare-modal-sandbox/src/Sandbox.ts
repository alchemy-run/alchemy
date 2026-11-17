// src/Sandbox.ts
import * as Modal from "@alchemy.run/modal";

/** Everything the app creates lives in this environment. */
export const MyEnv = Modal.Environment("MyEnv", {});

/** Sandboxes run in an app. */
export const Coder = Modal.App("Coder", { environment: MyEnv });

/** The image: Node 22 with git. */
export const Node = Modal.Image("Node", {
  app: Coder,
  image: "node:22-bookworm",
  commands: ["RUN apt-get update && apt-get install -y git"],
});

/** The warm image every sandbox starts from: the repository cloned and pnpm installed, saved as an image at deploy. */
export const Warm = Modal.Image("Warm", {
  app: Coder,
  from: Node,
  run: ["git clone --depth 1 https://github.com/sindresorhus/is /work", "npm install -g pnpm"],
});
