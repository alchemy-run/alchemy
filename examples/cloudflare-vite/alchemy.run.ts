/// <reference types="node" />

import alchemy from "alchemy";
import {
  Assets,
  KVNamespace,
  R2Bucket,
  Worker,
  WranglerJson,
} from "alchemy/cloudflare";
import { Exec } from "alchemy/os";

const app = await alchemy("cloudflare-vite", {
  stage: process.env.USER ?? "dev",
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
  quiet: process.argv.includes("--verbose") ? false : true,
  password: process.env.ALCHEMY_PASSWORD,
});

export const [authStore, storage] = await Promise.all([
  KVNamespace("AUTH_STORE", {
    title: "alchemy-example-auth-store",
  }),
  R2Bucket("storage", {
    name: "alchemy-example-storage",
    allowPublicAccess: false,
  }),
]);

// export const counter = new DurableObjectNamespace("COUNTER", {
//   className: "Counter",
//   sqlite: true,
// });

await Exec("build", {
  command: "bun run build",
});

const staticAssets = await Assets("static-assets", {
  path: "./dist",
});

export const website = await Worker("worker", {
  name: "alchemy-example-vite-api",
  entrypoint: "./src/index.ts",
  url: true,
  adopt: true,
  bindings: {
    ASSETS: staticAssets,
    // COUNTER: counter,
    STORAGE: storage,
    AUTH_STORE: authStore,
    GITHUB_CLIENT_ID: alchemy.secret(process.env.GITHUB_CLIENT_ID),
    GITHUB_CLIENT_SECRET: alchemy.secret(process.env.GITHUB_CLIENT_SECRET),
  },
});

await WranglerJson("wrangler.json", {
  worker: website,
});

console.log({
  url: website.url,
});

await app.finalize();
