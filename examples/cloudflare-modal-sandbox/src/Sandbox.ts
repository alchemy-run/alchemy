// src/Sandbox.ts
import * as Modal from "@alchemy.run/modal";

export const Agents = Modal.Environment("Agents", {});

export const Coder = Modal.App("Coder", { environment: Agents });

export const Node = Modal.Image("Node", {
  app: Coder,
  image: "node:22-bookworm",
  commands: ["RUN apt-get update && apt-get install -y git"],
});

export const Warm = Modal.Image("Warm", {
  app: Coder,
  from: Node,
  run: ["git clone --depth 1 https://github.com/sindresorhus/is /work"],
});
