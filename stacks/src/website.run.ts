// ensure providers are registered (for deletion purposes)

import "alchemy/cloudflare";
import "alchemy/dns";
import "alchemy/os";

import alchemy from "alchemy";
import { Assets, CustomDomain, Worker, Zone } from "alchemy/cloudflare";
import { Exec } from "alchemy/os";
import path from "node:path";
import options from "./env.ts";

// Support BRANCH_PREFIX for resource isolation
const branchPrefix = process.env.BRANCH_PREFIX;
const isPreview = !!branchPrefix;

const app = await alchemy("alchemy:website", options);

// Only create zone for production deployments, not for previews
let zone;
if (!isPreview) {
  zone = await Zone("alchemy.run", {
    name: "alchemy.run",
    type: "full",
  });
}

await Exec("build-site", {
  command: "bun run --filter alchemy-web docs:build",
});

const staticAssets = await Assets("static-assets", {
  path: path.join("alchemy-web", ".vitepress", "dist"),
});

export const website = await Worker("website", {
  name: branchPrefix ? `${branchPrefix}-alchemy-website` : "alchemy-website",
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

// Only set up custom domain for production deployments
if (!isPreview && zone) {
  await CustomDomain("alchemy-web-domain", {
    name: "alchemy.run",
    zoneId: zone.id,
    workerName: website.name,
  });
}

// Log the website URL for CI to extract
if (isPreview) {
  console.log(`Website preview deployed: ${website.url}`);
} else {
  console.log("Website deployed: https://alchemy.run");
}

await app.finalize();
