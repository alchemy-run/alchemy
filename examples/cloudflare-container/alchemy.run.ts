/// <reference types="@types/node" />

import alchemy from "alchemy";
import { Container, Worker } from "alchemy/cloudflare";
import type { MyContainer } from "./src/container.ts";

const app = await alchemy("cloudflare-worker-simple");

const container = await Container<MyContainer>("test-container", {
  className: "MyContainer",
  build: {
    context: import.meta.dirname,
    dockerfile: "Dockerfile",
  },
});

export const worker = await Worker("test-worker", {
  entrypoint: "src/worker.ts",
  bindings: {
    CONTAINER: container,
  },
});

console.log(worker.url);

await app.finalize();
