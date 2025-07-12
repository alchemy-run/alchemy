/// <reference types="@types/node" />

import alchemy from "alchemy";
import { Container, Worker } from "alchemy/cloudflare";
import { SQLiteStateStore } from "alchemy/sqlite";
import type { MyContainer } from "./src/worker.ts";

const app = await alchemy("cloudflare-container", {
  stateStore: (scope) => new SQLiteStateStore(scope),
});

const container = await Container<MyContainer>("container", {
  name: `${app.name}-container-${app.stage}`,
  className: "MyContainer",
  adopt: true,
  build: {
    context: import.meta.dirname,
    dockerfile: "Dockerfile",
  },
});

export const worker = await Worker("test-worker", {
  name: `${app.name}-worker-${app.stage}`,
  entrypoint: "src/worker.ts",
  adopt: true,
  bindings: {
    MY_CONTAINER: container,
  },
});

console.log(worker.url);

await app.finalize();
