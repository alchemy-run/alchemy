/// <reference types="@types/node" />

import alchemy from "alchemy";
import { D1Database, Worker } from "alchemy/cloudflare";

const app = await alchemy("cloudflare-prisma");

const d1 = await D1Database("d1", {
  name: `${app.name}-${app.stage}-d1`,
  adopt: true,
  migrationsDir: "prisma/migrations",
});

export const worker = await Worker("worker", {
  name: `${app.name}-${app.stage}-worker`,
  entrypoint: "src/worker.ts",
  adopt: true,
  bindings: {
    D1: d1,
  },
  compatibilityFlags: ["nodejs_compat"],
});

console.log(`worker.url: ${worker.url}`);

await app.finalize();
