import "alchemy/cloudflare";

import alchemy from "alchemy";
import { Assets, Worker } from "alchemy/cloudflare";
import { Exec } from "alchemy/os";

const app = await alchemy("tanstack-app");

await Exec("build", {
  command: "bun run build",
});

const assets = await Assets("assets", {
  path: ".output/public",
});

const worker = await Worker("tanstack-website", {
  name: "tanstack-website",
  entrypoint: ".output/server/index.mjs",
  bindings: {
    ASSETS: assets,
  },
  url: true,
  compatibilityFlags: ["nodejs_compat"],
});

console.log({
  url: worker.url,
});

await app.finalize();
