import { $, alchemize } from "alchemy";
import {
  Bucket,
  DurableObjectNamespace,
  KVNamespace,
  StaticSite,
  Worker,
} from "alchemy/cloudflare";

import "dotenv/config";

const counter = new DurableObjectNamespace("COUNTER", {
  className: "Counter",
  sqlite: true,
});

const authStore = new KVNamespace("AUTH_STORE", {
  title: "alchemy-example-auth-store",
});

// Create an R2 bucket
const storage = new Bucket("storage", {
  name: "alchemy-example-storage",
  allowPublicAccess: false,
});

export const api = new Worker("api", {
  name: "alchemy-example-vite-api",
  entrypoint: "./src/index.ts",
  bindings: {
    COUNTER: counter,
    STORAGE: storage, // Bind the R2 bucket to the worker
    AUTH_STORE: authStore,
  },
});

const website = new StaticSite("Website", {
  name: "alchemy-example-vite",
  dir: "./dist",
  build: {
    command: "bun run build",
  },
  routes: {
    "/api/*": api,
  },
});

$(console).log({
  url: website.url,
});

await alchemize({
  mode: process.argv.includes("--destroy") ? "destroy" : "up",
  quiet: process.argv.includes("--verbose") ? false : true,
});
