# WranglerJson

The WranglerJson resource generates a `wrangler.json` configuration file for a Cloudflare Worker.

# Minimal Example

Creates a basic wrangler.json file for a Worker.

```ts
import { Worker, WranglerJson } from "alchemy/cloudflare";

const worker = await Worker("my-worker", {
  name: "my-worker",
  entrypoint: "./src/index.ts"
});

await WranglerJson("wrangler", {
  worker
});
```

# Custom Path

Specify a custom path for the wrangler.json file.

```ts
import { Worker, WranglerJson } from "alchemy/cloudflare";

const worker = await Worker("my-worker", {
  name: "my-worker", 
  entrypoint: "./src/index.ts"
});

await WranglerJson("wrangler", {
  path: "./config/wrangler.json",
  worker
});
```