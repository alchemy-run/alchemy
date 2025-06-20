/// <reference types="@types/node" />

import alchemy from "alchemy";
import { Ai, KVNamespace, Worker } from "alchemy/cloudflare";

const app = await alchemy("cloudflare-worker-simple", { watch: true });

const kv = await KVNamespace("my-kv");

export const worker = await Worker("worker", {
  name: "cloudflare-worker-simple",
  entrypoint: "src/worker.ts",
  bindings: {
    AI: new Ai(),
    KV: kv,
  },
  compatibilityFlags: ["nodejs_compat"],
  local: true,
});

console.log(`worker.url: ${worker.url}`);

await app.finalize();
