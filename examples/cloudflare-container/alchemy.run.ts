/// <reference types="@types/node" />

import alchemy from "alchemy";
import { Container, Worker } from "alchemy/cloudflare";
import { SQLiteStateStore } from "alchemy/state";
import type { MyContainer } from "./src/worker.ts";

const app = await alchemy("cloudflare-container", {
  stateStore: (scope) => new SQLiteStateStore(scope),
});

const container = await Container<MyContainer>("container", {
  className: "MyContainer",
  adopt: true,
  build: {
    context: import.meta.dirname,
    dockerfile: "Dockerfile",
  },
});

export const worker = await Worker("test-worker", {
  entrypoint: "src/worker.ts",
  adopt: true,
  bindings: {
    MY_CONTAINER: container,
  },
});

console.log(worker.url);

await app.finalize();
