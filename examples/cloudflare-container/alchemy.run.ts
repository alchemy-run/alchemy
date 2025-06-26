/// <reference types="@types/node" />

import alchemy from "alchemy";
import { Container, Worker } from "alchemy/cloudflare";
import type { MyContainer } from "./src/worker.ts";

const app = await alchemy("cloudflare-container");

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
    MY_CONTAINER: container,
  },
});

console.log(worker.url);

await app.finalize();
