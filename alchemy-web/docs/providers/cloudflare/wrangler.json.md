# WranglerJson

The WranglerJson resource generates a [wrangler.json configuration file](https://developers.cloudflare.com/workers/wrangler/configuration/) for a Cloudflare Worker.

# Minimal Example

Create a basic wrangler.json file for a Worker:

```ts
import { Worker, WranglerJson } from "alchemy/cloudflare";

const worker = await Worker("api", {
  name: "api-worker",
  entrypoint: "./src/api.ts"
});

await WranglerJson("config", {
  worker
});
```

# With Custom Path

Specify a custom path for the wrangler.json file:

```ts
await WranglerJson("config", {
  worker,
  path: "./config/wrangler.json"
});
```

# With Worker Bindings

Generate wrangler.json with Worker bindings configuration:

```ts
const kv = await KVNamespace("data", {
  title: "data-store"
});

const worker = await Worker("api", {
  name: "api-worker", 
  entrypoint: "./src/api.ts",
  bindings: {
    DATA: kv
  }
});

await WranglerJson("config", {
  worker
});
```