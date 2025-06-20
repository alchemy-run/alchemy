/// <reference types="@types/node" />

import alchemy from "alchemy";
import { KVNamespace, Worker } from "alchemy/cloudflare";

const app = await alchemy("cloudflare-worker-simple", { mode: "watch" });

const kv = await KVNamespace("my-kv", { adopt: true, local: true });

export const worker = await Worker("worker", {
  name: "cloudflare-worker-simple",
  entrypoint: "src/worker.ts",
  bindings: {
    KV: kv,
  },
  compatibilityFlags: ["nodejs_compat"],
  local: true,
});

console.log(`worker.url: ${worker.url}`);

await app.finalize();
