/// <reference types="@types/node" />

import alchemy from "alchemy";
import { Worker } from "alchemy/cloudflare";

const app = await alchemy("my-alchemy-app");

export const worker = await Worker("worker", {
  name: "my-alchemy-app",
  entrypoint: "src/worker.ts",
});

console.log(worker.url);

await app.finalize();
