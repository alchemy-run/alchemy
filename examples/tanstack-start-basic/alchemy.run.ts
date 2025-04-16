import "alchemy/cloudflare";

import { Assets, Worker } from "alchemy/cloudflare";

const assets = await Assets("assets", {
  path: ".output",
});

await Worker("website", {
  name: "website",
  script: "./src/index.ts",
  bindings: {
    ASSETS: assets,
  },
});
