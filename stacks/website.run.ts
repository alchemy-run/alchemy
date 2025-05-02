// ensure providers are registered (for deletion purposes)

import "../alchemy/src/cloudflare";
import "../alchemy/src/dns";
import "../alchemy/src/os";

import path from "node:path";
import alchemy from "../alchemy/src";
import { Assets, CustomDomain, Worker, Zone } from "../alchemy/src/cloudflare";
import { Exec } from "../alchemy/src/os";
import options from "./env.js";

const app = await alchemy("alchemy:website", options);

const zone = await Zone("alchemy.run", {
  name: "alchemy.run",
  type: "full",
});

await Exec("build-site", {
  command: "bun run --filter alchemy-web docs:build",
});

const staticAssets = await Assets("static-assets", {
  path: path.join("alchemy-web", ".vitepress", "dist"),
});

export const website = await Worker("website", {
  name: "alchemy-website",
  url: true,
  bindings: {
    ASSETS: staticAssets,
  },
  assets: {
    html_handling: "auto-trailing-slash",
    // not_found_handling: "single-page-application",
    run_worker_first: false,
  },
  script: `
export default {
  async fetch(request, env) {
    // return env.ASSETS.fetch(request);
    return new Response("Not Found", { status: 404 });
  },
};
`,
});

await CustomDomain("alchemy-web-domain", {
  name: "alchemy.run",
  zoneId: zone.id,
  workerName: website.name,
});

await app.finalize();
