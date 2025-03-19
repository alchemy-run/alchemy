import { $, alchemize } from "alchemy";
import { DurableObjectNamespace, StaticSite, Worker } from "alchemy/cloudflare";

import "dotenv/config";

const counter = new DurableObjectNamespace("COUNTER", {
  className: "Counter",
  sqlite: true,
});

const api = new Worker("api", {
  name: "alchemy-example-vite-api",
  entrypoint: "./src/index.ts",
  bindings: {
    COUNTER: counter,
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
