// we don't use node in ./src/**, only here for alchemy to bootstrap CloudFlare
import "@types/node";

import alchemy from "alchemy";
import {
  DurableObjectNamespace,
  KVNamespace,
  R2Bucket,
  StaticSite,
  Worker,
} from "alchemy/cloudflare";

const app = alchemy("cloudflare-vite", {
  stage: process.env.USER ?? "dev",
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
  quiet: process.argv.includes("--verbose") ? false : true,
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

export const counter = new DurableObjectNamespace("COUNTER", {
  className: "Counter",
  sqlite: true,
});

export const api = await Worker("api", {
  name: "alchemy-example-vite-api",
  entrypoint: "./src/index.ts",
  bindings: {
    COUNTER: counter,
    STORAGE: storage,
    AUTH_STORE: authStore,
    GITHUB_CLIENT_ID: alchemy.secret(process.env.GITHUB_CLIENT_ID),
    GITHUB_CLIENT_SECRET: alchemy.secret(process.env.GITHUB_CLIENT_SECRET),
  },
});

export const website = await StaticSite("Website", {
  name: "alchemy-example-vite",
  dir: "./dist",
  build: {
    command: "bun run build",
  },
  routes: {
    "/api/*": api,
  },
});

console.log({
  url: website.url,
});

await app.finalize();
