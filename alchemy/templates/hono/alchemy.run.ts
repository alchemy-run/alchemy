/// <reference types="@types/node" />

import alchemy from "alchemy";
import { Worker } from "alchemy/cloudflare";

const app = await alchemy("{projectName}");

export const worker = await Worker("worker", {
  name: `${app.name}-${app.stage}`,
  entrypoint: "src/index.ts",
});

console.log(worker.url);

await app.finalize();
